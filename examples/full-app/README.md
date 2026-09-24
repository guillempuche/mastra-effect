# full-app

A production-shaped app: Effect owns the HTTP server, and Mastra, Better Auth, MCP, OpenTelemetry
and a Scalar API-docs page all live on the one router the app created.

**Use this when** you want to see how the pieces fit together in a real app, or need one of them —
auth in [`src/auth.ts`](src/auth.ts), telemetry in [`src/observability.ts`](src/observability.ts),
API docs in [`src/scalar.ts`](src/scalar.ts).

**Look elsewhere when** you want the adapter on its own, without the rest → [`minimal`](../minimal) or
[`alongside-your-routes`](../alongside-your-routes), which this example builds on.

```bash
pnpm install              # once, from the repository root
cd examples/full-app
pnpm test                 # BDD tests — no database, no API keys, no containers
pnpm dev                  # http://localhost:3000
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
the *same instance* is handed to `new MastraServer({ app: router })`. Mastra does not bring a router
of its own: it adds each of its ~400 routes to the app's, so everything shares one port, one router
and one middleware stack. [`alongside-your-routes`](../alongside-your-routes) shows this pattern on
its own; [`mounted-as-one-route`](../mounted-as-one-route) shows the alternative, Mastra behind a
single route.

**One identity system, two consumers.** `betterAuth()` is constructed in [`auth.ts`](src/auth.ts) by
the app, because the app needs a handle on it to mount `/auth/*`. The same instance is passed to
`MastraAuthBetterAuth`, so Mastra's per-route auth, RBAC and FGA resolve against the same sessions.
Both credential paths work: a browser session cookie, and an `Authorization: Bearer` token — Better
Auth only reads cookies, so the provider converts a bearer token into a signed session cookie before
verifying it. Both are covered in [`server.integration.test.ts`](src/server.integration.test.ts).

**MCP comes from Mastra, not Effect.** Both can serve it. Mastra's exposes *its* agents and tools,
which is the point of running Mastra; Effect's `McpServer.layerHttp` exposes the app's own domain
and could mount alongside on another path.

## Observability

Follows the rules in batuda's `docs/observability.md`. **One wide record per unit of work**: a
request closes with exactly one line carrying every fact about it, because a question can only be
answered from facts that share a line.

```
event               http.request | http.server_error | http.not_found
request.id          ties everything from one request together
http.method
http.path_pattern   the route, with ids collapsed — never the raw URL
http.status
http.duration_ms
```

A missing route is `http.not_found` rather than an error: recorded as a failure, every bot probing
for `/robots.txt` buries the errors that matter. A successful `/healthz` drops to `debug`, since it
says only that the poller is still polling — a failing one keeps its level.

**Raw URLs never reach a record.** `sanitizePath` drops the query string whole rather than filtering
it, because an allowlist of safe parameter names holds only until someone adds one nobody thought to
name — and that one would be a magic-link or reset token. Path segments that are ids or email
addresses collapse to `:id`. Tests cover each case, including one asserting that no literal segment
of any real Mastra route is mistaken for an id, which would silently merge unrelated routes into one
bucket.

### Mastra's spans, in the same trace

With telemetry on, Mastra traces its own work through its OpenTelemetry bridge
(`mastraObservability` in [`src/observability.ts`](src/observability.ts)): the agent run, each step,
model calls with token counts, and tool calls. They land in the same trace as the HTTP request,
under its span, so one trace shows a request from the route down to the model call.
[`src/tracing.test.ts`](src/tracing.test.ts) checks that parentage.

Two things make it work, and both are easy to miss:

- **The tracer provider is registered process-wide.** The bridge reads only the registered provider,
  and Effect's `NodeSdk.layer` never registers the one it builds. Without the registration, the bridge
  exports none of Mastra's spans and nothing fails
  ([mastra-ai/mastra#24950](https://github.com/mastra-ai/mastra/issues/24950)). Registering also
  installs the context manager that lets Mastra's spans nest under the request. The registration is
  undone when the server stops. OpenTelemetry refuses to register twice, so without that, a server
  started again in the same process would export none of Mastra's spans.
- **Mastra samples everything** and leaves sampling to OpenTelemetry, so a sampled request never has
  holes where its agent spans should be. Per-chunk spans of streamed answers are left out.

Your own Effect code inside a tool or workflow step, run with `runInRequest`, joins the same trace
when its runtime has `runtimeTracing`:

```ts
const runtime = ManagedRuntime.make(Layer.mergeAll(AppServicesLive, runtimeTracing('my-app')));
```

The runtime's tracer, not the server's, makes that code's spans. `runtimeTracing` sends them
through the provider registered above. Without it, they are made with Effect's default tracer and
never exported. The tests check this too.

**Prompts, answers and tool arguments are exported as they are.** Mastra redacts keys that look
sensitive, such as passwords and tokens, not the text itself. Mask them before they leave the
process if they can carry personal data — with a Mastra span output processor, or per request with
`tracingOptions.hideInput` / `hideOutput`.

The same bridge also serves Mastra's other exporters. For LLM-specific tools such as Langfuse, add
Mastra's exporter for it (`@mastra/langfuse`) to the same observability config.

The bridge brings OpenTelemetry's gRPC exporters with it, through `@mastra/otel-exporter`, even though
nothing here uses gRPC. That weight stays in this example; the adapter itself depends on none of it.

### Local

`OTEL_EXPORTER_OTLP_ENDPOINT` is the on/off switch — unset means no export at all, and the process
still runs. Telemetry is not needed to serve a request, so a missing endpoint must not stop the
server.

```bash
pnpm dev:otel      # terminal 1 — otel-tui, from the nix flake, listening on :4317 / :4318
pnpm dev:traced    # terminal 2 — the server, exporting to it
```

### Cloud

A pure environment change; no code moves.

| Environment | `OTEL_EXPORTER_OTLP_ENDPOINT` | `OTEL_EXPORTER_OTLP_HEADERS` |
|---|---|---|
| Local (otel-tui) | `http://localhost:4318` | *(empty)* |
| Honeycomb | `https://api.honeycomb.io` | `x-honeycomb-team=KEY` |
| Grafana Cloud | `https://otlp-gateway-….grafana.net/otlp` | `Authorization=Basic …` |

The endpoint is not a secret; the headers carry the vendor key and are.

## Two things worth copying

`'/api/openapi.json'` in the auth provider's `public` list (see [`src/mastra.ts`](src/mastra.ts), which
also keeps `/api` and `/api/auth/*` public). Mastra serves its OpenAPI document as an
ordinary route under `/api/*`, which the default config protects — leave it alone and `/docs` loads
for anonymous visitors while its spec fetch returns 401. A test covers this.

`mapUserToResourceId` on the auth provider. Without it, ownership checks trust the resource id the
client supplies, so one authenticated user can read and write another's threads. Mastra warns about
this at boot.

## Not production-ready

The Better Auth store is `memoryAdapter`, so every restart forgets its users — swap in libsql or
Postgres and nothing else changes. The secret is a literal. The agent names a model it never calls;
give it a provider key to actually generate.
