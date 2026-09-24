/**
 * Use case: keep Mastra behind one route of its own, separate from the app's routes.
 *
 * Mastra gets a router of its own. The app's router forwards `/api/*` to it as a single route, the
 * way it would forward to any sub-application. Because everything Mastra serves passes through
 * that one forward, anything wrapped around it — here an API-key check — covers Mastra and nothing
 * else, and Mastra's request log never sees the app's routes.
 *
 * The cost: Mastra's custom API routes cannot live under `/api` (Mastra rejects that), so each of
 * their path prefixes needs a forward of its own. Forget one and those routes answer 404.
 *
 * If you would rather have one router holding everything, see ../alongside-your-routes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { NodeHttpServer } from '@effect/platform-node';
import { MastraServer, createRouter, type EffectRouter } from '@guillem_puche/mastra-effect';
import type { Mastra } from '@mastra/core';
import { Effect, Layer, type Scope } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { createMastra } from './mastra.ts';

export interface BuildOptions {
  /** The key every request to `/api/*` must send in `x-api-key`. Must not be blank. */
  readonly apiKey: string;
  /** Path prefixes of Mastra's custom API routes, each forwarded to Mastra. */
  readonly customRoutePrefixes?: ReadonlyArray<`/${string}`>;
}

export interface Server {
  readonly router: EffectRouter;
  /** Exposed so a caller can reach Mastra's agents and workflows directly. */
  readonly mastra: Mastra;
}

type Handler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

/**
 * Compares two secrets without leaking, through response timing, how much of a guess was right.
 * Hashing first gives both sides the same length, which `timingSafeEqual` requires.
 */
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

/** Lets a request through to `inner` only when it carries the right `x-api-key`. */
const requireApiKey = (apiKey: string, inner: Handler): Handler =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, request => {
    const given = request.headers['x-api-key'];
    if (given !== undefined && sameSecret(given, apiKey)) return inner;
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: 'Missing or wrong x-api-key' }, { status: 401 }));
  });

export async function buildServer(options: BuildOptions): Promise<Server> {
  const { apiKey } = options;
  const customRoutePrefixes = options.customRoutePrefixes ?? ['/hooks'];

  // Refused at startup rather than discovered in production. A blank key would let every request
  // that sends a blank `x-api-key` straight through the check.
  if (apiKey.trim() === '') throw new Error('apiKey must not be blank');
  for (const prefix of customRoutePrefixes) {
    // `/hooks/` would register `/hooks//*`, which only a request with a doubled slash matches —
    // `/hooks/echo` would answer 404 with nothing to say why.
    if (prefix.endsWith('/')) throw new Error(`customRoutePrefixes: drop the trailing slash in "${prefix}"`);
  }

  // Mastra's own router, holding only Mastra's routes.
  const mastra = createMastra();
  const mastraRouter = createRouter();
  await new MastraServer({ app: mastraRouter, mastra, prefix: '/api' }).init();

  // Mastra's router as a single handler. It keeps the full URL, so Mastra still matches
  // `/api/agents` rather than `/agents`. orDie because a route handler may not surface a typed
  // error; a path Mastra does not know still answers 404, which the tests pin.
  const toMastra: Handler = Effect.orDie(mastraRouter.asHttpEffect());

  const app = createRouter();
  await Effect.runPromise(app.add('GET', '/healthz', HttpServerResponse.text('ok')));

  // The one route Mastra's API lives behind. `/api/*` also matches `/api` itself.
  await Effect.runPromise(app.add('*', '/api/*', requireApiKey(apiKey, toMastra)));

  // Custom routes are forwarded without the key: they are typically webhooks, called by services
  // that cannot send your key and that authenticate in their own way.
  for (const prefix of customRoutePrefixes) {
    await Effect.runPromise(app.add('*', `${prefix}/*`, toMastra));
  }

  return { router: app, mastra };
}

export const serve = (router: EffectRouter, port: number) =>
  HttpServer.serve()(router.asHttpEffect()).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
  );

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  // No fallback key: a default written in source is a key everyone who can read the source knows.
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error('Set API_KEY, e.g. `API_KEY=secret pnpm dev`');
  const { router } = await buildServer({ apiKey });
  await Effect.runPromise(Layer.launch(serve(router, port)));
}
