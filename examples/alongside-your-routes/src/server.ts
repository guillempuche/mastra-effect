/**
 * Use case: your Effect app has routes of its own, and Mastra's should sit next to them.
 *
 * The app creates the router and hands the same instance to Mastra. Mastra then adds each of its
 * routes to that router one by one — it does not bring a router of its own, and it is not one
 * route. The result is one router holding everything, so one middleware stack covers every route.
 *
 * If you would rather keep Mastra behind a single route of its own, see ../mounted-as-one-route.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { NodeHttpServer } from '@effect/platform-node';
import { MastraServer, createRouter, type EffectRouter } from '@guillem_puche/mastra-effect';
import type { Mastra } from '@mastra/core';
import { Effect, Layer } from 'effect';
import { HttpEffect, HttpRouter, HttpServer, HttpServerResponse } from 'effect/unstable/http';

import { createMastra } from './mastra.ts';

export interface Server {
  readonly router: EffectRouter;
  /** Exposed so a caller can reach Mastra's agents and workflows directly. */
  readonly mastra: Mastra;
}

export async function buildServer(): Promise<Server> {
  const mastra = createMastra();
  const router = createRouter();

  // A middleware added to the router wraps every route on it: the app's and Mastra's alike.
  //
  // It stamps through a pre-response handler, which runs on whatever answer is sent, rather than by
  // mapping the response a route produces. Not every answer is such a response: a request no route
  // matches, or a Mastra route that fails with a server error, fails in Effect instead, and
  // `Effect.map` never sees it. Effect's own CORS middleware adds its headers the same way, for the
  // same reason.
  Effect.runSync(
    router.addGlobalMiddleware(httpEffect =>
      Effect.andThen(
        HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, 'x-served-by', 'effect')),
        ),
        httpEffect,
      ),
    ),
  );

  // The app's own routes. Registration order does not decide which route answers: the router
  // matches the most specific path, so these could equally be added after Mastra's.
  await Effect.runPromise(router.add('GET', '/healthz', HttpServerResponse.text('ok')));
  await Effect.runPromise(
    router.add(
      'GET',
      '/users/:id',
      Effect.map(HttpRouter.params, ({ id }) => HttpServerResponse.jsonUnsafe({ id })),
    ),
  );

  // Mastra adds its routes to the same router: ~400 under /api, plus its custom routes (/hooks/*).
  const adapter = new MastraServer({ app: router, mastra, prefix: '/api' });
  await adapter.init();

  return { router, mastra };
}

export const serve = (router: EffectRouter, port: number) =>
  HttpServer.serve()(router.asHttpEffect()).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
  );

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const { router } = await buildServer();
  await Effect.runPromise(Layer.launch(serve(router, port)));
}
