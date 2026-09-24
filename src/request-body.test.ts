/**
 * How request bodies reach Mastra's routes.
 *
 * Three defects lived here, each found by sending real bodies through the adapter: custom routes
 * received a re-serialised body instead of the bytes sent; their permission check ignored fields in
 * the body; and a body that a middleware had already read reached Mastra empty on a Node server and
 * unusable in a fetch handler. Every case below failed before its fix.
 */
import { Mastra } from '@mastra/core';
import { SimpleAuth, registerApiRoute } from '@mastra/core/server';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Effect, Stream } from 'effect';
import { HttpServerRequest } from 'effect/unstable/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MastraServer, createRouter, type EffectRouter } from './index';
import { onNodeServer, viaFetchHandler, type NodeServer } from './test-support';

const greet = createWorkflow({
  id: 'greet',
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
})
  .then(
    createStep({
      id: 'greet',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      execute: async ({ inputData }) => ({ greeting: `Hello, ${inputData.name}!` }),
    }),
  )
  .commit();

/** A custom route that answers with exactly the bytes it received. */
const echoBytes = registerApiRoute('/raw', {
  method: 'POST',
  handler: async c => c.json({ bytes: Array.from(new Uint8Array(await c.req.arrayBuffer())) }),
});

type BodyReader = 'text' | 'json' | 'arrayBuffer' | 'stream';

/** A router whose only middleware reads the whole body in the given way before any route runs. */
const buildRouter = async (mastra: Mastra, reader?: BodyReader): Promise<EffectRouter> => {
  const router = createRouter();
  if (reader) {
    Effect.runSync(
      router.addGlobalMiddleware(app =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, request =>
          Effect.flatMap(
            Effect.orDie(reader === 'stream' ? Stream.runDrain(request.stream) : request[reader]),
            () => app,
          ),
        ),
      ),
    );
  }
  await new MastraServer({ app: router, mastra }).init();
  return router;
};

const post = (path: string, body: string | Uint8Array, contentType = 'application/json', headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': contentType, ...headers }, body });

const received = async (response: Response) =>
  new Uint8Array(((await response.json()) as { bytes: number[] }).bytes);

describe('the body a custom route receives', () => {
  let router: EffectRouter;

  beforeAll(async () => {
    router = await buildRouter(new Mastra({ server: { apiRoutes: [echoBytes] } }));
  });

  it.each([
    ['a signed webhook payload, spacing and all', 'application/json', '{"event": "paid", "amount": 10}'],
    ['JSON with an integer too large for a double', 'application/json', '{"id":12345678901234567890}'],
    ['JSON with a duplicate key', 'application/json', '{"a":1,"a":2}'],
    ['malformed JSON', 'application/json', '{bad'],
    ['whitespace only', 'text/plain', '   '],
  ])('should be exactly the bytes sent — %s', async (_case, contentType, text) => {
    // GIVEN a custom route, which is often a webhook verifying a signature over the raw body
    const sent = new TextEncoder().encode(text);

    // WHEN a body is posted to it
    const response = await viaFetchHandler(router, post('/raw', sent, contentType));

    // THEN the route should get those bytes unchanged — not parsed and re-serialised
    expect(response.status).toBe(200);
    expect(await received(response)).toEqual(sent);
  });

  it('should pass binary bytes through without decoding them as text', async () => {
    // GIVEN bytes that are not valid UTF-8
    const sent = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]);

    // WHEN they are posted to a custom route
    const response = await viaFetchHandler(router, post('/raw', sent, 'application/octet-stream'));

    // THEN every byte should survive
    expect(await received(response)).toEqual(sent);
  });
});

describe("a custom route's permission check", () => {
  let router: EffectRouter;
  const checkedResources: string[] = [];

  beforeAll(async () => {
    router = await buildRouter(
      new Mastra({
        server: {
          auth: new SimpleAuth({ tokens: { 'token-1': { id: 'user-1' } } }),
          // Allows exactly one thread, so an allowed answer proves the right id reached the check.
          fga: {
            check: async (_user: unknown, query: { resource: { id: string } }) => {
              checkedResources.push(query.resource.id);
              return query.resource.id === 'thread-1';
            },
          },
          apiRoutes: [
            registerApiRoute('/threads/rename', {
              method: 'POST',
              requiresAuth: true,
              fga: { resourceType: 'thread', resourceIdParam: 'threadId', permission: 'threads:write' },
              handler: async c => c.json({ renamed: true }),
            }),
          ],
        } as never,
      }),
    );
  });

  const rename = (body: string, contentType = 'application/json') =>
    viaFetchHandler(router, post('/threads/rename', body, contentType, { authorization: 'Bearer token-1' }));

  it.each([
    ['a JSON body', '{"threadId":"thread-1"}', 'application/json'],
    ['a form body', 'threadId=thread-1', 'application/x-www-form-urlencoded'],
  ])('should find the resource id in %s', async (_case, body, contentType) => {
    // GIVEN a route whose permission rule reads the resource id from `threadId`
    // WHEN a signed-in user sends that id in the body
    const response = await rename(body, contentType);

    // THEN the check should see it and allow the request, as it does under @mastra/hono
    expect(response.status).toBe(200);
  });

  it('should still refuse a resource the provider denies', async () => {
    // GIVEN the provider allows thread-1 only
    // WHEN the body names another thread
    const response = await rename('{"threadId":"thread-2"}');

    // THEN the provider's refusal should stand
    expect(response.status).toBe(403);
    expect(checkedResources).toContain('thread-2');
  });
});

describe('a body a middleware has already read', () => {
  const startGreeting = () => post('/api/workflows/greet/start-async', '{"inputData":{"name":"Ada"}}');
  const newMastra = () => new Mastra({ storage: new InMemoryStore(), workflows: { greet }, server: { apiRoutes: [echoBytes] } });

  describe.each(['text', 'json', 'arrayBuffer'] as const)('when it was read as %s', reader => {
    let router: EffectRouter;
    let node: NodeServer;

    beforeAll(async () => {
      router = await buildRouter(newMastra(), reader);
      node = await onNodeServer(router);
    });
    afterAll(() => node.close());

    const transports = [
      ['in a fetch handler', (request: Request) => viaFetchHandler(router, request)],
      ['on a Node server', (request: Request) => node.send(request)],
    ] as const;

    it.each(transports)("should still reach Mastra's built-in route %s", async (_where, send) => {
      // GIVEN a middleware that consumed the body before Mastra's route ran
      // WHEN a workflow is started with input in that body
      const response = await send(startGreeting());

      // THEN Mastra should receive the input and run — not see an empty or unusable body
      expect(response.status).toBe(200);
      expect(((await response.json()) as { result?: { greeting?: string } }).result?.greeting).toBe('Hello, Ada!');
    });

    it.each(transports)('should still reach a custom route byte for byte %s', async (_where, send) => {
      // GIVEN the same middleware
      const sent = new TextEncoder().encode('{"a": 1}');

      // WHEN a custom route is called
      const response = await send(post('/raw', sent));

      // THEN it should get the original bytes
      expect(await received(response)).toEqual(sent);
    });
  });

  describe('when it was drained as a raw stream, which Effect does not keep', () => {
    let router: EffectRouter;
    let node: NodeServer;

    beforeAll(async () => {
      router = await buildRouter(newMastra(), 'stream');
      node = await onNodeServer(router);
    });
    afterAll(() => node.close());

    it.each([
      ['in a fetch handler', (request: Request) => viaFetchHandler(router, request)],
      ['on a Node server', (request: Request) => node.send(request)],
    ] as const)('should fail at once rather than pass on an empty body or hang %s', async (_where, send) => {
      // GIVEN a body that is gone with no copy kept
      // WHEN a route that needs it is called
      const response = await send(startGreeting());

      // THEN the request should fail as a server error, promptly
      expect(response.status).toBe(500);
    });
  });
});
