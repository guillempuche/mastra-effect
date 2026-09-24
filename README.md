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

This removes that. Mastra's routes join your Effect server: one port, one router, one middleware
stack. Because the adapter binds to a live `HttpRouter` **service** rather than a Layer, you hand it
the router you already own — Mastra does not take the server over. A client that disconnects cancels
the Mastra work it started, so an abandoned agent stops calling its model, and with a tracer
installed every request gets a server span carrying its route pattern.

What does not cross over: Mastra's agents, tools and workflow steps run as ordinary promises, outside
the request's fiber. They cannot `yield*` your Effect services, and their own work does not nest
under the request's span. To reach your services from inside Mastra, run them through one shared
runtime:

```ts
const runtime = ManagedRuntime.make(AppServicesLive);

const findUser = createTool({
  id: 'find-user',
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => runtime.runPromise(Users.find(id)),
});
```

## Install

```bash
pnpm add @guillem_puche/mastra-effect effect@rc @mastra/core zod
```

`effect@rc` matters: `effect@latest` is still v3, which has no `effect/unstable/http`, and the
install will succeed and then fail at runtime. Requires Node >= 22.13, `effect@>=4.0.0-rc.117` and
`@mastra/core@>=1.68.0`.

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
`toWebHandler(router)` returns `{ handler, dispose }`. `handler(request)` answers a Web `Request` with
a `Response`. Its optional second argument is an Effect `Context`, so give a framework that passes a
second argument of its own — Next.js does — `request => handler(request)` instead. Effect logs every
request it answers; `toWebHandler(router, { disableLogger: true })` turns that off. `dispose()`
releases the handler, not Mastra.

## Examples

Each example is a small runnable app with its own README, and runs with no API keys, no database and
no containers. CI runs every example's tests, so none of them can quietly stop working.

| I want to… | Example | Open first |
|---|---|---|
| serve Mastra on Effect, and nothing else | [`minimal`](examples/minimal) | [`server.ts`](examples/minimal/src/server.ts) |
| add Mastra next to my own Effect routes | [`alongside-your-routes`](examples/alongside-your-routes) | [`server.ts`](examples/alongside-your-routes/src/server.ts) |
| keep Mastra behind one route, with middleware for Mastra only | [`mounted-as-one-route`](examples/mounted-as-one-route) | [`server.ts`](examples/mounted-as-one-route/src/server.ts) |
| use Mastra from Bun, Deno, Workers or Next.js, with no Effect server | [`fetch-handler`](examples/fetch-handler) | [`handler.ts`](examples/fetch-handler/src/handler.ts) |
| share one sign-in (Better Auth) between my app and Mastra | [`full-app`](examples/full-app) | [`auth.ts`](examples/full-app/src/auth.ts) |
| serve Mastra's agents and tools over MCP | [`full-app`](examples/full-app) | [`mastra.ts`](examples/full-app/src/mastra.ts) |
| export traces and logs with OpenTelemetry, locally or to a vendor | [`full-app`](examples/full-app) | [`observability.ts`](examples/full-app/src/observability.ts) |
| show interactive API docs (Scalar) for Mastra's routes | [`full-app`](examples/full-app) | [`scalar.ts`](examples/full-app/src/scalar.ts) |

```bash
cd examples/minimal   # or any other
pnpm test
pnpm dev              # http://localhost:3000 — every example except fetch-handler, which has no server
```

### One router, or Mastra as one route?

By default Mastra does not bring a router of its own: it adds each of its ~400 routes to *your*
router, next to your routes, so one middleware stack covers everything. That is what Mastra's
adapters for Hono, Express, Fastify and Koa do, and it is what
[`alongside-your-routes`](examples/alongside-your-routes) shows.

Effect can also keep Mastra behind a single route — its own router, forwarded from `/api/*` — so
middleware and Mastra's request log cover Mastra alone. The trade-off: Mastra's custom API routes
live outside `/api` and each needs a forward of its own. [`mounted-as-one-route`](examples/mounted-as-one-route)
shows it and compares the two.

## API

| Export | Purpose |
|---|---|
| `createMastraServer(options)` | Builds a router, constructs the adapter, runs `init()`. Returns `{ router, adapter }` |
| `createRouter(config?)` | An empty `HttpRouter` to hand to `new MastraServer({ app })`. Takes a partial `FindMyWay.RouterConfig` |
| `MastraServer` | The adapter itself, for when you own the router and the lifecycle |
| `toWebHandler(router, options?)` | `{ handler, dispose }` — a fetch handler over a populated router. `options.disableLogger` stops Effect logging each request |
| `EffectRouter`, `EffectRequestContext`, `CreateMastraServerOptions`, `ToolsInput` | Types |

## Status

Alpha. The route surface is verified against Mastra's published conformance suites
([`@mastra/server-adapters-test-suite`](https://www.npmjs.com/package/@mastra/server-adapters-test-suite)),
which iterate the live `SERVER_ROUTES` table rather than a hand-written list — so the check tracks
Mastra's routes as they move rather than a snapshot of them.

| Suite | Status |
|---|---|
| `createRouteAdapterTestSuite` | passing |
| `createMCPRouteTestSuite` | passing |
| `createBodyLimitTestSuite` | passing |
| `createHttpLoggingTestSuite` | passing |
| `createMultipartTestSuite` | passing |
| `createMCPTransportTestSuite` | passing |

CI runs them on Node 22.13 and 24 against the newest Mastra, and again against the oldest Mastra
the package declares. MCP is tested with servers from both `@mastra/mcp` 1.x and 2.x. The adapter's own tests add what the suites
do not reach: a disconnecting client cancelling Mastra's work, streamed answers, request bodies
already read by middleware, cookies and session refresh. The examples exercise auth, OpenAPI, the
docs page, OpenTelemetry export, both ways of attaching Mastra to a router and the fetch handler end
to end.

### Differences from the official adapters

- **`server.middleware` and `mastra.setServerMiddleware()` are not run.** They take Hono middleware
  (`(c, next) => …`), which only `@mastra/hono` can execute; Mastra logs a warning and skips them, as
  it does under Express, Fastify and Koa. Add Effect middleware to the router instead
  (`router.addGlobalMiddleware`).
- **Cookies pass through Effect's cookie model.** Attributes it does not have — anything beyond
  Domain, Path, Expires, Max-Age, HttpOnly, Secure, SameSite, Priority and Partitioned — are dropped,
  and a cookie whose value cannot be sent is dropped with a warning instead of failing the response.
- **A trailing slash still matches** (`/api/agents/`), as under `@mastra/elysia`; `@mastra/hono`
  answers 404.

## Effect version support

Tracks the `rc` line, not the frozen `beta` line. Every API this adapter depends on is asserted at
compile time in `src/effect-api-gate.ts`, so an incompatible Effect upgrade fails `tsc` instead of
failing subtly at runtime.

Two behaviours differ from what you might expect coming from the Effect beta or from stock
`find-my-way`:

- Effect vendors its own FindMyWay, which defaults `ignoreDuplicateSlashes` to **true**. This adapter
  forces it off, so `/api//agents` 404s instead of being served as `/api/agents`.
- Routes differing only in their path-parameter name at the same segment — Mastra has four such
  pairs — register and dispatch correctly, binding the right name to each. The positional rewrite
  that `@mastra/elysia` needs is unnecessary here.

## License

Apache-2.0 — matching Mastra, from whose in-tree adapters parts of this one are derived. See
[NOTICE](NOTICE) for what was carried over and from where. Effect itself is MIT and is a peer
dependency, not redistributed here.
