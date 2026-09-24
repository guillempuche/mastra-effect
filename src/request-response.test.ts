/**
 * Requests and responses where the adapter departed from @mastra/hono, Mastra's reference adapter.
 *
 * Each case was reproduced before its fix: repeated query keys lost all but the last value; the
 * `requestContext` query parameter was ignored on POST; a chunked upload got past the body limit;
 * cookies sharing a name collapsed, and one Effect cannot serialise left the client waiting; a
 * refreshed session cookie was lost when the route failed, and replaced the route's own cookies;
 * `cause.failingItems` was dropped from errors; a route returning the wrong shape answered 200; a
 * stream failing partway broke the body in a fetch handler; a request no route matched was never
 * logged, nor checked for an unregistered channel webhook; and a request target URL cannot parse
 * failed with a 500 instead of the router's 404.
 */
import { connect } from 'node:net';

import { Mastra } from '@mastra/core';
import type { IMastraLogger } from '@mastra/core/logger';
import { createRoute } from '@mastra/server/server-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { MastraServer, createRouter, type EffectRouter } from './index';
import { onNodeServer, viaFetchHandler, type NodeServer } from './test-support';

let router: EffectRouter;
let adapter: MastraServer;
let node: NodeServer;
let requestLog: MockInstance<IMastraLogger['info']>;
let webhookCheck: MockInstance<(path: string, method: string, status: number) => void>;

const register = (route: Parameters<typeof createRoute>[0]) => adapter.registerRoute(router, createRoute(route as never));

beforeAll(async () => {
  router = createRouter();
  adapter = new MastraServer({
    app: router,
    mastra: new Mastra({ server: { build: { apiReqLogs: true } } } as never),
    bodyLimitOptions: { maxSize: 1_000, onError: () => ({ error: 'too big' }) },
  });
  await adapter.init();

  await register({ method: 'GET', path: '/test/query', responseType: 'json', handler: async ({ tags }: any) => ({ tags }) });
  await register({
    method: 'POST',
    path: '/test/context',
    responseType: 'json',
    handler: async ({ requestContext }: any) => ({ from: requestContext.get('from') ?? null }),
  });
  await register({ method: 'POST', path: '/test/upload', responseType: 'json', handler: async () => ({ ran: true }) });
  await register({
    method: 'GET',
    path: '/test/cookies',
    responseType: 'datastream-response',
    handler: async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'sid=; Path=/; Max-Age=0');
      headers.append('set-cookie', 'sid=; Path=/api; Max-Age=0');
      headers.append('set-cookie', 'bad=a\u0001b; Path=/');
      return new Response('ok', { headers });
    },
  });
  await register({
    method: 'GET',
    path: '/test/own-cookie',
    responseType: 'datastream-response',
    handler: async () => new Response('ok', { headers: { 'set-cookie': 'pref=dark; Path=/' } }),
  });
  await register({
    method: 'GET',
    path: '/test/not-found',
    responseType: 'json',
    handler: async () => {
      throw Object.assign(new Error('no such thing'), { status: 404 });
    },
  });
  await register({
    method: 'GET',
    path: '/test/failing-items',
    responseType: 'json',
    handler: async () => {
      throw Object.assign(new Error('schema breaks items', { cause: { failingItems: [{ id: 'i1' }], secret: 'x' } }), {
        status: 400,
      });
    },
  });
  await register({ method: 'GET', path: '/test/not-a-stream', responseType: 'stream', handler: async () => ({}) });
  await register({ method: 'GET', path: '/test/not-a-response', responseType: 'datastream-response', handler: async () => ({}) });
  await register({
    method: 'GET',
    path: '/test/breaks-midway',
    responseType: 'stream',
    handler: async () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', text: 'first' });
          setTimeout(() => controller.error(new Error('upstream failed')), 20);
        },
      }),
  });

  node = await onNodeServer(router);
  requestLog = vi
    .spyOn((adapter as unknown as { logger: IMastraLogger }).logger, 'info')
    .mockImplementation(() => {});
  webhookCheck = vi.spyOn(adapter as never, 'warnIfUnregisteredChannelWebhook' as never);
});

afterAll(() => node.close());
beforeEach(() => {
  requestLog.mockClear();
  webhookCheck.mockClear();
});

const transports = [
  ['in a fetch handler', (request: Request) => viaFetchHandler(router, request)],
  ['on a Node server', (request: Request) => node.send(request)],
] as const;

const get = (path: string, headers?: Record<string, string>) => new Request(`http://localhost${path}`, { headers });

describe('query parameters', () => {
  it.each(transports)('should keep every value of a repeated key %s', async (_where, send) => {
    // GIVEN a key repeated in the query, which Mastra's schemas accept as an array
    // WHEN the request reaches the route
    const response = await send(get('/api/test/query?tags=a&tags=b'));

    // THEN both values should arrive, not only the last
    expect(await response.json()).toEqual({ tags: ['a', 'b'] });
  });

  it('should keep a key given once as a plain value', async () => {
    const response = await viaFetchHandler(router, get('/api/test/query?tags=a'));

    expect(await response.json()).toEqual({ tags: 'a' });
  });

  it('should read requestContext from the query on a POST as well as a GET', async () => {
    // GIVEN a client that puts its request context in the query
    const request = new Request(`http://localhost/api/test/context?requestContext=${encodeURIComponent('{"from":"query"}')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    // WHEN it posts
    const response = await viaFetchHandler(router, request);

    // THEN the route should see that context, as it would under @mastra/hono
    expect(await response.json()).toEqual({ from: 'query' });
  });
});

/** A 5,000-byte upload streamed with no Content-Length, so nothing can be checked before reading. */
const chunkedUpload = () => {
  const form = new FormData();
  form.append('file', new Blob(['x'.repeat(5_000)]), 'big.txt');
  const encoded = new Request('http://localhost', { method: 'POST', body: form });
  return new Request('http://localhost/api/test/upload', {
    method: 'POST',
    headers: { 'content-type': encoded.headers.get('content-type')! },
    body: encoded.body,
    duplex: 'half',
  } as RequestInit);
};

describe('the body limit', () => {
  it.each(transports)('should refuse a chunked upload over the limit %s', async (_where, send) => {
    // GIVEN a 1,000-byte limit, and a 5,000-byte upload that declares no length
    // WHEN it is posted
    const response = await send(chunkedUpload());

    // THEN it should be refused by counting what arrived
    expect(response.status).toBe(413);
  });
});

describe('Set-Cookie headers', () => {
  it.each(transports)('should keep cookies that share a name, and drop one that cannot be sent %s', async (_where, send) => {
    // GIVEN a route clearing a cookie at two paths, plus one cookie with an invalid value
    // WHEN it answers
    const response = await send(get('/api/test/cookies'));

    // THEN both same-name cookies should arrive, and the request should still be answered
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(['sid=; Max-Age=0; Path=/', 'sid=; Max-Age=0; Path=/api']);
  });
});

describe('a session refreshed during the request', () => {
  beforeEach(() => {
    // Stands in for a transparent session refresh: auth passes and hands back a new cookie.
    vi.spyOn(adapter as unknown as { checkRouteAuth: () => Promise<unknown> }, 'checkRouteAuth').mockResolvedValue({
      headers: { 'set-cookie': 'session=fresh; Path=/' },
    });
  });

  it('should reach the client even when the route then fails', async () => {
    const response = await viaFetchHandler(router, get('/api/test/not-found'));

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual(['session=fresh; Path=/']);
  });

  it("should join the route's own cookies rather than replace them", async () => {
    const response = await viaFetchHandler(router, get('/api/test/own-cookie'));

    expect(response.headers.getSetCookie()).toEqual(['pref=dark; Path=/', 'session=fresh; Path=/']);
  });
});

describe('an error response', () => {
  it('should carry the items that failed, and nothing else from the cause', async () => {
    // GIVEN a route failing with the items that caused it, which Studio's dataset form reads
    const response = await viaFetchHandler(router, get('/api/test/failing-items'));

    // THEN only `failingItems` should be passed on
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'schema breaks items', cause: { failingItems: [{ id: 'i1' }] } });
  });

  it.each([
    ['a stream route returning no stream', '/api/test/not-a-stream'],
    ['a Response route returning something else', '/api/test/not-a-response'],
  ])('should be a 500 for %s, not a 200 with a broken body', async (_case, path) => {
    const response = await viaFetchHandler(router, get(path));

    expect(response.status).toBe(500);
  });
});

describe('a stream that fails partway', () => {
  it.each(transports)('should deliver what was sent, then end cleanly %s', async (_where, send) => {
    // GIVEN a stream that errors after its first chunk
    const response = await send(get('/api/test/breaks-midway'));

    // THEN the first chunk should arrive and the body should close rather than error, as in @mastra/hono
    expect(await response.text()).toContain('first');
  });
});

describe('a request no route matches', () => {
  it("should appear in Mastra's request log with the 404 it gets", async () => {
    await viaFetchHandler(router, get('/api/does-not-exist'));

    expect(requestLog.mock.calls.map(([line]) => line)).toEqual([expect.stringMatching(/^GET \/api\/does-not-exist 404 /)]);
  });

  it('should be checked for a channel webhook nobody registered', async () => {
    await viaFetchHandler(router, new Request('http://localhost/api/agents/a1/channels/slack/webhook', { method: 'POST' }));

    expect(webhookCheck).toHaveBeenCalledWith('/api/agents/a1/channels/slack/webhook', 'POST', 404);
  });
});

/** Sends a request line as written, which `fetch` would refuse to, and resolves with the status. */
const sendRaw = (method: string, target: string) =>
  new Promise<number>((resolve, reject) => {
    let rawResponse = '';
    const socket = connect(node.port, '127.0.0.1', () =>
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),
    );
    socket.on('data', chunk => (rawResponse += chunk.toString()));
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(rawResponse.split(' ')[1])));
  });

describe('a request target that is not a valid URL', () => {
  it.each(['GET', 'POST'])('should get the 404 of a path no route matches, on %s', async method => {
    // GIVEN a target Node accepts but URL cannot parse, as scanners send
    // WHEN it reaches the adapter's middleware, which reads the path of every request
    const status = await sendRaw(method, '//[');

    // THEN it should be answered like any path no route matches, not fail the request with a 500
    expect(status).toBe(404);
    // AND the request log should record it as it arrived
    expect(requestLog.mock.calls.map(([line]) => line)).toEqual([expect.stringMatching(new RegExp(`^${method} //\\[ 404 `))]);
  });
});
