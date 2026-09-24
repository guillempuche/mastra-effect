# minimal

The smallest setup that works: an Effect HTTP server whose only job is to serve Mastra.

**Use this when** you want Mastra's API up and running on Effect and have no routes of your own yet.

**Look elsewhere when** you already have an Effect app with its own routes → [`alongside-your-routes`](../alongside-your-routes).

## Run it

```bash
pnpm install          # once, from the repository root
cd examples/minimal
pnpm test             # proves it works — no API keys, no database
pnpm dev              # http://localhost:3000/api/agents
```

Try the workflow, which runs without any AI provider key:

```bash
curl -X POST http://localhost:3000/api/workflows/greet/start-async \
  -H 'content-type: application/json' \
  -d '{"inputData":{"name":"Ada"}}'
```

## How it works

Two steps, one per file:

1. **[`src/mastra.ts`](src/mastra.ts)** describes *what* Mastra offers: one agent and one small
   workflow. This is ordinary Mastra code, the same as in any Mastra project.
2. **[`src/server.ts`](src/server.ts)** makes it reachable over HTTP. `createMastraServer` builds an
   Effect router — the thing that decides which code answers which URL — and fills it with every
   Mastra route. `serve` then puts that router on a port with Node's HTTP server.

```
request ──▶ Node HTTP server ──▶ Effect router ──▶ Mastra route (/api/agents, /api/workflows/…)
```

Everything Mastra serves lives under `/api`. Anything else answers 404.

## What the tests check

[`src/server.test.ts`](src/server.test.ts) sends real requests through the router: listing agents,
running the workflow end to end, rejecting input the workflow's schema refuses, and answering 404
where nothing lives — including a Mastra path requested without the `/api` prefix. One test starts
the server on a real port, exactly as `pnpm dev` does, and checks the port closes again on shutdown.

## Next

- Add routes of your own next to Mastra's → [`alongside-your-routes`](../alongside-your-routes)
- Keep Mastra behind a single route, with its own middleware → [`mounted-as-one-route`](../mounted-as-one-route)
- No Effect server at all (Bun, Deno, Workers, Next.js) → [`fetch-handler`](../fetch-handler)
- Auth, MCP, OpenTelemetry and API docs together → [`full-app`](../full-app)
