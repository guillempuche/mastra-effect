import type { ToolsInput } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { findMatchingCustomRoute, isProtectedCustomRoute } from '@mastra/server/auth';
import type { MCPHttpTransportResult, MCPSseTransportResult } from '@mastra/server/handlers/mcp';
import type { ParsedRequestParams, ServerRoute } from '@mastra/server/server-adapter';
import {
  MastraServer as MastraServerBase,
  applyMcpRequestAuth,
  checkRouteFGA,
  getCustomHTTPExceptionResponse,
  isZodError,
  normalizeQueryParams,
  redactStreamChunk,
  serializeStreamChunk,
} from '@mastra/server/server-adapter';
import { Data, Effect, Exit, Layer, type ManagedRuntime, Option, type Scope, type Tracer } from 'effect';
import type { FindMyWay } from 'effect/unstable/http';
import {
  Cookies,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from 'effect/unstable/http';
import { toFetchResponse, toReqRes } from 'fetch-to-node';

export type EffectRouter = HttpRouter.HttpRouter;

/**
 * Everything the adapter threads through a single request.
 *
 * Bound to both `TRequest` and `TResponse`. Effect has no mutable response object, and the base
 * class never calls `sendResponse` itself — this adapter does, from `handleRoute` — so the slot
 * carries the request-side data `sendResponse` needs, the same way `@mastra/elysia` carries its
 * framework context there. Passing an explicit object (rather than stashing properties on the
 * `Request`) keeps `getParams` and `sendResponse` honest when called outside `handleRoute`.
 */
export interface EffectRequestContext {
  readonly request: Request;
  readonly pathParams: Record<string, string>;
  /** Parsed once per request so nothing downstream re-reads the body. */
  readonly body: unknown;
  readonly bodyParseError?: { message: string };
  /** The request's Mastra context, which MCP transports need to learn who the caller is. */
  readonly requestContext?: RequestContext;
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
        '[@guillem_puche/mastra-effect] Auth features require @mastra/core >= 1.68.0. Please upgrade: npm install @mastra/core@latest',
      );
      return undefined;
    });
  return hasPermissionPromise;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status: toHttpStatus(status), headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * Adds headers to a response, appending `Set-Cookie` so a refreshed session cookie joins the ones the
 * route set instead of replacing them.
 */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  const entries = Object.entries(headers);
  if (entries.length === 0) return response;
  // A Response from `fetch`, or one a route built with frozen headers, cannot be edited in place.
  const editable = new Response(response.body, response);
  for (const [key, value] of entries) {
    if (key.toLowerCase() === 'set-cookie') editable.headers.append(key, value);
    else editable.headers.set(key, value);
  }
  return editable;
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
  return new Response(createSafeReadableStream(source.body), {
    status: source.status,
    statusText: source.statusText,
    headers: withoutTransferEncoding(source.headers),
  });
}

function withoutTransferEncoding(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('Transfer-Encoding');
  return headers;
}

/**
 * Forwards what an MCP transport wrote, and tells the transport when the client goes away.
 *
 * `fetch-to-node` builds the body from the simulated Node response but never learns that the
 * stream it handed back was cancelled. Nothing then tells the transport the client is gone, so its
 * keep-alive timer keeps firing, and the next tick writes into a closed stream — an
 * `ERR_INVALID_STATE` thrown from a timer, which nothing can catch and which ends the process.
 * Emitting `close` on the response is what the MCP transport listens for: it stops, and ends the
 * response itself.
 *
 * The bridge stream is drained rather than cancelled, for the same reason: `fetch-to-node` flushes
 * buffered writes from a timer, and cancelling its stream leaves that flush writing into a closed
 * one. Ported from `@mastra/hono`'s `propagateClientDisconnect` (see NOTICE).
 */
function forwardMcpResponse(source: Response, res: { emit: (event: string) => unknown }): Response {
  const init = { status: source.status, statusText: source.statusText, headers: withoutTransferEncoding(source.headers) };
  const upstream = source.body;
  if (!upstream) return new Response(null, init);

  const reader = upstream.getReader();
  let disconnected = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        // Keep what was already delivered, as forwardResponse does.
        controller.close();
      }
    },
    cancel() {
      if (disconnected) return;
      disconnected = true;
      try {
        res.emit('close');
      } catch {
        // Already torn down: the transport has nothing left to stop.
      }
      void reader.read().then(
        function drain({ done }): unknown {
          return done ? undefined : reader.read().then(drain);
        },
        () => {},
      );
    },
  });

  return new Response(body, init);
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
 * A Mastra route that failed with a server error (5xx), surfaced in Effect's error channel.
 *
 * It answers with exactly the response Mastra built, so clients see no difference. What changes is
 * what the app's Effect code sees: middleware can `catchTag('MastraRouteError')`, Effect's logger
 * records the cause, and a tracer marks the request span as failed. 4xx answers stay successes —
 * a refused or invalid request is not a server failure.
 */
export class MastraRouteError
  extends Data.TaggedError('MastraRouteError')<{
    /** The HTTP status Mastra answered with. */
    readonly status: number;
    /**
     * What the route threw. When Mastra answered the failure before it reached the adapter — a custom
     * route's handler, whose errors Mastra's own sub-app answers, or an MCP transport that failed to
     * start — an `Error` naming the request and the status instead.
     */
    readonly cause: unknown;
    /** The response Mastra built for it, sent unchanged. */
    readonly response: HttpServerResponse.HttpServerResponse;
  }>
  implements HttpServerRespondable.Respondable
{
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(this.response);
  }
}

/** The error a route threw, keyed by the response it was turned into. */
const routeErrors = new WeakMap<Response, unknown>();

/**
 * The key under which the request's Effect span is stored in Mastra's `RequestContext`.
 *
 * Stored as a function on purpose: `RequestContext` drops functions when it is serialised, so the span
 * never lands in a workflow snapshot, and a client sending `requestContext` as JSON cannot supply one.
 */
const REQUEST_SPAN_KEY = 'mastraEffect.requestSpan';

/** Everything `new MastraServer(...)` takes: Mastra's adapter options, plus this adapter's own. */
export type MastraServerOptions = ConstructorParameters<
  typeof MastraServerBase<EffectRouter, EffectRequestContext, EffectRequestContext>
>[0] & {
  /**
   * Fail the Effect request with a `MastraRouteError` when a route answers with a server error
   * (5xx), so the app's Effect error handling, logs and traces see it. The response is the same
   * either way. Defaults to `true`.
   */
  readonly errorChannel?: boolean;
};

/**
 * Mastra server adapter for Effect's HTTP layer.
 *
 * `TApp` is a live `HttpRouter` service instance rather than a Layer: Mastra's `registerRoutes()`
 * awaits ~400 sequential registrations against one fixed app, which the Layer-based
 * `HttpRouter.add` cannot express but the service's effectful `add` can.
 */
export class MastraServer extends MastraServerBase<EffectRouter, EffectRequestContext, EffectRequestContext> {
  private contextMiddleware?: (request: Request, parsedBody?: unknown) => Promise<RequestContext>;
  private readonly errorChannel: boolean;

  constructor(options: MastraServerOptions) {
    const { errorChannel, ...base } = options;
    super(base);
    this.errorChannel = errorChannel ?? true;
  }

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

      // POST too, as in @mastra/hono: a client may put the context in the query whatever the method.
      if (method === 'GET' || method === 'POST') {
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
    // Every value of a repeated key (`?tags=a&tags=b`), which Mastra's schemas accept as an array;
    // `normalizeQueryParams` turns a key given once back into a plain string.
    const query: Record<string, string[]> = {};
    for (const key of new Set(url.searchParams.keys())) query[key] = url.searchParams.getAll(key);
    return {
      urlParams: ctx.pathParams,
      queryParams: normalizeQueryParams(query),
      body: ctx.body,
      bodyParseError: ctx.bodyParseError,
    };
  }

  /**
   * Reads and parses the body exactly once.
   *
   * `oversize` rather than a body when the limit is blown: a chunked request declares no
   * `Content-Length`, so counting what actually arrives is the only way to enforce the cap — for
   * uploads as much as for JSON.
   */
  private async readBody(
    route: ServerRoute,
    request: Request,
    maxSize?: number,
  ): Promise<{ body?: unknown; bodyParseError?: { message: string }; oversize?: true }> {
    if (!BODY_METHODS.has(route.method.toUpperCase())) return {};

    const contentType = request.headers.get('content-type') ?? '';
    const isMultipart = contentType.includes('multipart/form-data');
    if (!isMultipart && !contentType.includes('application/json')) return {};

    const bytes = await readBytesWithin(request.clone(), maxSize);
    if (bytes === undefined) return { oversize: true };

    if (isMultipart) {
      try {
        const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
        return { body: await this.parseFormData(form) };
      } catch (error) {
        this.mastra.getLogger()?.error('Failed to parse multipart form data', {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        });
        return {
          bodyParseError: { message: error instanceof Error ? error.message : 'Failed to parse multipart form data' },
        };
      }
    }

    const text = new TextDecoder().decode(bytes);
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
    // of the `{ fullStream }` shape still arrives here — and so can one that returns no stream at all,
    // which must fail as a 500 now rather than as a 200 whose body then breaks.
    const source: unknown = result instanceof ReadableStream ? result : result?.fullStream;
    if (!(source instanceof ReadableStream)) {
      throw new Error(`Route ${route.path} declares a stream response but returned no stream`);
    }
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
          // Closed rather than errored, as in @mastra/hono, so the chunks already sent are delivered the
          // same way on every transport. Throws if the consumer already cancelled, which is fine.
          try {
            controller.close();
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
        if (!(result instanceof Response)) {
          throw new Error(`Route ${route.path} declares a Response but returned something else`);
        }
        return forwardResponse(result);

      case 'mcp-http': {
        const { server, httpPath, mcpOptions: routeMcpOptions } = result as MCPHttpTransportResult;
        // `setRequestAuth` is the adapter's hook, not a transport option — the transport rejects it.
        const { setRequestAuth, ...options } = { ...this.mcpOptions, ...routeMcpOptions };

        return this.bridgeMcpTransport(ctx, {
          label: '[MCP HTTP] Error in background startHTTP',
          setRequestAuth,
          // The client speaks JSON-RPC, so the failure is answered in it.
          failureBody: { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
          start: ({ url, req, res }) =>
            server.startHTTP({
              url,
              httpPath: `${resolvedPrefix}${httpPath}`,
              req,
              res,
              options: Object.keys(options).length > 0 ? options : undefined,
            }),
        });
      }

      case 'mcp-sse': {
        const { server, ssePath, messagePath } = result as MCPSseTransportResult;

        return this.bridgeMcpTransport(ctx, {
          label: '[MCP SSE] Error in background startSSE',
          setRequestAuth: this.mcpOptions?.setRequestAuth,
          failureBody: { error: 'Error handling MCP SSE request' },
          start: ({ url, req, res }) =>
            server.startSSE({
              url,
              ssePath: `${resolvedPrefix}${ssePath}`,
              messagePath: `${resolvedPrefix}${messagePath}`,
              req,
              res,
            }),
        });
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
    transport: {
      readonly label: string;
      readonly setRequestAuth?: Parameters<typeof applyMcpRequestAuth>[0]['setRequestAuth'];
      readonly failureBody: unknown;
      readonly start: (transport: ReturnType<typeof toReqRes> & { url: URL }) => Promise<unknown>;
    },
  ): Promise<Response> {
    const forwardRequest = await createForwardRequest(ctx.request, ctx.body);
    const { req, res } = toReqRes(forwardRequest);

    // `toReqRes` builds a fresh Node request, so the caller Mastra's auth resolved never reaches the
    // transport — and so never reaches the tools, as `authInfo` — unless it is carried over here.
    await applyMcpRequestAuth({ req, requestContext: ctx.requestContext, setRequestAuth: transport.setRequestAuth });

    void transport.start({ url: new URL(forwardRequest.url), req, res }).catch((error: unknown) => {
      this.mastra.getLogger()?.error(transport.label, {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      });
      // `toFetchResponse` below waits for headers, and a transport that failed before writing any
      // never will: answer, or the client waits forever.
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(transport.failureBody));
        }
      } catch {
        // Already closed or destroyed — nothing left to answer.
      }
    });

    return forwardMcpResponse(await toFetchResponse(res), res);
  }

  /**
   * Never rejects — the caller runs it through `Effect.promise`. A route that threw is still answered
   * with a response; what it threw is kept in `routeErrors` for `toEffectOutcome`.
   */
  private async handleRoute(
    route: ServerRoute,
    prefix: string,
    request: Request,
    pathParams: Record<string, string>,
    span: Tracer.AnySpan | undefined,
  ): Promise<Response> {
    // Outside the try, so a refreshed session reaches the client even when the route then fails.
    let refreshHeaders: Record<string, string> = {};
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
      if (span) requestContext.set(REQUEST_SPAN_KEY, () => span);
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

      refreshHeaders = authError?.headers ?? {};

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

      const response = await this.sendResponse(route, { ...ctx, body: params.body, requestContext }, result, prefix);
      return withHeaders(response, refreshHeaders);
    } catch (error) {
      const response = withHeaders(this.toErrorResponse(error, route), refreshHeaders);
      routeErrors.set(response, error);
      return response;
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

    // Which items failed, for an error that says — Studio's dataset form reads `cause.failingItems`.
    // Only that field, so nothing else an error carries in its cause leaks to the client.
    const cause = error instanceof Error ? error.cause : undefined;
    const failingItems =
      typeof status === 'number' && cause && typeof cause === 'object' && 'failingItems' in cause
        ? (cause as { failingItems?: unknown }).failingItems
        : undefined;

    return json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        ...(Array.isArray(failingItems) ? { cause: { failingItems } } : {}),
      },
      toHttpStatus(status),
    );
  }

  async registerRoute(
    app: EffectRouter,
    route: ServerRoute,
    { prefix: prefixParam }: { prefix?: string } = {},
  ): Promise<void> {
    const prefix = prefixParam ?? this.prefix ?? '';
    const fullPath = `${prefix}${route.path}`;

    // rc.117's vendored FindMyWay binds the correct param name per route even when two routes
    // differ only in their param name at the same segment, so paths register verbatim — no
    // positional rewrite is needed here (see src/router-collision.test.ts).
    const handler = this.toEffectHandler((request, pathParams, span) =>
      this.handleRoute(route, prefix, request, pathParams, span),
    );

    await Effect.runPromise(addRoute(app, effectMethod(route.method, route.path), fullPath as `/${string}`, handler));
  }

  async registerCustomApiRoutes(): Promise<void> {
    const routes = await this.registerSchemaApiRoutes();
    if (!(await this.buildCustomRouteHandler(routes))) return;

    const handler = this.toEffectHandler((request, _pathParams, span) => this.handleCustomRoute(request, span));
    for (const route of routes) {
      await Effect.runPromise(addRoute(this.app, effectMethod(route.method, route.path), route.path as `/${string}`, handler));
    }
  }

  /**
   * An Effect route handler around one of the adapter's Web entry points. The entry point gets the
   * request with a body it can read and a signal that aborts if the client leaves, plus the path
   * parameters and the request's span; what it answers becomes the Effect result.
   */
  private toEffectHandler(
    answer: (request: Request, pathParams: Record<string, string>, span: Tracer.AnySpan | undefined) => Promise<Response>,
  ) {
    return (serverRequest: HttpServerRequest.HttpServerRequest) =>
      Effect.flatMap(
        Effect.all([HttpRouter.params, abortOnDisconnect, Effect.option(Effect.currentParentSpan)]),
        ([pathParams, signal, span]) =>
          // A request that cannot be materialized is a defect, not a route error.
          Effect.flatMap(toReadableWebRequest(serverRequest, signal), request =>
            Effect.flatMap(
              Effect.promise(() => answer(request, pathParams as Record<string, string>, Option.getOrUndefined(span))),
              response => this.toEffectOutcome(request, response),
            ),
          ),
      );
  }

  private async handleCustomRoute(request: Request, span: Tracer.AnySpan | undefined): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // `readBodyFields` parses a copy, only to read fields from. The route itself gets the original
      // body: custom routes are often webhooks that verify a signature over the exact bytes sent,
      // and parsing and re-serialising changes them — whitespace, duplicate keys, large integers,
      // binary data.
      const body = await readBodyFields(request);

      const requestContext = await this.createContextMiddleware()(request, body.json);
      if (span) requestContext.set(REQUEST_SPAN_KEY, () => span);

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
          ...body.fields,
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
        // The stream itself, which the base forwards byte for byte, as @mastra/hono does.
        request.body ?? undefined,
        requestContext,
        request.signal,
      );

      return response ?? json({ error: 'Not Found' }, 404);
    } catch (error) {
      const response = this.toErrorResponse(error);
      routeErrors.set(response, error);
      return response;
    }
  }

  /**
   * The Effect result of a route: its response, or — for a server error (5xx), when the error
   * channel is on — a `MastraRouteError` that answers with that same response.
   *
   * Decided by the status, not by whether the adapter caught something: not every server error
   * passes through its `catch`. A custom route's handler that throws is answered by Mastra's own
   * sub-app, and an MCP transport that fails to start writes its 500 itself.
   */
  private toEffectOutcome(
    request: Request,
    response: Response,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, MastraRouteError> {
    const converted = this.toEffectResponse(response);
    if (!this.errorChannel || response.status < 500) return Effect.succeed(converted);
    const cause = routeErrors.has(response)
      ? routeErrors.get(response)
      : new Error(`Mastra answered ${request.method} ${new URL(request.url).pathname} with ${response.status}`);
    return Effect.fail(new MastraRouteError({ status: response.status, cause, response: converted }));
  }

  /**
   * Converts a Web response for Effect to send, keeping every `Set-Cookie`.
   *
   * `HttpServerResponse.fromWeb` files cookies by name, so two sharing a name — one cleared at two
   * paths, say — collapse into the last, and one that cannot be serialised fails the response when
   * it is sent, leaving the client waiting. Each cookie gets its own entry here instead, and one
   * that could never be sent is dropped with a warning. Attributes Effect does not model (anything
   * but Domain, Path, Expires, Max-Age, HttpOnly, Secure, SameSite, Priority, Partitioned) are lost.
   */
  private toEffectResponse(response: Response): HttpServerResponse.HttpServerResponse {
    const setCookies = response.headers.getSetCookie();
    const converted = HttpServerResponse.fromWeb(response);
    if (setCookies.length === 0) return converted;

    const cookies: Record<string, Cookies.Cookie> = {};
    setCookies.forEach((header, index) => {
      for (const cookie of Object.values(Cookies.fromSetCookie(header).cookies)) {
        try {
          Cookies.serializeCookie(cookie);
          cookies[`${index}:${cookie.name}`] = cookie;
        } catch (error) {
          this.mastra.getLogger()?.warn('Dropped a Set-Cookie header that cannot be sent', {
            cookie: cookie.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    return HttpServerResponse.replaceCookies(converted, Cookies.fromReadonlyRecord(cookies));
  }

  /**
   * Context is built per route because Effect has no `derive`-style request hook. What does need
   * every request, matched or not, is the warning for a channel webhook nobody registered, which
   * shows up as a 404 no route would ever log — so it runs here, as in `@mastra/hono`.
   *
   * It wraps the app's own routes too, since they share the router, so it steps aside at once for
   * anything that cannot be such a webhook: every method but POST, and a target with no parsable path.
   */
  registerContextMiddleware(): void {
    Effect.runSync(
      this.app.addGlobalMiddleware(httpEffect =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, serverRequest => {
          if (serverRequest.method.toUpperCase() !== 'POST') return httpEffect;
          const url = parseTarget(serverRequest.url);
          if (!url) return httpEffect;
          return Effect.onExit(httpEffect, exit =>
            Effect.map(statusOf(exit), status =>
              this.warnIfUnregisteredChannelWebhook(url.pathname, serverRequest.method, status),
            ),
          );
        }),
      ),
    );
  }

  /** Auth is resolved per route, matching every other adapter. */
  registerAuthMiddleware(): void {}

  registerHttpLoggingMiddleware(): void {
    if (!this.httpLoggingConfig?.enabled) return;

    // runSync, not runPromise: the base calls this synchronously inside init() and immediately
    // registers routes, so a floating promise would race registration and hide rejections.
    Effect.runSync(
      this.app.addGlobalMiddleware(httpEffect =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, serverRequest => {
          const url = parseTarget(serverRequest.url);
          // A target with no parsable path is logged as it arrived.
          const path = url?.pathname ?? serverRequest.url;
          if (!this.shouldLogRequest(path)) return httpEffect;

          const start = Date.now();
          // On exit rather than on success, so a request no route matched — which fails instead of
          // producing a response — is logged with the 404 it is answered with, as in @mastra/hono.
          return Effect.onExit(httpEffect, exit =>
            Effect.map(statusOf(exit), status => {
              const duration = Date.now() - start;
              const level = this.httpLoggingConfig?.level || 'info';
              const logData: Record<string, any> = {
                method: serverRequest.method,
                path,
                status,
                duration: `${duration}ms`,
              };

              if (this.httpLoggingConfig?.includeQueryParams) {
                logData.query = Object.fromEntries(url?.searchParams ?? []);
              }

              if (this.httpLoggingConfig?.includeHeaders) {
                const headers: Record<string, unknown> = { ...serverRequest.headers };
                for (const header of this.httpLoggingConfig.redactHeaders ?? []) {
                  if (headers[header.toLowerCase()] !== undefined) headers[header.toLowerCase()] = '[REDACTED]';
                }
                logData.headers = headers;
              }

              this.logger[level](`${serverRequest.method} ${path} ${status} ${duration}ms`, logData);
            }),
          );
        }),
      ),
    );
  }
}

/**
 * The request as a Web `Request` whose body can still be read.
 *
 * `HttpServerRequest.toWeb` hands over the original body. Once a middleware has read it
 * (`request.json`, `request.text`…) that body is empty on a Node server and unusable in a fetch
 * handler, so Mastra would see no input at all. Effect keeps what the middleware read, and the body
 * is rebuilt from that: the bytes where Effect kept them, otherwise the text, which is what a fetch
 * handler keeps for JSON and forms. A body nobody has read passes through untouched, still streaming.
 */
const toReadableWebRequest = (
  serverRequest: HttpServerRequest.HttpServerRequest,
  signal: AbortSignal,
): Effect.Effect<Request> =>
  // The signal only takes effect where Effect builds the Request (a Node server). A fetch handler
  // passes the host's own Request through, whose signal already aborts when the client leaves.
  Effect.flatMap(Effect.orDie(HttpServerRequest.toWeb(serverRequest, { signal })), request => {
    // GET and HEAD carry no body, and a Request with those methods refuses one.
    if (request.method === 'GET' || request.method === 'HEAD' || !bodyWasRead(serverRequest.source)) {
      return Effect.succeed(request);
    }
    // Read some other way — the raw stream, say — nothing kept the bytes. Failing says so; passing
    // the empty body on would surface as a baffling validation error far from the cause.
    if (!effectKeptBody(serverRequest)) {
      return Effect.die(
        new Error(
          `The body of ${request.method} ${new URL(request.url).pathname} was consumed before Mastra's route ran, ` +
            'and not through request.text/json/arrayBuffer, so it cannot be recovered',
        ),
      );
    }
    return serverRequest.arrayBuffer.pipe(
      Effect.map(bytes => new Uint8Array(bytes)),
      Effect.catch(() => Effect.map(serverRequest.text, text => new TextEncoder().encode(text))),
      Effect.orDie,
      Effect.map(
        body => new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal }),
      ),
    );
  });

/**
 * A signal that aborts when the request ends without its response having been sent: the client
 * disconnected, or the server shut down first. Mastra hands it to routes as `abortSignal`, which is
 * what stops an agent's model calls — without it they run to the end after the client has left.
 *
 * Tied to the request's scope, which Effect keeps open until the response body has been written,
 * so it also covers a streamed answer the client stops reading partway.
 */
const abortOnDisconnect: Effect.Effect<AbortSignal, never, Scope.Scope> = Effect.suspend(() => {
  const controller = new AbortController();
  return Effect.as(
    Effect.addFinalizer(exit => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort()))),
    controller.signal,
  );
});

/**
 * The target a request asked for, as a URL, for reading its path and query. `url` may be
 * origin-relative, so URL gets a base purely to parse it.
 *
 * `undefined` for a target URL cannot parse, such as `//[`, which Node still accepts. Throwing
 * instead would fail the request as a defect, so the router's 404 for it would become a 500.
 */
const parseTarget = (url: string): URL | undefined => {
  try {
    return new URL(url, 'http://localhost');
  } catch {
    return undefined;
  }
};

/**
 * The status a request is answered with, including when it failed instead of producing a response
 * — asked of the failure the same way Effect's server asks when it answers, so a request no route
 * matched reports its 404.
 */
const statusOf = (exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>): Effect.Effect<number> =>
  Exit.isSuccess(exit)
    ? Effect.succeed(exit.value.status)
    : Effect.map(HttpServerError.causeResponse(exit.cause), ([response]) => response.status);

/**
 * The body, or `undefined` once it passes `maxSize`. Counted as it arrives, because a chunked
 * request declares no length; reading stops at the limit instead of buffering the rest.
 */
async function readBytesWithin(request: Request, maxSize?: number): Promise<Uint8Array | undefined> {
  if (maxSize === undefined) return new Uint8Array(await request.arrayBuffer());

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxSize) {
      // Not awaited: this is a clone, and a clone's cancel only settles once the original is
      // cancelled too, which never happens here.
      void reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Whether something already read the body of a Web `Request` or a Node `IncomingMessage`. */
const bodyWasRead = (source: unknown): boolean => {
  if (source instanceof Request) return source.bodyUsed;
  const stream = source as { readonly readableDidRead?: unknown } | null;
  return stream?.readableDidRead === true;
};

/**
 * Whether Effect kept a copy of the body when it was read.
 *
 * Checked before asking for that copy, because on Node, asking Effect for the bytes of a stream
 * something else already drained waits forever. The fields are Effect's private caches, the same on
 * the Node and the fetch implementations. Should a release rename them, this answers false and the
 * regression tests for a body read by middleware fail — never a hang.
 */
const effectKeptBody = (serverRequest: HttpServerRequest.HttpServerRequest): boolean => {
  const caches = serverRequest as unknown as { readonly arrayBufferEffect?: unknown; readonly textEffect?: unknown };
  return caches.arrayBufferEffect !== undefined || caches.textEffect !== undefined;
};

/**
 * The fields a custom route's permission check may read from the body, mirroring @mastra/hono: the
 * members of a JSON object, or the entries of a form. `json` is the parsed JSON, for the request
 * context. Anything unreadable contributes nothing — the route still receives the body and reports
 * the problem itself.
 *
 * Reads a copy, leaving `request`'s own body for the route, and copies only a body it will read: an
 * unread copy of a large upload would hold every byte of it until the request is gone.
 */
async function readBodyFields(request: Request): Promise<{ json?: unknown; fields: Record<string, unknown> }> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const parsed: unknown = await request.clone().json();
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      return { json: parsed, fields: isObject ? (parsed as Record<string, unknown>) : {} };
    }
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      return { fields: Object.fromEntries(await request.clone().formData()) };
    }
  } catch {
    // Not what the content type claims.
  }
  return { fields: {} };
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

/**
 * Registers a route whose handler may fail with `MastraRouteError`.
 *
 * `HttpRouter.add` records a handler's error type as a requirement, so middleware can promise to
 * handle it. Nothing needs to: unhandled, the error answers with its own response (it is
 * `Respondable`). So the requirement is dropped here, which keeps registration runnable on its own.
 */
const addRoute = (
  app: EffectRouter,
  method: Parameters<EffectRouter['add']>[0],
  path: `/${string}`,
  handler: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, MastraRouteError, Scope.Scope | HttpRouter.RouteContext>,
): Effect.Effect<void> => app.add(method, path, handler) as Effect.Effect<void>;

/**
 * The Effect span of the HTTP request a Mastra tool or workflow step is running for, when the app
 * has a tracer installed. `undefined` otherwise, and for a workflow resumed by a later request.
 */
export function requestSpan(requestContext: RequestContext | undefined): Tracer.AnySpan | undefined {
  const getSpan = requestContext?.get(REQUEST_SPAN_KEY);
  return typeof getSpan === 'function' ? (getSpan as () => Tracer.AnySpan)() : undefined;
}

/**
 * Runs an Effect from inside a Mastra tool or workflow step.
 *
 * Mastra runs tools and steps as plain promises, outside the Effect request that triggered them.
 * This gives the Effect the services `runtime` provides, makes the HTTP request's span its parent,
 * and interrupts it when Mastra's abort signal fires. Pass the context Mastra hands the tool or
 * step — it carries both the request context and that signal:
 *
 * ```ts
 * execute: (input, context) => runInRequest(runtime, Users.find(input.id), context)
 * ```
 *
 * Two things follow from running through `runtime` rather than the request:
 *
 * - The signal is whatever Mastra hands over. For a tool an agent calls, it aborts when the client
 *   leaves. A workflow step's is the run's own: it aborts when the run is cancelled, not when the
 *   request that started it is abandoned.
 * - The spans the Effect creates are made by `runtime`'s tracer. Give the runtime the app's tracer
 *   as well, or they have the right parent but are never exported.
 */
export function runInRequest<A, E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, R>,
  context: { readonly requestContext?: RequestContext; readonly abortSignal?: AbortSignal } = {},
): Promise<A> {
  const span = requestSpan(context.requestContext);
  // The parent is set explicitly. With @effect/opentelemetry and a context manager, an Effect span
  // started here should join the active OpenTelemetry span by itself, but it starts a new trace
  // instead: https://github.com/Effect-TS/effect/issues/8489. Once fixed, this still matters for apps
  // without a context manager, so it stays.
  return runtime.runPromise(span ? Effect.withParentSpan(effect, span) : effect, { signal: context.abortSignal });
}

/**
 * Turns a populated router into a fetch-compatible handler plus its teardown.
 *
 * Effect logs every request it answers; pass `{ disableLogger: true }` to stop that. `dispose`
 * releases what the handler holds, not Mastra. For a tracer or other services, call
 * `HttpRouter.toWebHandler` with your own layer merged in.
 */
export const toWebHandler = (router: EffectRouter, options?: { readonly disableLogger?: boolean }) =>
  HttpRouter.toWebHandler(Layer.succeed(HttpRouter.HttpRouter)(router), options);

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
