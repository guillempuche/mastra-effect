import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { MastraServer, createRouter, type EffectRouter } from '@guillem_puche/mastra-effect';
import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { HttpEffect, HttpServer, HttpServerResponse } from 'effect/unstable/http';

import { createAuth } from './auth.ts';
import { createMastra } from './mastra.ts';
import { recordRequests, telemetryLayer } from './observability.ts';
import { scalarPage } from './scalar.ts';

export interface BuildOptions {
  readonly baseURL?: string;
  readonly secret?: string;
  readonly prefix?: string;
}

/**
 * Assembles the whole server.
 *
 * Registration order does not decide which route answers — the router matches the most specific
 * path — except among global middlewares, where the first registered is the outermost.
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

  // Mastra adds each of its routes to the same router — it does not bring a router of its own. `openapiPath` makes it publish the
  // spec that /docs renders.
  const adapter = new MastraServer({ app: router, mastra, prefix, openapiPath: '/openapi.json' });
  await adapter.init();

  return router;
}

/**
 * Serves the assembled router on Node.
 *
 * The telemetry layer is provided to the server, not merged beside it. The compiler accepts both,
 * but a merged layer is built next to the server rather than underneath it, so the server never
 * sees the tracer or the log exporter: with the endpoint set, the process boots and exports
 * nothing, with no error to say so. Checked against a local OTLP receiver — merged, it received
 * nothing; provided, it received traces and logs.
 */
export const serve = (router: EffectRouter, port: number) =>
  HttpServer.serve()(router.asHttpEffect()).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
    Layer.provide(telemetryLayer({ serviceName: 'example-full-app' })),
  );

// Compare the whole resolved path, not the basename: `endsWith(basename)` also matches any other
// entry point called server.ts, so importing this module would bind a port as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const router = await buildServer({ baseURL: `http://localhost:${port}` });
  await Effect.runPromise(Layer.launch(serve(router, port)));
}
