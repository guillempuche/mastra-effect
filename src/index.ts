import type { ToolsInput } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
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

type HasPermissionFn = (userPerms: string[], required: string) => boolean;

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
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * Forwards a body but swallows a mid-stream error, closing instead of erroring, so chunks already
 * delivered survive an upstream failure rather than tearing down the whole response.
 */
function createSafeReadableStream(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // Preserve chunks already sent before the upstream stream errored.
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

/** `fetch-to-node` needs a body it can replay; a consumed request must be rebuilt before forwarding. */
async function createForwardRequest(request: Request, parsedBody: unknown): Promise<Request> {
  if (request.method === 'GET' || request.method === 'HEAD') return request;

  const headers = new Headers(request.headers);
  let body: string | ArrayBuffer | undefined;

  if (parsedBody !== undefined) {
    body = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
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

function methodFor(route: ServerRoute): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | '*' {
  const method = route.method.toUpperCase();
  if (method === 'ALL') return '*';
  return method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
}

/**
 * Mastra server adapter for Effect's HTTP layer.
 *
 * `TApp` is a live `HttpRouter` service instance rather than a Layer: Mastra's `registerRoutes()`
 * awaits ~400 sequential registrations against one fixed app, which the Layer-based
 * `HttpRouter.add` cannot express but the service's effectful `add` can.
 *
 * `TRequest` and `TResponse` are both the Web `Request`. Nothing mutates a response — the base class
 * never reads the `TResponse` argument, it only uses `sendResponse`'s return value — so the slot
 * carries request data that `sendResponse` needs (notably for MCP forwarding), exactly as
 * `@mastra/elysia` carries its framework context there.
 */
export class MastraServer extends MastraServerBase<EffectRouter, Request, Request> {
  /** Builds the per-request Mastra context. Effect has no `derive`, so routes call this directly. */
  createContextMiddleware() {
    return async (request: Request): Promise<RequestContext> => {
      let bodyRequestContext: Record<string, any> | undefined;
      let paramsRequestContext: Record<string, any> | undefined;

      const method = request.method.toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        if (request.headers.get('content-type')?.includes('application/json')) {
          try {
            const body = (await request.clone().json()) as { requestContext?: Record<string, any> };
            if (body?.requestContext) bodyRequestContext = body.requestContext;
          } catch {
            // Not valid JSON — the route's own body parsing reports this.
          }
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
  }

  async getParams(route: ServerRoute, request: Request): Promise<ParsedRequestParams> {
    const url = new URL(request.url);
    const queryParams = normalizeQueryParams(Object.fromEntries(url.searchParams));
    const urlParams = ((request as any).__mastraPathParams ?? {}) as Record<string, string>;

    let body: unknown;
    let bodyParseError: { message: string } | undefined;

    const method = route.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const contentType = request.headers.get('content-type') ?? '';

      if (contentType.includes('multipart/form-data')) {
        try {
          body = await this.parseFormData(await request.clone().formData());
        } catch (error) {
          this.mastra.getLogger()?.error('Failed to parse multipart form data', {
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          });
          if (error instanceof Error && error.message.toLowerCase().includes('size')) throw error;
          bodyParseError = {
            message: error instanceof Error ? error.message : 'Failed to parse multipart form data',
          };
        }
      } else if (contentType.includes('application/json')) {
        const text = await request.clone().text();
        if (text.trim().length > 0) {
          try {
            body = JSON.parse(text);
          } catch (error) {
            bodyParseError = {
              message: error instanceof Error ? error.message : 'Invalid JSON in request body',
            };
          }
        }
      }
    }

    return { urlParams, queryParams, body, bodyParseError };
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

  async stream(route: ServerRoute, _request: Request, result: { fullStream: ReadableStream }): Promise<Response> {
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

    const stream = new ReadableStream<Uint8Array>({
      start: async controller => {
        const source = result instanceof ReadableStream ? result : result.fullStream;
        const reader = source.getReader();

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
          controller.error(error);
        } finally {
          await reader.cancel().catch(() => {});
        }
      },
    });

    return new Response(stream, { headers });
  }

  async sendResponse(route: ServerRoute, request: Request, result: unknown, prefix?: string): Promise<Response> {
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
        return this.stream(route, request, result as { fullStream: ReadableStream });

      case 'datastream-response':
        return forwardResponse(result as Response);

      case 'mcp-http': {
        const { server, httpPath, mcpOptions: routeMcpOptions } = result as MCPHttpTransportResult;
        const forwardRequest = await createForwardRequest(request, (request as any).__mastraBody);
        const { req, res } = toReqRes(forwardRequest);
        const options = { ...this.mcpOptions, ...routeMcpOptions };

        // Deliberately not awaited: startHTTP resolves when the body finishes, while
        // toFetchResponse resolves once headers are sent. Awaiting here would stall SSE.
        void server
          .startHTTP({
            url: new URL(forwardRequest.url),
            httpPath: `${resolvedPrefix}${httpPath}`,
            req,
            res,
            options: Object.keys(options).length > 0 ? options : undefined,
          })
          .catch((error: unknown) => {
            this.mastra.getLogger()?.error('[MCP HTTP] Error in background startHTTP', {
              error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
            });
          });

        return forwardResponse(await toFetchResponse(res));
      }

      case 'mcp-sse': {
        const { server, ssePath, messagePath } = result as MCPSseTransportResult;
        const forwardRequest = await createForwardRequest(request, (request as any).__mastraBody);
        const { req, res } = toReqRes(forwardRequest);

        void server
          .startSSE({
            url: new URL(forwardRequest.url),
            ssePath: `${resolvedPrefix}${ssePath}`,
            messagePath: `${resolvedPrefix}${messagePath}`,
            req,
            res,
          })
          .catch((error: unknown) => {
            this.mastra.getLogger()?.error('[MCP SSE] Error in background startSSE', {
              error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
            });
          });

        return forwardResponse(await toFetchResponse(res));
      }

      default:
        return new Response(null, { status: 500 });
    }
  }

  /** Never rejects — the caller runs it through `Effect.promise`, whose error channel is `never`. */
  private async handleRoute(
    route: ServerRoute,
    prefix: string,
    request: Request,
    pathParams: Record<string, string>,
  ): Promise<Response> {
    try {
      const requestContext = await this.createContextMiddleware()(request);
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

      if (this.mastra.getStudio?.()?.auth || this.mastra.getServer()?.auth) {
        const hasPermission = await loadHasPermission();
        if (hasPermission) {
          const userPermissions = requestContext.get('mastra__userPermissions') as string[] | undefined;
          const permissionError = this.checkRoutePermission(route, userPermissions, hasPermission, requestContext);
          if (permissionError) {
            return json(
              { error: permissionError.error, message: permissionError.message },
              permissionError.status,
              refreshHeaders,
            );
          }
        }
      }

      const overLimit = this.checkBodyLimit(route, request);
      if (overLimit) return overLimit;

      (request as any).__mastraPathParams = pathParams;
      const params = await this.getParams(route, request);
      (request as any).__mastraBody = params.body;

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

      const abortController = new AbortController();
      request.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

      const result = await route.handler({
        ...params.urlParams,
        ...params.queryParams,
        ...(typeof params.body === 'object' ? params.body : {}),
        requestContext,
        mastra: this.mastra,
        registeredTools: this.tools ?? {},
        taskStore: this.taskStore,
        abortSignal: request.signal ?? abortController.signal,
        routePrefix: prefix,
        request,
      });

      const response = await this.sendResponse(route, request, result, prefix);
      for (const [key, value] of Object.entries(refreshHeaders)) response.headers.set(key, value);
      return response;
    } catch (error) {
      return this.toErrorResponse(error, route);
    }
  }

  private checkBodyLimit(route: ServerRoute, request: Request): Response | undefined {
    const method = route.method.toUpperCase();
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return undefined;

    const maxSize = route.maxBodySize ?? this.bodyLimitOptions?.maxSize;
    if (maxSize === undefined) return undefined;

    const contentLength = request.headers.get('content-length');
    if (contentLength === null || Number.parseInt(contentLength, 10) <= maxSize) return undefined;

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

  private async validateParams(
    route: ServerRoute,
    params: ParsedRequestParams,
    refreshHeaders: Record<string, string>,
  ): Promise<{ ok: true } | { response: Response }> {
    const steps: Array<{
      context: 'query' | 'body' | 'path';
      run: () => Promise<void>;
      fallback: string;
    }> = [
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

    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ error: message }, typeof status === 'number' ? status : 500);
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
            Effect.promise(() =>
              this.handleRoute(route, prefix, webRequest, pathParams as Record<string, string>),
            ),
            HttpServerResponse.fromWeb,
          ),
        ),
      );

    await Effect.runPromise(app.add(methodFor(route), fullPath as `/${string}`, handler));
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
        this.app.add(route.method.toUpperCase() === 'ALL' ? '*' : (route.method.toUpperCase() as 'GET'), route.path as `/${string}`, handler),
      );
    }
  }

  private async handleCustomRoute(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const requestContext = await this.createContextMiddleware()(request);

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

          if (this.mastra.getStudio?.()?.auth || this.mastra.getServer()?.auth) {
            const hasPermission = await loadHasPermission();
            if (hasPermission) {
              const userPermissions = requestContext.get('mastra__userPermissions') as string[] | undefined;
              const permissionError = this.checkRoutePermission(
                serverRoute,
                userPermissions,
                hasPermission,
                requestContext,
              );
              if (permissionError) {
                return json(
                  { error: permissionError.error, message: permissionError.message },
                  permissionError.status,
                );
              }
            }
          }
        }

        const fgaError = await checkRouteFGA(this.mastra, serverRoute, requestContext, {
          ...(matchedRoute?.params ?? {}),
          ...Object.fromEntries(url.searchParams),
        });
        if (fgaError) return json({ error: fgaError.error, message: fgaError.message }, fgaError.status);
      }

      const headers: Record<string, string | string[] | undefined> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      let body: unknown;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const text = await request.clone().text();
        if (text.trim().length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
      }

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

    void Effect.runPromise(
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
              const redact = this.httpLoggingConfig.redactHeaders ?? [];
              const headers: Record<string, unknown> = { ...serverRequest.headers };
              for (const header of redact) {
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

export interface CreateMastraServerOptions {
  mastra: Mastra;
  tools?: ToolsInput;
  prefix?: string;
  [key: string]: unknown;
}

/** Convenience wrapper: build a router, register every Mastra route onto it, return both. */
export async function createMastraServer(
  options: CreateMastraServerOptions,
): Promise<{ router: EffectRouter; adapter: MastraServer }> {
  const router = createRouter();
  const adapter = new MastraServer({ app: router, ...options } as ConstructorParameters<typeof MastraServer>[0]);
  await adapter.init();
  return { router, adapter };
}
