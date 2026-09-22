# Mastra on an Effect HTTP server

`@guillem_puche/mastra-effect` runs [Mastra](https://mastra.ai) — AI agents, workflows, memory, tools
and MCP — inside an [Effect](https://effect.website) v4 HTTP server, instead of Hono, Express,
Fastify, Koa, NestJS or Elysia.

It registers Mastra's whole server route table onto an Effect `HttpRouter`, so Mastra's routes sit
alongside your own on one port, one router and one middleware stack. A community adapter, maintained
out of tree, verified against Mastra's own published conformance suites.

## Why

Mastra ships adapters for the popular Node frameworks, but not for Effect. Without one, an Effect
application that wants agents has to run Mastra as a second process behind its own server, and then
reconcile two routers, two sets of middleware and two ideas of what a request is.

This removes that. Your app keeps its Effect server, its `Layer` graph, its fiber-based cancellation
and its tracing, and Mastra's routes become part of it. Because the adapter binds to a live
`HttpRouter` **service** rather than a Layer, you hand it the router you already own — Mastra does
not take the server over.

## Install

```bash
pnpm add @guillem_puche/mastra-effect effect@rc @mastra/core zod
```

`effect@rc` matters: `effect@latest` is still v3, which has no `effect/unstable/http`, and the
install will succeed and then fail at runtime. Requires Node >= 22.13 and `effect@>=4.0.0-rc.116`.

To let Effect own the server, as below, add `@effect/platform-node` at the same `rc` version.

## Quick start

```ts
import { createServer } from 'node:http';

import { NodeHttpServer } from '@effect/platform-node';
import { createMastraServer } from '@guillem_puche/mastra-effect';
import { Effect, Layer } from 'effect';
import { HttpServer } from 'effect/unstable/http';

import { mastra } from './mastra';

const { router } = await createMastraServer({ mastra });

const server = HttpServer.serve()(router.asHttpEffect()).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
);

await Effect.runPromise(Layer.launch(server));
```

Mastra now answers on `http://localhost:3000/api/*`.

To add your own routes, or to mount something else like an auth handler, create the router yourself
and hand the same instance to the adapter:

```ts
import { MastraServer, createRouter } from '@guillem_puche/mastra-effect';
import { Effect } from 'effect';
import { HttpServerResponse } from 'effect/unstable/http';

const router = createRouter();

await Effect.runPromise(router.add('GET', '/healthz', HttpServerResponse.text('ok')));

const adapter = new MastraServer({ app: router, mastra, prefix: '/api' });
await adapter.init();
```

If you would rather embed Mastra in an existing fetch-based setup than run an Effect server,
`toWebHandler(router)` returns `{ handler, dispose }`, where `handler` is a plain
`(request: Request) => Promise<Response>`. Call `dispose()` on shutdown.

## A complete, working example

**[`examples/mastra-in-an-effect-server`](examples/mastra-in-an-effect-server)** is a runnable
application, not a snippet. It starts with no database, no API keys and no containers:

```bash
cd examples/mastra-in-an-effect-server
pnpm test   # BDD tests covering the whole thing
pnpm dev    # http://localhost:3000
```

It wires up, on one router:

| Path | Served by |
|---|---|
| `/healthz` | the app, as a plain Effect route |
| `/auth/*` | [Better Auth](https://better-auth.com), via `HttpEffect.fromWebHandler` |
| `/api/*` | Mastra — agents, workflows, memory, MCP, ~400 routes |
| `/api/openapi.json` | Mastra, generated from its own route table |
| `/docs` | [Scalar](https://scalar.com), rendering that document |

It also shows one Better Auth instance shared between the Effect app and Mastra (session cookies
*and* bearer tokens both reach Mastra's routes), MCP served by Mastra, and OpenTelemetry that exports
to a local viewer or a cloud vendor by environment variable alone.

## API

| Export | Purpose |
|---|---|
| `createMastraServer(options)` | Builds a router, constructs the adapter, runs `init()`. Returns `{ router, adapter }` |
| `createRouter(config?)` | An empty `HttpRouter` to hand to `new MastraServer({ app })`. Takes a partial `FindMyWay.RouterConfig` |
| `MastraServer` | The adapter itself, for when you own the router and the lifecycle |
| `toWebHandler(router)` | `{ handler, dispose }` — a fetch handler over a populated router |
| `EffectRouter`, `EffectRequestContext`, `CreateMastraServerOptions` | Types |

## Status

Alpha. The route surface is verified against Mastra's published conformance suites
([`@mastra/server-adapters-test-suite`](https://www.npmjs.com/package/@mastra/server-adapters-test-suite)),
which iterate the live `SERVER_ROUTES` table rather than a hand-written list — so the check tracks
Mastra's routes as they move rather than a snapshot of them.

| Suite | Status |
|---|---|
| `createRouteAdapterTestSuite` | passing |
| `createMCPRouteTestSuite` | passing |
| `createBodyLimitTestSuite` | not yet wired |
| `createHttpLoggingTestSuite` | not yet wired |
| `createMultipartTestSuite` | not yet wired |
| `createMCPTransportTestSuite` | not yet wired |

The example exercises auth, OpenAPI and the docs page end to end. Streaming, the MCP transports and
multipart are covered by the suites above that are not yet wired — treat them as unverified.

## Effect version support

Tracks the `rc` line, not the frozen `beta` line. Every API this adapter depends on is asserted at
compile time in `src/effect-api-gate.ts`, so an incompatible Effect upgrade fails `tsc` instead of
failing subtly at runtime.

Two behaviours differ from what you might expect coming from the Effect beta or from stock
`find-my-way`:

- Effect vendors its own FindMyWay, which defaults `ignoreDuplicateSlashes` to **true**. This adapter
  forces it off, so `/api//agents` 404s, matching every other Mastra adapter.
- Routes differing only in their path-parameter name at the same segment — Mastra has four such
  pairs — register and dispatch correctly, binding the right name to each. The positional rewrite
  that `@mastra/elysia` needs is unnecessary here.

## License

Apache-2.0 — matching Mastra, from whose in-tree adapters parts of this one are derived. See
[NOTICE](NOTICE) for what was carried over and from where. Effect itself is MIT and is a peer
dependency, not redistributed here.
