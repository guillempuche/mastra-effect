/**
 * Use case: you want Mastra served by Effect, and nothing else on the server.
 *
 * `createMastraServer` creates the router, adds every Mastra route to it and returns it. The app's
 * only job is to serve that router. When you need routes of your own next to Mastra's, see
 * ../alongside-your-routes instead.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { NodeHttpServer } from '@effect/platform-node';
import { createMastraServer, type EffectRouter } from '@guillem_puche/mastra-effect';
import { Effect, Layer } from 'effect';
import { HttpServer } from 'effect/unstable/http';

import { createMastra } from './mastra.ts';

/** Every Mastra route, under `/api`. */
export async function buildServer(): Promise<EffectRouter> {
  const { router } = await createMastraServer({ mastra: createMastra() });
  return router;
}

/** Serves the router on Node. `Layer.launch` keeps it running until the process is stopped. */
export const serve = (router: EffectRouter, port: number) =>
  HttpServer.serve()(router.asHttpEffect()).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
  );

// Only when run directly (`pnpm dev`), so importing this file in a test never opens a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const router = await buildServer();
  await Effect.runPromise(Layer.launch(serve(router, port)));
}
