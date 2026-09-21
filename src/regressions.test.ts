/**
 * Regression tests for defects the conformance suites do not reach.
 *
 * Each of these was a real bug found by review; the suites passed throughout, so without these
 * tests nothing would catch a reintroduction.
 */
import { createRoute } from '@mastra/server/server-adapter';
import { createDefaultTestContext } from '@mastra/server-adapters-test-suite';
import { beforeAll, describe, expect, it } from 'vitest';

import { MastraServer, createRouter, toWebHandler, type EffectRouter } from './index';

let router: EffectRouter;
let adapter: MastraServer;

beforeAll(async () => {
  const context = await createDefaultTestContext();
  router = createRouter();
  adapter = new MastraServer({
    app: router,
    mastra: context.mastra,
    tools: context.tools,
    taskStore: context.taskStore,
  });
  await adapter.init();
});

const send = async (request: Request) => {
  const { handler, dispose } = toWebHandler(router);
  try {
    return await handler(request);
  } finally {
    await dispose();
  }
};

describe('error status outside 200-599', () => {
  it('answers 500 instead of throwing a RangeError out of the catch-all', async () => {
    // `new Response(null, { status: 0 })` throws RangeError. Reached from handleRoute's catch,
    // that escaped a method contracted to never reject and became an Effect defect.
    await adapter.registerRoute(
      router,
      createRoute({
        method: 'GET',
        path: '/test/zero-status',
        responseType: 'json',
        handler: async () => {
          throw Object.assign(new Error('upstream aborted'), { status: 0 });
        },
      }),
    );

    const response = await send(new Request('http://localhost/api/test/zero-status'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'upstream aborted' });
  });
});

describe('body limit without a declared Content-Length', () => {
  it('rejects an oversized streamed body that declares no length', async () => {
    await adapter.registerRoute(
      router,
      createRoute({
        method: 'POST',
        path: '/test/limited',
        responseType: 'json',
        maxBodySize: 100,
        handler: async () => ({ ok: true }),
      }),
    );

    const payload = JSON.stringify({ blob: 'x'.repeat(500) });
    const streamed = new Request('http://localhost/api/test/limited', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
      duplex: 'half',
    });

    // The premise of the test: with a stream body there is no Content-Length to gate on, so only
    // measuring what arrived can enforce the cap.
    expect(streamed.headers.get('content-length')).toBeNull();

    expect((await send(streamed)).status).toBe(413);
  });

  it('still rejects on the declared length, without reading the body', async () => {
    const response = await send(
      new Request('http://localhost/api/test/limited', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '5000' },
        body: JSON.stringify({ blob: 'x'.repeat(500) }),
      }),
    );

    expect(response.status).toBe(413);
  });

  it('lets a body under the cap through', async () => {
    const response = await send(
      new Request('http://localhost/api/test/limited', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blob: 'ok' }),
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe('unsupported HTTP methods', () => {
  it('names the offending route instead of registering an unmatchable method', async () => {
    await expect(
      adapter.registerRoute(
        router,
        // HEAD is absent from Mastra's table today, so a blanket cast would fail silently later.
        { method: 'HEAD', path: '/test/head', responseType: 'json', handler: async () => ({}) } as never,
      ),
    ).rejects.toThrow(/Unsupported HTTP method "HEAD" for route \/test\/head/);
  });
});
