/**
 * Mastra's published conformance suites, run against the Effect adapter.
 *
 * `createRouteAdapterTestSuite` iterates SERVER_ROUTES live rather than a hand-written list, so
 * this is what lets the README claim route parity instead of "tested against the routes I thought of".
 */
import type { AdapterSetupOptions, AdapterTestContext, HttpRequest, HttpResponse } from '@mastra/server-adapters-test-suite';
import { createMCPRouteTestSuite, createRouteAdapterTestSuite } from '@mastra/server-adapters-test-suite';

import { MastraServer, createRouter, toWebHandler, type EffectRouter } from './index';

/** One web handler per router; the router is mutable, so later registrations stay visible. */
const handlers = new WeakMap<object, ReturnType<typeof toWebHandler>>();

function handlerFor(router: EffectRouter) {
  let handler = handlers.get(router);
  if (!handler) {
    handler = toWebHandler(router);
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
