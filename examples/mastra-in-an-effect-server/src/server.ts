import { createServer } from 'node:http';

import { MastraServer, createRouter, type EffectRouter } from '@guillem_puche/mastra-effect';
import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { HttpEffect, HttpServer, HttpServerResponse } from 'effect/unstable/http';

import { createAuth } from './auth';
import { createMastra } from './mastra';
import { recordRequests, telemetryLayer } from './observability';
import { scalarPage } from './scalar';

export interface BuildOptions {
  readonly baseURL?: string;
  readonly secret?: string;
  readonly prefix?: string;
}

/**
 * Assembles the whole server, in the order the routes are matched.
 *
 * The app owns the router. Mastra is handed that same instance rather than creating its own, which
 * is what lets the app's routes, Better Auth and Mastra's ~400 routes share one port, one router
 * and one middleware stack.
 */
export async function buildServer(options: BuildOptions = {}): Promise<EffectRouter> {
  const baseURL = options.baseURL ?? 'http://localhost:3000';
  const prefix = options.prefix ?? '/api';

  const auth = createAuth({ baseURL, secret: options.secret ?? 'example-secret-do-not-ship' });
  const mastra = createMastra(auth);

  const router = createRouter();

  // Registered before anything else on purpose. Middleware that answers a request itself hides
  // everything registered after it, and a refused request is the one most worth a record.
  recordRequests(router);

  // The app's own Effect-native routes.
  await Effect.runPromise(router.add('GET', '/healthz', HttpServerResponse.text('ok')));

  // Interactive docs over the OpenAPI document Mastra generates below.
  await Effect.runPromise(
    router.add(
      'GET',
      '/docs',
      HttpServerResponse.html(scalarPage({ specUrl: `${prefix}/openapi.json`, title: 'Mastra API' })),
    ),
  );

  // Better Auth's own endpoints, hosted as a foreign fetch handler. `fromWebHandler` exists for
  // exactly this: running a non-Effect handler inside an Effect router.
  //
  // orDie because fromWebHandler's error channel is HttpServerError, and a route handler may not
  // surface a typed error — `add` is only runnable once its error channel is `never`.
  await Effect.runPromise(
    router.add('*', '/auth/*', Effect.orDie(HttpEffect.fromWebHandler(request => auth.handler(request)))),
  );

  // Mastra registers its whole route table onto the same router. `openapiPath` makes it publish the
  // spec that /docs renders.
  const adapter = new MastraServer({ app: router, mastra, prefix, openapiPath: '/openapi.json' });
  await adapter.init();

  return router;
}

/**
 * Serves the assembled router on Node.
 *
 * The telemetry layer is merged rather than only provided: a layer can pass a service down to what
 * it builds, or hand it back to whoever builds on top, and those are different things that look
 * identical to the compiler. Provided without merging, the process boots, reports that export is
 * enabled, and sends none of its own lines.
 */
export const serve = (router: EffectRouter, port: number) =>
  HttpServer.serve()(router.asHttpEffect()).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
    Layer.merge(telemetryLayer({ serviceName: 'mastra-in-an-effect-server' })),
  );

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const port = Number(process.env.PORT ?? 3000);
  const router = await buildServer({ baseURL: `http://localhost:${port}` });
  await Effect.runPromise(Layer.launch(serve(router, port)) as Effect.Effect<never, unknown, never>);
}
