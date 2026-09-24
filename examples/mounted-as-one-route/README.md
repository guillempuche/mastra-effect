# mounted-as-one-route

Mastra gets a router of its own, and your app forwards `/api/*` to it as one route — so anything
you wrap around that route covers Mastra and nothing else.

**Use this when** you want a clear fence around Mastra: middleware that applies to Mastra only
(here, an API key), or Mastra's request log kept free of your own routes.

**Look elsewhere when** you just want Mastra next to your routes with the least wiring →
[`alongside-your-routes`](../alongside-your-routes).

## Run it

```bash
pnpm install          # once, from the repository root
cd examples/mounted-as-one-route
pnpm test
API_KEY=secret pnpm dev

curl http://localhost:3000/healthz                                # 200 — no key needed
curl http://localhost:3000/api/agents                             # 401 — Mastra needs the key
curl http://localhost:3000/api/agents -H 'x-api-key: secret'      # 200
```

## How it works

Two routers instead of one. Your app's router holds your routes plus a few forwards; Mastra's
router holds only Mastra's routes.

```
                          ┌─ /healthz ────────────────────────────▶ your route
request ──▶ app router ───┼─ /api/*   ──▶ [x-api-key check] ──┐
                          └─ /hooks/* ────────────────────────┴──▶ Mastra's router
```

1. [`src/server.ts`](src/server.ts) builds Mastra's router with `new MastraServer({ app: mastraRouter })`.
2. `mastraRouter.asHttpEffect()` turns that whole router into a single handler.
3. The app registers that handler at `/api/*`, wrapped in an API-key check. Mastra's router still
   sees the full URL (`/api/agents`, not `/agents`), so nothing inside Mastra changes.

### The catch: custom routes need their own forward

Routes you define in Mastra's config with `registerApiRoute` cannot start with `/api` — Mastra
refuses them at startup. So they never pass through the `/api/*` forward, and each of their path
prefixes needs a forward of its own. This example forwards `/hooks/*`. Forget that line and those
routes answer 404, silently — the tests pin exactly that.

The `/hooks/*` forward deliberately skips the API-key check: custom routes are often webhooks,
called by outside services that cannot send your key and that prove who they are some other way.

### Compared with sharing one router

| | [`alongside-your-routes`](../alongside-your-routes) | this example |
|---|---|---|
| Middleware for Mastra only | awkward | wrap the one forward |
| Mastra's request log | sees your routes too | sees only Mastra's |
| Mastra's custom routes | work with no extra step | need a forward per path prefix |
| Wiring | least | a few more lines |

## What the tests check

[`src/server.test.ts`](src/server.test.ts): your route stays open while Mastra needs the key; wrong,
empty and missing keys are refused; Mastra's routes, path parameters and 404s behave exactly as if
Mastra owned the server; the custom route is reachable only while its prefix is forwarded;
Mastra's request log never records your routes; and settings that would quietly open the key check
or 404 every hook — a blank key, a trailing slash on a prefix — stop the server from starting.

## Next

- One shared router instead → [`alongside-your-routes`](../alongside-your-routes)
- Real user auth (Better Auth) instead of a shared key → [`full-app`](../full-app)
