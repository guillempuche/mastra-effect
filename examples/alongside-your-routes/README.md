# alongside-your-routes

Your Effect app keeps its own routes, and Mastra's routes join them on the same router.

**Use this when** you have (or will have) an Effect app with routes of its own, and want Mastra on
the same server. This is the default way to use the adapter, and it is how Mastra's own adapters for
Hono, Express, Fastify and Koa work too.

**Look elsewhere when** you want Mastra fenced off behind one route with middleware of its own →
[`mounted-as-one-route`](../mounted-as-one-route).

## Run it

```bash
pnpm install          # once, from the repository root
cd examples/alongside-your-routes
pnpm test
pnpm dev              # http://localhost:3000/healthz and http://localhost:3000/api/agents
```

## How it works

A **router** is the table that decides which code answers which URL. Here there is exactly one:

```
                      ┌─ /healthz, /users/:id ───────▶ your routes
request ──▶ router ───┼─ /api/*  (~400 routes) ──────▶ Mastra's built-in routes
  (one middleware     └─ /hooks/echo ────────────────▶ Mastra custom route
   stack wraps all)
```

1. [`src/server.ts`](src/server.ts) creates the router and adds the app's routes.
2. It then hands **that same router** to `new MastraServer({ app: router, … })`. Mastra does not
   bring a router of its own and is not "one route": it adds each of its routes to yours.
3. A middleware added to the router — here, one that stamps `x-served-by: effect` on responses —
   runs on every request, for your routes and Mastra's alike. A request that matches no route at
   all fails instead of producing a response, so there is nothing to stamp: it gets the router's
   plain 404.

The order routes are added in does not matter. The router picks the most specific matching path,
not the first one registered, so your routes could just as well be added after Mastra's.

### Two things to know

**Mastra's custom routes live outside `/api`.** Routes you define in Mastra's config with
`registerApiRoute` (see [`src/mastra.ts`](src/mastra.ts)) cannot start with `/api` — Mastra refuses
them at startup, because `/api` is reserved for its built-in routes. That's why the example uses
`/hooks/echo`.

**Mastra's request log sees your routes too.** Turning on `apiReqLogs` makes Mastra log each
request, and since everything shares one router, that includes `/healthz` and `/users/:id`. Use
`excludePaths` to keep routes out of it, as this example does for `/healthz` — or use
[`mounted-as-one-route`](../mounted-as-one-route), where the log only ever sees Mastra's requests.

## What the tests check

[`src/server.test.ts`](src/server.test.ts): your routes and Mastra's answer from the same router;
the shared middleware reaches both (and what it does not reach); the custom route works; routes
added after Mastra still work; an app route at a path Mastra already uses is refused at startup
rather than silently shadowing it; and what Mastra's request log does and does not record.

## Next

- Mastra behind one route instead → [`mounted-as-one-route`](../mounted-as-one-route)
- Auth, MCP, OpenTelemetry and API docs on this same pattern → [`full-app`](../full-app)
