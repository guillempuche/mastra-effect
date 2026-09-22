# @guillem_puche/mastra-effect

A [Mastra](https://mastra.ai) server adapter for [Effect](https://effect.website)'s v4 HTTP layer
(`effect/unstable/http`), maintained out of tree.

It registers Mastra's full server route table onto an Effect `HttpRouter`, so a Mastra app can be
served from an Effect HTTP server instead of Hono, Express, Fastify, Koa, NestJS or Elysia.

## Status

Alpha. The route surface is verified against Mastra's own published conformance suites
([`@mastra/server-adapters-test-suite`](https://www.npmjs.com/package/@mastra/server-adapters-test-suite)),
which iterate the live `SERVER_ROUTES` table rather than a hand-written list.

| Suite | Status |
|---|---|
| `createRouteAdapterTestSuite` | passing |
| `createMCPRouteTestSuite` | passing |
| `createBodyLimitTestSuite` | not yet wired |
| `createHttpLoggingTestSuite` | not yet wired |
| `createMultipartTestSuite` | not yet wired |
| `createMCPTransportTestSuite` | not yet wired |

Not yet exercised against a real Mastra application — only against the suites. Treat streaming,
MCP transports and multipart as unverified until that lands.

## Install

```bash
pnpm add @guillem_puche/mastra-effect effect@rc @mastra/core zod
```

Requires Node >= 22.13 and `effect@>=4.0.0-rc.116`.

## Usage

```ts
import { createMastraServer, toWebHandler } from '@guillem_puche/mastra-effect';
import { mastra } from './mastra';

const { router } = await createMastraServer({ mastra });
const { handler, dispose } = toWebHandler(router);

// handler: (request: Request) => Promise<Response>
const response = await handler(new Request('http://localhost/api/agents'));
```

`handler` is a plain fetch handler, so serve it with whatever bridges fetch to your runtime — on
Node that means a fetch-to-server adaptor such as `@hono/node-server` (not a dependency of this
package; install it yourself), and on Bun or Deno it goes straight into `Bun.serve` / `Deno.serve`.
Call `dispose()` on shutdown to release the underlying Effect layer.

Alternatively, skip `toWebHandler` entirely and compose the router into an Effect HTTP server with
`router.asHttpEffect()`.

`createMastraServer` builds a router, constructs the adapter and runs `init()`, which registers every
Mastra route plus any custom API routes. To own those steps yourself:

```ts
import { MastraServer, createRouter } from '@guillem_puche/mastra-effect';

const router = createRouter();
const adapter = new MastraServer({ app: router, mastra, prefix: '/api' });
await adapter.init();
```

`createRouter` accepts a partial `FindMyWay.RouterConfig` if you need to override matching behaviour.

## Effect version support

Pinned to the `rc` line (`4.0.0-rc.116`), not the frozen `beta` line. The APIs this adapter depends on
are asserted at compile time in `src/effect-api-gate.ts`, so an incompatible Effect upgrade fails
`tsc` rather than failing subtly at runtime.

Two behaviours differ from what you might expect coming from the Effect beta or from stock
`find-my-way`:

- Effect vendors its own FindMyWay, which defaults `ignoreDuplicateSlashes` to **true**. This adapter
  forces it off so `/api//agents` 404s, matching every other Mastra adapter.
- Routes that differ only in their path-parameter name at the same segment (Mastra has four such
  pairs) register and dispatch correctly, binding the right name to each route. The positional
  rewrite that `@mastra/elysia` needs is unnecessary here.

## License

Apache-2.0 — matching Mastra, from whose in-tree adapters parts of this one are derived. See
[NOTICE](NOTICE) for what was carried over and from where. Effect itself is MIT and is a peer
dependency, not redistributed here.
