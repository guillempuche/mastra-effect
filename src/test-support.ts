/**
 * Shared by the test files: the two ways an Effect app serves the adapter's router. Not part of the
 * published entry.
 */
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { HttpServer } from 'effect/unstable/http';

import { toWebHandler, type EffectRouter } from './index';

/** Answers one request through `toWebHandler`, the way a fetch-based host would. */
export const viaFetchHandler = async (router: EffectRouter, request: Request): Promise<Response> => {
  const { handler, dispose } = toWebHandler(router, { disableLogger: true });
  try {
    return await handler(request);
  } finally {
    await dispose();
  }
};

/** Asks the OS for a port nobody is using, then gives it back so the server can take it. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });

/** Serves the router on a real Node HTTP server, the way an Effect app normally runs. */
export const onNodeServer = async (router: EffectRouter) => {
  const port = await freePort();
  const runtime = ManagedRuntime.make(
    HttpServer.serve()(router.asHttpEffect()).pipe(
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
    ),
  );
  await runtime.runPromise(Effect.void);
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    /** A timeout, so a request the server never answers fails the test instead of stalling it. */
    send: (request: Request, signal: AbortSignal = AbortSignal.timeout(5_000)) =>
      fetch(new Request(`${origin}${new URL(request.url).pathname}${new URL(request.url).search}`, request), { signal }),
    close: () => runtime.dispose(),
  };
};

export type NodeServer = Awaited<ReturnType<typeof onNodeServer>>;
