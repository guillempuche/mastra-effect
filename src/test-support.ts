/**
 * Shared by the test files: the two ways an Effect app serves the adapter's router. Not part of the
 * published entry.
 */
import { createServer } from 'node:http';

import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { HttpServer } from 'effect/http';

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

/**
 * Serves the router on a real Node HTTP server, the way an Effect app normally runs. `services` is
 * provided to the server, for a test that needs a tracer or other services in place.
 */
export const onNodeServer = async (router: EffectRouter, services: Layer.Layer<never> = Layer.empty) => {
  // Port 0 lets the OS pick a free port as the server binds it. Picking one first and binding it
  // after leaves a gap in which a test file running in parallel can take the same port.
  const runtime = ManagedRuntime.make(
    HttpServer.serve()(router.asHttpEffect()).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0 })),
      Layer.provide(services),
    ),
  );
  const port = await runtime.runPromise(boundPort);
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

/** The port the running server bound. */
const boundPort = Effect.flatMap(Effect.service(HttpServer.HttpServer), server =>
  'port' in server.address ? Effect.succeed(server.address.port) : Effect.die(new Error('not listening on a TCP port')),
);
