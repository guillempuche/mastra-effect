/**
 * Mastra's published conformance suites, run against the Effect adapter — all six of them.
 *
 * `createRouteAdapterTestSuite` iterates SERVER_ROUTES live rather than a hand-written list, so
 * this is what lets the README claim route parity instead of "tested against the routes I thought of".
 * The other suites are wired the way `@mastra/elysia`, the closest official adapter, wires them.
 */
import type { AdapterSetupOptions, AdapterTestContext, HttpRequest, HttpResponse } from '@mastra/server-adapters-test-suite';
import {
  createBodyLimitTestSuite,
  createHttpLoggingTestSuite,
  createMCPRouteTestSuite,
  createMCPTransportTestSuite,
  createMultipartTestSuite,
  createRouteAdapterTestSuite,
} from '@mastra/server-adapters-test-suite';
import { Effect } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { MastraServer, createRouter, toWebHandler, type EffectRouter } from './index';
import { onNodeServer } from './test-support';

/** One web handler per router; the router is mutable, so later registrations stay visible. */
const handlers = new WeakMap<object, ReturnType<typeof toWebHandler>>();

function handlerFor(router: EffectRouter) {
  let handler = handlers.get(router);
  if (!handler) {
    handler = toWebHandler(router, { disableLogger: true });
    handlers.set(router, handler);
  }
  return handler;
}

async function setupAdapter(context: AdapterTestContext, options?: AdapterSetupOptions) {
  const router = createRouter();
  const adapter = new MastraServer({
    app: router,
    mastra: context.mastra,
    tools: context.tools,
    taskStore: context.taskStore,
    customRouteAuthConfig: context.customRouteAuthConfig,
    ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
  } as ConstructorParameters<typeof MastraServer>[0]);

  await adapter.init();
  return { adapter, app: router };
}

async function executeHttpRequest(app: EffectRouter, request: HttpRequest): Promise<HttpResponse> {
  const url = new URL(`http://localhost${request.path.startsWith('/') ? request.path : `/${request.path}`}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) value.forEach(entry => url.searchParams.append(key, entry));
    else url.searchParams.set(key, value);
  }

  const headers = new Headers(request.headers);
  // Always JSON-encode: a scalar body of "" must reach the server as the two characters `""`,
  // not as an empty body, or the route's scalar schema sees `undefined` and rejects it.
  const body = request.body !== undefined ? JSON.stringify(request.body) : undefined;
  if (request.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response: Response;
  try {
    const { handler } = handlerFor(app);
    response = await handler(new Request(url, { method: request.method, headers, body }));
  } catch (error) {
    return {
      status: 500,
      type: 'json',
      data: { error: error instanceof Error ? error.message : 'Unknown error' },
      headers: {},
    };
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const contentType = responseHeaders['content-type'] ?? '';
  const isStream =
    contentType.includes('text/plain') ||
    contentType.includes('text/event-stream') ||
    contentType.includes('audio/') ||
    contentType.includes('application/octet-stream') ||
    responseHeaders['transfer-encoding'] === 'chunked';

  if (isStream) {
    return { status: response.status, type: 'stream', stream: response.body ?? undefined, headers: responseHeaders };
  }

  // Read as text first: calling .json() on a non-JSON error body consumes it and then throws.
  const raw = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  return { status: response.status, type: 'json', data, headers: responseHeaders };
}

createRouteAdapterTestSuite({
  suiteName: 'Effect server adapter',
  setupAdapter,
  executeHttpRequest,
});

createMCPRouteTestSuite({
  suiteName: 'Effect server adapter (MCP routes)',
  setupAdapter,
  executeHttpRequest,
});

/** Sends a request through the router the way a fetch-based host would; only the status matters here. */
const fetchStatus = async (app: EffectRouter, request: Request) => ({
  status: (await handlerFor(app).handler(request)).status,
});

createBodyLimitTestSuite<EffectRouter>({
  suiteName: 'Effect server adapter (body limit)',
  createApp: () => createRouter(),
  setupAdapter: (app, mastra, bodyLimitOptions) => ({ adapter: new MastraServer({ app, mastra, bodyLimitOptions }), app }),
  registerRoute: (adapter, app, route) => adapter.registerRoute(app, route, { prefix: '' }),
  // A real HTTP client declares the length; `new Request` does not, so it is set here as one would.
  executeRequest: (app, method, url, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.body) headers.set('content-length', String(Buffer.byteLength(options.body)));
    return fetchStatus(app, new Request(url, { method, headers, ...(options.body ? { body: options.body } : {}) }));
  },
  executeRequestWithoutContentLength: (app, method, url, options = {}) =>
    fetchStatus(app, new Request(url, { method, headers: options.headers, ...(options.body ? { body: options.body } : {}) })),
});

createHttpLoggingTestSuite<EffectRouter>({
  suiteName: 'Effect server adapter (HTTP logging)',
  createApp: () => createRouter(),
  setupAdapter: (app, mastra) => ({ adapter: new MastraServer({ app, mastra }), app }),
  addRoute: (app, method, path, handler) =>
    Effect.runPromise(
      app.add(method, path as `/${string}`, (serverRequest: HttpServerRequest.HttpServerRequest) =>
        Effect.promise(async () => {
          const result = await handler(serverRequest);
          // Only a number is a status: the suite's own routes return bodies like `{ status: 'ok' }`.
          return typeof result?.status === 'number'
            ? HttpServerResponse.jsonUnsafe(result.body ?? {}, { status: result.status })
            : HttpServerResponse.jsonUnsafe(result);
        }),
      ),
    ),
  executeRequest: (app, method, url, options = {}) =>
    fetchStatus(
      app,
      new Request(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...(options.body ? { body: options.body } : {}),
      }),
    ),
});

createMultipartTestSuite({
  suiteName: 'Effect server adapter (multipart)',
  setupAdapter: async (context, options) => {
    const app = createRouter();
    const adapter = new MastraServer({
      app,
      mastra: context.mastra,
      taskStore: context.taskStore,
      bodyLimitOptions: options?.bodyLimitOptions,
    });
    await adapter.init();
    return { adapter, app };
  },
  startServer: async app => {
    const server = await onNodeServer(app);
    return { baseUrl: server.origin, cleanup: server.close };
  },
  registerRoute: (adapter, app, route, options) => adapter.registerRoute(app, route, options ?? { prefix: '' }),
  getContextMiddleware: adapter => adapter.createContextMiddleware(),
  // Nothing to apply: Effect has no `derive`, so the adapter builds the context inside each route.
  applyMiddleware: () => {},
});

createMCPTransportTestSuite({
  suiteName: 'Effect server adapter (MCP transports)',
  createServer: async mastra => {
    const app = createRouter();
    await new MastraServer({ app, mastra }).init();
    const server = await onNodeServer(app);
    return { server: { close: () => void server.close() }, port: server.port };
  },
});
