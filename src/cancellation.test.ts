/**
 * Whether a client that goes away stops the work it asked for.
 *
 * Mastra hands every route an `abortSignal`, and agents pass it to their model calls. On a Node
 * server it never fired: the Web request the adapter built had no signal tied to the connection, so
 * an abandoned generation ran — and spent tokens — to the end. It failed here before the fix.
 */
import { Mastra } from '@mastra/core';
import { createRoute } from '@mastra/server/server-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MastraServer, createRouter, type EffectRouter } from './index';
import { onNodeServer, viaFetchHandler, type NodeServer } from './test-support';

/** What each route's `abortSignal` looked like when the route finished, by request id. */
const seen = new Map<string, { aborted: boolean }>();

const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
};

let router: EffectRouter;
let node: NodeServer;

beforeAll(async () => {
  router = createRouter();
  const adapter = new MastraServer({ app: router, mastra: new Mastra({}) });
  await adapter.init();

  // Works for up to three seconds, or until told to stop.
  await adapter.registerRoute(
    router,
    createRoute({
      method: 'GET',
      path: '/test/slow/:id',
      responseType: 'json',
      handler: async ({ id, abortSignal }: { id: string; abortSignal: AbortSignal }) => {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 3_000);
          abortSignal.addEventListener('abort', () => (clearTimeout(timer), resolve(undefined)));
        });
        seen.set(id, { aborted: abortSignal.aborted });
        return { ok: true };
      },
    } as never),
  );

  // Streams a chunk every 50ms for a second, the way an agent streams its answer.
  await adapter.registerRoute(
    router,
    createRoute({
      method: 'GET',
      path: '/test/stream/:id',
      responseType: 'stream',
      handler: async ({ id, abortSignal }: { id: string; abortSignal: AbortSignal }) => {
        abortSignal.addEventListener('abort', () => seen.set(id, { aborted: true }));
        let sent = 0;
        return new ReadableStream({
          async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 50));
            if (++sent > 20) controller.close();
            else controller.enqueue({ type: 'text-delta', sent });
          },
        });
      },
    } as never),
  );

  node = await onNodeServer(router);
});

afterAll(() => node.close());
beforeEach(() => seen.clear());

describe('a client that disconnects mid-request', () => {
  it.each([
    ['on a Node server', (request: Request, signal: AbortSignal) => node.send(request, signal)],
    [
      'in a fetch handler',
      (request: Request, signal: AbortSignal) => viaFetchHandler(router, new Request(request, { signal })),
    ],
  ] as const)("should abort the route's work %s", async (where, send) => {
    // GIVEN a route that works until its abortSignal says stop
    const id = `slow-${where}`;
    const client = new AbortController();

    // WHEN the client gives up partway
    const pending = send(new Request(`http://localhost/api/test/slow/${id}`), client.signal).catch(() => 'gone');
    setTimeout(() => client.abort(), 150);
    await pending;
    await until(() => seen.has(id));

    // THEN the route should have been told, instead of running to the end
    expect(seen.get(id)).toEqual({ aborted: true });
  });
});

describe('a client that stops reading a streamed answer', () => {
  it("should abort the route's work on a Node server", async () => {
    // GIVEN a route streaming its answer bit by bit
    const id = 'stream-node';
    const client = new AbortController();
    const response = await node.send(new Request(`http://localhost/api/test/stream/${id}`), client.signal);
    const reader = response.body!.getReader();

    // WHEN the client reads a little, then disconnects
    await reader.read();
    client.abort();
    await until(() => seen.has(id));

    // THEN the route should be told to stop producing
    expect(seen.get(id)).toEqual({ aborted: true });
  });
});

describe('a request that completes normally', () => {
  it('should never see its abortSignal fire', async () => {
    // GIVEN a route that finishes on its own
    const id = 'completes';
    const response = await node.send(new Request(`http://localhost/api/test/stream/${id}`));

    // WHEN its whole answer has been read
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 100));

    // THEN nothing should have aborted it after the fact
    expect(seen.has(id)).toBe(false);
  });
});
