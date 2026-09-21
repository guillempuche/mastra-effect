import type { ToolsInput } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { findMatchingCustomRoute, isProtectedCustomRoute } from '@mastra/server/auth';
import type { MCPHttpTransportResult, MCPSseTransportResult } from '@mastra/server/handlers/mcp';
import type { ParsedRequestParams, ServerRoute } from '@mastra/server/server-adapter';
import {
  MastraServer as MastraServerBase,
  checkRouteFGA,
  getCustomHTTPExceptionResponse,
  isZodError,
  normalizeQueryParams,
  redactStreamChunk,
  serializeStreamChunk,
} from '@mastra/server/server-adapter';
import { Effect, Layer } from 'effect';
import type { FindMyWay } from 'effect/unstable/http';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { toFetchResponse, toReqRes } from 'fetch-to-node';

export type EffectRouter = HttpRouter.HttpRouter;

/**
 * Everything the adapter threads through a single request.
 *
 * Bound to both `TRequest` and `TResponse`. Effect has no mutable response object, and the base
 * class never reads the `TResponse` argument — it only uses `sendResponse`'s return value — so the
 * slot carries the request-side data `sendResponse` needs, the same way `@mastra/elysia` carries its
 * framework context there. Passing an explicit object (rather than stashing properties on the
 * `Request`) keeps `getParams` and `sendResponse` honest when called outside `handleRoute`.
 */
export interface EffectRequestContext {
  readonly request: Request;
  readonly pathParams: Record<string, string>;
  /** Parsed once per request so nothing downstream re-reads the body. */
  readonly body: unknown;
  readonly bodyParseError?: { message: string };
}

type HasPermissionFn = (userPerms: string[], required: string) => boolean;

/** Methods that may carry a request body, per Mastra's route table. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Methods whose JSON body may carry a `requestContext` envelope. */
const CONTEXT_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** What `effect/unstable/http`'s `HttpRouter.add` accepts, besides the `*` wildcard. */
const EFFECT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUERY']);

let hasPermissionPromise: Promise<HasPermissionFn | undefined> | undefined;
function loadHasPermission(): Promise<HasPermissionFn | undefined> {
  hasPermissionPromise ??= import('@mastra/core/auth/ee')
    .then(m => m.hasPermission)
    .catch(() => {
      console.error(
        '[@guillem_puche/mastra-effect] Auth features require @mastra/core >= 1.6.0. Please upgrade: npm install @mastra/core@latest',
      );
      return undefined;
    });
  return hasPermissionPromise;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status: toHttpStatus(status), headers: { ...JSON_HEADERS, ...headers } });
}

/** `new Response` throws outside 200-599, and this runs on the last-resort error path. */
function toHttpStatus(status: unknown): number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500;
}

/**
 * Forwards a body but swallows a mid-stream error, closing instead of erroring, so chunks already
 * delivered survive an upstream failure rather than tearing down the whole response.
 */
function createSafeReadableStream(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // Preserve chunks already sent before the upstream stream errored.
      } finally {
        // Throws if the consumer already cancelled this stream, which is not an error here.
        try {
          controller.close();
        } catch {
          // Already closed or errored.
        }
        try {
          reader.releaseLock();
        } catch {
          // A read was still in flight; the cancel below owns the reader instead.
        }
      }
    },
    // Without this the client disconnecting leaves the loop above draining the upstream forever.
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}

/** `fetch-to-node` needs a body it can replay; a consumed request must be rebuilt before forwarding. */
async function createForwardRequest(request: Request, parsedBody: unknown): Promise<Request> {
  if (request.method === 'GET' || request.method === 'HEAD') return request;

  const headers = new Headers(request.headers);
  let body: string | ArrayBuffer | undefined;

  if (parsedBody !== undefined) {
    // Always re-encode: a parsed scalar string must go back out as JSON (`"ping"`), not as raw
    // bytes, or the receiving MCP server fails to parse what it is handed.
    body = JSON.stringify(parsedBody);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (!request.bodyUsed) {
    const buffer = await request.clone().arrayBuffer();
    if (buffer.byteLength > 0) body = buffer;
  }

  headers.delete('content-length');

  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** Strips hop-by-hop framing the outer fetch layer re-applies; leaving it causes double-chunking. */
function forwardResponse(source: Response): Response {
  const headers = new Headers(source.headers);
  headers.delete('Transfer-Encoding');
  return new Response(createSafeReadableStream(source.body), {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}

/** Maps a Mastra route method onto what Effect's router accepts, rather than asserting it blindly. */
function effectMethod(method: string, path: string): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | '*' {
  const upper = method.toUpperCase();
  if (upper === 'ALL') return '*';
  if (!EFFECT_METHODS.has(upper)) {
    throw new Error(
      `[@guillem_puche/mastra-effect] Unsupported HTTP method "${method}" for route ${path}. ` +
        `effect/unstable/http accepts ${[...EFFECT_METHODS].join(', ')} or ALL.`,
    );
  }
  return upper as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
}

/**
 * Mastra server adapter for Effect's HTTP layer.
 *
 * `TApp` is a live `HttpRouter` service instance rather than a Layer: Mastra's `registerRoutes()`
 * awaits ~400 sequential registrations against one fixed app, which the Layer-based
 * `HttpRouter.add` cannot express but the service's effectful `add` can.
 */
export class MastraServer extends MastraServerBase<EffectRouter, EffectRequestContext, EffectRequestContext> {
  private contextMiddleware?: (request: Request, parsedBody?: unknown) => Promise<RequestContext>;

  /**
   * Builds the per-request Mastra context. Effect has no `derive`, so routes call this directly.
   *
   * `parsedBody` lets the request path reuse the body it already parsed; omitting it (as the
   * multipart conformance suite does, fetching this middleware standalone) falls back to reading.
   */
  createContextMiddleware(): (request: Request, parsedBody?: unknown) => Promise<RequestContext> {
    this.contextMiddleware ??= async (request: Request, parsedBody?: unknown): Promise<RequestContext> => {
      let bodyRequestContext: Record<string, any> | undefined;
      let paramsRequestContext: Record<string, any> | undefined;

      const method = request.method.toUpperCase();
      if (CONTEXT_BODY_METHODS.has(method)) {
        let body = parsedBody;
        if (body === undefined && request.headers.get('content-type')?.includes('application/json')) {
          try {
            body = await request.clone().json();
          } catch {
            // Not valid JSON — the route's own body parsing reports this.
          }
        }
        if (body && typeof body === 'object' && 'requestContext' in body) {
          bodyRequestContext = (body as { requestContext?: Record<string, any> }).requestContext;
        }
      }

      if (method === 'GET') {
        const encoded = new URL(request.url).searchParams.get('requestContext');
        if (encoded) {
          try {
            paramsRequestContext = JSON.parse(encoded);
          } catch {
            try {
              paramsRequestContext = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
            } catch {
              // Neither JSON nor base64(JSON); ignore.
            }
          }
        }
      }

      const requestContext = this.mergeRequestContext({ paramsRequestContext, bodyRequestContext });
      this.applyRequestMetadataToContext({
        requestContext,
        getHeader: name => request.headers.get(name) ?? undefined,
      });
      return requestContext;
    };

    return this.contextMiddleware;
  }

  async getParams(route: ServerRoute, ctx: EffectRequestContext): Promise<ParsedRequestParams> {
    const url = new URL(ctx.request.url);
    return {
      urlParams: ctx.pathParams,
      queryParams: normalizeQueryParams(Object.fromEntries(url.searchParams)),
      body: ctx.body,
      bodyParseError: ctx.bodyParseError,
    };
  }

  /**
   * Reads and parses the body exactly once.
   *
   * `oversize` rather than a body when the limit is blown: a chunked request declares no
   * `Content-Length`, so measuring what actually arrived is the only way to enforce the cap.
   */
  private async readBody(
    route: ServerRoute,
    request: Request,
    maxSize?: number,
  ): Promise<{ body?: unknown; bodyParseError?: { message: string }; oversize?: true }> {
    if (!BODY_METHODS.has(route.method.toUpperCase())) return {};

    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      try {
        return { body: await this.parseFormData(await request.clone().formData()) };
      } catch (error) {
        this.mastra.getLogger()?.error('Failed to parse multipart form data', {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        });
        if (error instanceof Error && error.message.toLowerCase().includes('size')) return { oversize: true };
        return {
          bodyParseError: { message: error instanceof Error ? error.message : 'Failed to parse multipart form data' },
        };
      }
    }

    if (!contentType.includes('application/json')) return {};

    const text = await request.clone().text();
    if (maxSize !== undefined && new TextEncoder().encode(text).byteLength > maxSize) return { oversize: true };
    if (text.trim().length === 0) return {};

    try {
      return { body: JSON.parse(text) };
    } catch (error) {
      return { bodyParseError: { message: error instanceof Error ? error.message : 'Invalid JSON in request body' } };
    }
  }

  /** Files arrive as Node Buffers; the conformance multipart suite asserts `Buffer.isBuffer`. */
  private async parseFormData(data: FormData): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string') {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = value;
        }
      } else {
        result[key] = Buffer.from(await value.arrayBuffer());
      }
    }
    return result;
  }

  async stream(
    route: ServerRoute,
    _ctx: EffectRequestContext,
    result: { fullStream: ReadableStream },
  ): Promise<Response> {
    const streamFormat = route.streamFormat || 'stream';
    const encoder = new TextEncoder();

    const headers: Record<string, string> =
      streamFormat === 'sse'
        ? {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          }
        : { 'Content-Type': 'text/plain' };

    // `sendResponse` casts rather than checks, so a route handler that returns a bare stream instead
    // of the `{ fullStream }` shape still arrives here.
    const source = result instanceof ReadableStream ? result : result.fullStream;
    let reader: ReadableStreamDefaultReader | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: async controller => {
        reader = source.getReader();

        try {
          if (streamFormat === 'sse' && route.sseFlushOnConnect) {
            controller.enqueue(encoder.encode(': connected\n\n'));
          }

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            if (streamFormat === 'sse' && typeof value === 'string' && value.startsWith(':')) {
              controller.enqueue(encoder.encode(value));
              continue;
            }

            const outputValue = (this.streamOptions?.redact ?? true) ? redactStreamChunk(value) : value;
            const serialized = serializeStreamChunk(outputValue);
            if (!serialized.ok) {
              this.mastra.getLogger()?.error('Failed to serialize stream chunk, skipping', {
                path: route.path,
                chunkType: (outputValue as { type?: string })?.type,
                error: serialized.error.message,
              });
              continue;
            }

            controller.enqueue(
              encoder.encode(streamFormat === 'sse' ? `data: ${serialized.json}\n\n` : `${serialized.json}\x1E`),
            );
          }

          if (streamFormat === 'sse') controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          this.mastra.getLogger()?.error('Error in stream processing', {
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          });
          // Throws if the consumer already cancelled, which is not itself worth surfacing.
          try {
            controller.error(error);
          } catch {
            // Already closed or errored.
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      },
      cancel(reason) {
        return reader?.cancel(reason);
      },
    });

    return new Response(stream, { headers });
  }

  async sendResponse(
    route: ServerRoute,
    ctx: EffectRequestContext,
    result: unknown,
    prefix?: string,
  ): Promise<Response> {
    const resolvedPrefix = prefix ?? this.prefix ?? '';

    // Transparent session refresh smuggles Set-Cookie back through the result object.
    const refreshHeaders: Record<string, string> = {};
    if (result && typeof result === 'object' && '__refreshHeaders' in result) {
      Object.assign(refreshHeaders, (result as any).__refreshHeaders as Record<string, string>);
      delete (result as any).__refreshHeaders;
    }

    switch (route.responseType) {
      case 'json':
        return json(result ?? null, 200, refreshHeaders);

      case 'stream':
        return this.stream(route, ctx, result as { fullStream: ReadableStream });

      case 'datastream-response':
        return forwardResponse(result as Response);

      case 'mcp-http': {
        const { server, httpPath, mcpOptions: routeMcpOptions } = result as MCPHttpTransportResult;
        const options = { ...this.mcpOptions, ...routeMcpOptions };

        return this.bridgeMcpTransport(ctx, '[MCP HTTP] Error in background startHTTP', ({ url, req, res }) =>
          server.startHTTP({
            url,
            httpPath: `${resolvedPrefix}${httpPath}`,
            req,
            res,
            options: Object.keys(options).length > 0 ? options : undefined,
          }),
        );
      }

      case 'mcp-sse': {
        const { server, ssePath, messagePath } = result as MCPSseTransportResult;

        return this.bridgeMcpTransport(ctx, '[MCP SSE] Error in background startSSE', ({ url, req, res }) =>
          server.startSSE({
            url,
            ssePath: `${resolvedPrefix}${ssePath}`,
            messagePath: `${resolvedPrefix}${messagePath}`,
            req,
            res,
          }),
        );
      }

      default:
        return new Response(null, { status: 500 });
    }
  }

  /**
   * Runs an MCP transport against a replayable copy of the request and returns what it wrote to the
   * Node response object.
   *
   * `start` is deliberately not awaited: it resolves when the body finishes, while `toFetchResponse`
   * resolves once headers are sent. Awaiting here would stall SSE.
   */
  private async bridgeMcpTransport(
    ctx: EffectRequestContext,
    errorMessage: string,
    start: (transport: ReturnType<typeof toReqRes> & { url: URL }) => Promise<unknown>,
  ): Promise<Response> {
    const forwardRequest = await createForwardRequest(ctx.request, ctx.body);
    const { req, res } = toReqRes(forwardRequest);

    void start({ url: new URL(forwardRequest.url), req, res }).catch((error: unknown) => {
      this.mastra.getLogger()?.error(errorMessage, {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      });
    });

    return forwardResponse(await toFetchResponse(res));
  }

  /** Never rejects — the caller runs it through `Effect.promise`, whose error channel is `never`. */
  private async handleRoute(
    route: ServerRoute,
    prefix: string,
    request: Request,
    pathParams: Record<string, string>,
  ): Promise<Response> {
    try {
      const maxSize = route.maxBodySize ?? this.bodyLimitOptions?.maxSize;

      // Gate one, on headers alone, so an oversized body is rejected before it is read.
      if (this.exceedsDeclaredLimit(route, request, maxSize)) return this.bodyLimitResponse(route);

      const parsed = await this.readBody(route, request, maxSize);
      // Gate two, on what actually arrived, for requests that declared no Content-Length.
      if (parsed.oversize) return this.bodyLimitResponse(route);

      const ctx: EffectRequestContext = {
        request,
        pathParams,
        body: parsed.body,
        bodyParseError: parsed.bodyParseError,
      };

      const requestContext = await this.createContextMiddleware()(request, parsed.body);
      const url = new URL(request.url);

      const authError = await this.checkRouteAuth(route, {
        path: url.pathname,
        method: request.method,
        getHeader: name => request.headers.get(name) ?? undefined,
        getQuery: name => url.searchParams.get(name) ?? undefined,
        requestContext,
        request,
        buildAuthorizeContext: () => request,
      });

      if (authError?.error) {
        return json({ error: authError.error }, authError.status, authError.headers);
      }

      const refreshHeaders = authError?.headers ?? {};

      const permissionError = await this.resolvePermissionError(route, requestContext);
      if (permissionError) {
        return json(
          { error: permissionError.error, message: permissionError.message },
          permissionError.status,
          refreshHeaders,
        );
      }

      const params = await this.getParams(route, ctx);

      if (params.bodyParseError) {
        return json(
          { error: 'Invalid request body', issues: [{ field: 'body', message: params.bodyParseError.message }] },
          400,
          refreshHeaders,
        );
      }

      const validated = await this.validateParams(route, params, refreshHeaders);
      if ('response' in validated) return validated.response;

      const fgaError = await checkRouteFGA(this.mastra, route, requestContext, {
        ...params.urlParams,
        ...params.queryParams,
        ...(typeof params.body === 'object' ? params.body : {}),
      });
      if (fgaError) {
        return json({ error: fgaError.error, message: fgaError.message }, fgaError.status, refreshHeaders);
      }

      const result = await route.handler({
        ...params.urlParams,
        ...params.queryParams,
        ...(typeof params.body === 'object' ? params.body : {}),
        requestContext,
        mastra: this.mastra,
        registeredTools: this.tools ?? {},
        taskStore: this.taskStore,
        abortSignal: request.signal,
        routePrefix: prefix,
        request,
      });

      const response = await this.sendResponse(route, { ...ctx, body: params.body }, result, prefix);
      for (const [key, value] of Object.entries(refreshHeaders)) response.headers.set(key, value);
      return response;
    } catch (error) {
      return this.toErrorResponse(error, route);
    }
  }

  private exceedsDeclaredLimit(route: ServerRoute, request: Request, maxSize?: number): boolean {
    if (maxSize === undefined || !BODY_METHODS.has(route.method.toUpperCase())) return false;
    const contentLength = request.headers.get('content-length');
    return contentLength !== null && Number.parseInt(contentLength, 10) > maxSize;
  }

  private bodyLimitResponse(route: ServerRoute): Response {
    let errorResponse: unknown = { error: 'Request body too large' };
    // A route-level cap is the route's own policy; only the global limit runs the global onError.
    if (route.maxBodySize === undefined && this.bodyLimitOptions) {
      try {
        errorResponse = this.bodyLimitOptions.onError(errorResponse);
      } catch {
        // Fall back to the default error response.
      }
    }
    return json(errorResponse, 413);
  }

  /**
   * Mastra's RBAC check, which only applies once an auth provider is configured.
   *
   * `hasPermission` lives in an enterprise-only module, so `loadHasPermission` can come back empty;
   * the request then proceeds unchecked rather than being refused.
   */
  private async resolvePermissionError(
    route: ServerRoute,
    requestContext: RequestContext,
  ): Promise<{ status: number; error: string; message: string } | null> {
    if (!this.mastra.getStudio?.()?.auth && !this.mastra.getServer()?.auth) return null;

    const hasPermission = await loadHasPermission();
    if (!hasPermission) return null;

    const userPermissions = requestContext.get('mastra__userPermissions') as string[] | undefined;
    return this.checkRoutePermission(route, userPermissions, hasPermission, requestContext);
  }

  private async validateParams(
    route: ServerRoute,
    params: ParsedRequestParams,
    refreshHeaders: Record<string, string>,
  ): Promise<{ ok: true } | { response: Response }> {
    const steps: Array<{ context: 'query' | 'body' | 'path'; run: () => Promise<void>; fallback: string }> = [
      {
        context: 'query',
        fallback: 'Invalid query parameters',
        run: async () => {
          if (params.queryParams) params.queryParams = await this.parseQueryParams(route, params.queryParams);
        },
      },
      {
        context: 'body',
        fallback: 'Invalid request body',
        run: async () => {
          if (params.body !== undefined || route.bodySchema) params.body = await this.parseBody(route, params.body);
        },
      },
      {
        context: 'path',
        fallback: 'Invalid path parameters',
        run: async () => {
          if (params.urlParams) params.urlParams = await this.parsePathParams(route, params.urlParams);
        },
      },
    ];

    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        this.mastra.getLogger()?.error(`Error parsing ${step.context} params`, {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        });
        if (isZodError(error)) {
          const resolved = this.resolveValidationError(route, error, step.context);
          return { response: json(resolved.body, resolved.status, refreshHeaders) };
        }
        return {
          response: json(
            {
              error: step.fallback,
              issues: [{ field: 'unknown', message: error instanceof Error ? error.message : 'Unknown error' }],
            },
            400,
            refreshHeaders,
          ),
        };
      }
    }

    return { ok: true };
  }

  private toErrorResponse(error: unknown, route?: ServerRoute): Response {
    const status = (error as any)?.status ?? (error as any)?.details?.status;
    const isClientError = typeof status === 'number' && status >= 400 && status < 500;

    if (!isClientError) {
      this.mastra.getLogger()?.error('Error calling handler', {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        path: route?.path,
        method: route?.method,
      });
    }

    const customResponse = getCustomHTTPExceptionResponse(error);
    if (customResponse) return customResponse;

    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, toHttpStatus(status));
  }

  async registerRoute(
    app: EffectRouter,
    route: ServerRoute,
    { prefix: prefixParam }: { prefix?: string } = {},
  ): Promise<void> {
    const prefix = prefixParam ?? this.prefix ?? '';
    const fullPath = `${prefix}${route.path}`;

    // rc.116's vendored FindMyWay binds the correct param name per route even when two routes
    // differ only in their param name at the same segment, so paths register verbatim — no
    // positional rewrite is needed here (see src/router-collision.test.ts).
    const handler = (serverRequest: HttpServerRequest.HttpServerRequest) =>
      Effect.flatMap(HttpRouter.params, pathParams =>
        // orDie keeps the error channel at `never`: a request that cannot be materialized is a
        // defect, not a recoverable route error, and `never` is what makes `add` runnable below.
        Effect.flatMap(Effect.orDie(HttpServerRequest.toWeb(serverRequest)), webRequest =>
          Effect.map(
            Effect.promise(() => this.handleRoute(route, prefix, webRequest, pathParams as Record<string, string>)),
            HttpServerResponse.fromWeb,
          ),
        ),
      );

    await Effect.runPromise(app.add(effectMethod(route.method, route.path), fullPath as `/${string}`, handler));
  }

  async registerCustomApiRoutes(): Promise<void> {
    const routes = await this.registerSchemaApiRoutes();
    if (!(await this.buildCustomRouteHandler(routes))) return;

    for (const route of routes) {
      const handler = (serverRequest: HttpServerRequest.HttpServerRequest) =>
        Effect.flatMap(Effect.orDie(HttpServerRequest.toWeb(serverRequest)), webRequest =>
          Effect.map(Effect.promise(() => this.handleCustomRoute(webRequest)), HttpServerResponse.fromWeb),
        );

      await Effect.runPromise(
        this.app.add(effectMethod(route.method, route.path), route.path as `/${string}`, handler),
      );
    }
  }

  private async handleCustomRoute(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      let body: unknown;
      if (method !== 'GET' && method !== 'HEAD') {
        const text = await request.clone().text();
        if (text.trim().length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
      }

      const requestContext = await this.createContextMiddleware()(request, body);

      const matchedRoute = findMatchingCustomRoute(
        path,
        method,
        this.customApiRoutes ?? this.mastra.getServer()?.apiRoutes,
      );
      const shouldRunAuth = isProtectedCustomRoute(path, method, this.customRouteAuthConfig);
      const shouldRunFGA = !!matchedRoute?.route.fga;

      if (shouldRunAuth || shouldRunFGA) {
        const serverRoute: ServerRoute = {
          method: (matchedRoute?.route.method ?? method) as any,
          path: matchedRoute?.route.path ?? path,
          responseType: 'json',
          handler: async () => {},
          requiresAuth: matchedRoute?.route.requiresAuth,
          requiresPermission: matchedRoute?.route.requiresPermission,
          fga: matchedRoute?.route.fga,
        };

        if (shouldRunAuth) {
          const authError = await this.checkRouteAuth(serverRoute, {
            path,
            method,
            getHeader: name => request.headers.get(name) ?? undefined,
            getQuery: name => url.searchParams.get(name) ?? undefined,
            requestContext,
            request,
            buildAuthorizeContext: () => request,
          });
          if (authError?.error) return json({ error: authError.error }, authError.status, authError.headers);

          const permissionError = await this.resolvePermissionError(serverRoute, requestContext);
          if (permissionError) {
            return json({ error: permissionError.error, message: permissionError.message }, permissionError.status);
          }
        }

        const fgaError = await checkRouteFGA(this.mastra, serverRoute, requestContext, {
          ...matchedRoute?.params,
          ...Object.fromEntries(url.searchParams),
        });
        if (fgaError) return json({ error: fgaError.error, message: fgaError.message }, fgaError.status);
      }

      const headers: Record<string, string | string[] | undefined> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Not a fetch handler despite the shape: it takes loose primitives and builds the Request
      // itself. `null` means no custom route matched.
      const response = await this.handleCustomRouteRequest(
        request.url,
        request.method,
        headers,
        body,
        requestContext,
        request.signal,
      );

      return response ?? json({ error: 'Not Found' }, 404);
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /** Context is built per route because Effect has no `derive`-style request hook. */
  registerContextMiddleware(): void {}

  /** Auth is resolved per route, matching every other adapter. */
  registerAuthMiddleware(): void {}

  registerHttpLoggingMiddleware(): void {
    if (!this.httpLoggingConfig?.enabled) return;

    // runSync, not runPromise: the base calls this synchronously inside init() and immediately
    // registers routes, so a floating promise would race registration and hide rejections.
    Effect.runSync(
      this.app.addGlobalMiddleware(httpEffect =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, serverRequest => {
          // `url` may be origin-relative, so give URL a base purely to parse it.
          const url = new URL(serverRequest.url, 'http://localhost');
          if (!this.shouldLogRequest(url.pathname)) return httpEffect;

          const start = Date.now();
          return Effect.map(httpEffect, response => {
            const duration = Date.now() - start;
            const level = this.httpLoggingConfig?.level || 'info';
            const logData: Record<string, any> = {
              method: serverRequest.method,
              path: url.pathname,
              status: response.status,
              duration: `${duration}ms`,
            };

            if (this.httpLoggingConfig?.includeQueryParams) {
              logData.query = Object.fromEntries(url.searchParams);
            }

            if (this.httpLoggingConfig?.includeHeaders) {
              const headers: Record<string, unknown> = { ...serverRequest.headers };
              for (const header of this.httpLoggingConfig.redactHeaders ?? []) {
                if (headers[header.toLowerCase()] !== undefined) headers[header.toLowerCase()] = '[REDACTED]';
              }
              logData.headers = headers;
            }

            this.logger[level](`${serverRequest.method} ${url.pathname} ${response.status} ${duration}ms`, logData);
            return response;
          });
        }),
      ),
    );
  }
}

/**
 * Creates an empty router to hand to `new MastraServer({ app })`.
 *
 * `ignoreDuplicateSlashes` is forced off because Effect's vendored FindMyWay defaults it on
 * (FindMyWay/internal/router.ts:54), unlike stock find-my-way. Left on, `/api//agents` would serve
 * `/api/agents` instead of 404ing, which diverges from every other Mastra adapter.
 */
export const createRouter = (config?: Partial<FindMyWay.RouterConfig>): EffectRouter =>
  Effect.runSync(
    Effect.provideService(HttpRouter.make, HttpRouter.RouterConfig, {
      ignoreDuplicateSlashes: false,
      ...config,
    }),
  );

/** Turns a populated router into a fetch-compatible handler plus its teardown. */
export const toWebHandler = (router: EffectRouter) =>
  HttpRouter.toWebHandler(Layer.succeed(HttpRouter.HttpRouter)(router));

type MastraServerOptions = ConstructorParameters<typeof MastraServer>[0];

/** Everything `MastraServer` takes except the router, which `createMastraServer` builds for you. */
export type CreateMastraServerOptions = Omit<MastraServerOptions, 'app'>;

/** Convenience wrapper: build a router, register every Mastra route onto it, return both. */
export async function createMastraServer(
  options: CreateMastraServerOptions,
): Promise<{ router: EffectRouter; adapter: MastraServer }> {
  const router = createRouter();
  const adapter = new MastraServer({ ...options, app: router });
  await adapter.init();
  return { router, adapter };
}

export type { ToolsInput };
