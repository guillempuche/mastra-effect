# fetch-handler

Mastra as a plain function that takes a `Request` and returns a `Response`, for platforms that
bring their own server: Bun, Deno, Cloudflare Workers, a Next.js route handler.

**Use this when** you are not running an Effect server, or your platform already owns the port.

**Look elsewhere when** you are running Effect's own HTTP server → [`minimal`](../minimal).

## Run it

```bash
pnpm install          # once, from the repository root
cd examples/fetch-handler
pnpm test
```

There is no `pnpm dev`: this example has no server of its own, which is the point. Hand the handler
to whichever platform you use (below).

## How it works

Many platforms speak one language: *give me a function, I'll call it with each `Request`, you
return a `Response`*. [`src/handler.ts`](src/handler.ts) produces that function.

```
platform (Bun / Deno / Workers / Next.js)
   │  Request
   ▼
fetch(request) ──▶ Effect router ──▶ Mastra route ──▶ Response
```

Inside, the adapter still builds an Effect router of Mastra's routes, and `toWebHandler` turns it
into the function. Effect runs inside it; the platform never needs to know.

Three details, each handled in `handler.ts`:

- **Mastra starts on the first request, not on import.** Build tools often import a file without
  ever serving a request; they should not start Mastra.
- **Requests that arrive while Mastra is still starting wait for it,** and share that one start
  rather than each starting Mastra again.
- **If starting fails, the next request tries again,** instead of every request failing forever.

## Plug it in

[`src/entry.ts`](src/entry.ts) default-exports `{ fetch }`, the shape Bun, Deno and Workers accept.

```bash
bun run src/entry.ts        # Bun serves a default export that has `fetch`
deno serve -A src/entry.ts  # so does Deno
```

Deno needs `-A` (or the narrower permission flags it names) because Mastra reads environment
variables as it loads; without them, the import fails at the first one it reads.

For Cloudflare Workers, point `main` in `wrangler.toml` at `src/entry.ts`.

For **Next.js** (App Router), create `app/api/[...mastra]/route.ts`. The folder name makes Next send
every `/api/…` request here, with the full URL intact, so Mastra's `/api` routes match unchanged:

```ts
import { createFetchHandler } from '@/mastra/handler';

const { fetch } = createFetchHandler();
const handle = (request: Request) => fetch(request);

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
```

`handle` takes only the request on purpose. Next.js passes a second argument (the route's params),
and a one-argument function keeps Next's type check satisfied.

> This example is tested on Node. The snippets above show the wiring; whether Mastra itself runs on
> a given runtime is a question of Mastra's own support for that runtime.

## What the tests check

[`src/handler.test.ts`](src/handler.test.ts): Mastra's routes answer through the plain function;
simultaneous first requests share one start; a failed start is retried by the next request; the
handler works again after `dispose()`, and shutting down while a start is failing leaves no Mastra
running with nothing to stop it; a second argument such as Next.js passes is ignored; and the
default export used by Bun, Deno and Workers is callable.

## Next

- Run Effect's own server instead → [`minimal`](../minimal)
