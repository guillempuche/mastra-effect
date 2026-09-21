# mastra-in-an-effect-server

Effect owns the HTTP server. Mastra's routes, Better Auth and the Scalar docs page all mount onto
the router the app created.

```bash
pnpm install
pnpm test    # BDD tests — no database, no API keys, no containers
pnpm dev     # http://localhost:3000
```

| Path | Served by |
|---|---|
| `/healthz` | the app, as a plain Effect route |
| `/auth/*` | Better Auth, via `HttpEffect.fromWebHandler` |
| `/api/*` | Mastra — agents, workflows, memory, MCP, ~400 routes |
| `/api/openapi.json` | Mastra, generated from its own route table |
| `/docs` | Scalar, rendering that document |

## What it shows

**The app owns the router.** `createRouter()` is called here, the app adds its own routes to it, and
the *same instance* is handed to `new MastraServer({ app: router })`. That composes because the
adapter binds `TApp` to a live `HttpRouter` service rather than a Layer, so Mastra's routes join the
app's on one port, one router, one middleware stack. Use `createMastraServer()` instead only when
you want Mastra to own the server.

**One identity system, two consumers.** `betterAuth()` is constructed in [`auth.ts`](src/auth.ts) by
the app, because the app needs a handle on it to mount `/auth/*`. The same instance is passed to
`MastraAuthBetterAuth`, so Mastra's per-route auth, RBAC and FGA resolve against the same sessions.
Both credential paths work: a browser session cookie, and an `Authorization: Bearer` token — Better
Auth only reads cookies, so the provider converts a bearer token into a signed session cookie before
verifying it. Both are covered in [`server.integration.test.ts`](src/server.integration.test.ts).

**MCP comes from Mastra, not Effect.** Both can serve it. Mastra's exposes *its* agents and tools,
which is the point of running Mastra; Effect's `McpServer.layerHttp` exposes the app's own domain
and could mount alongside on another path.

## Two things worth copying

`public: ['/api/openapi.json']` on the auth provider. Mastra serves its OpenAPI document as an
ordinary route under `/api/*`, which the default config protects — leave it alone and `/docs` loads
for anonymous visitors while its spec fetch returns 401. A test covers this.

`mapUserToResourceId` on the auth provider. Without it, ownership checks trust the resource id the
client supplies, so one authenticated user can read and write another's threads. Mastra warns about
this at boot.

## Not production-ready

The Better Auth store is `memoryAdapter`, so every restart forgets its users — swap in libsql or
Postgres and nothing else changes. The secret is a literal. The agent names a model it never calls;
give it a provider key to actually generate.
