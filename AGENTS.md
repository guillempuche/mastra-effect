# AGENTS.md — AI Agent Instructions

Rules and patterns for AI agents working in this codebase.
For what the adapter is, how to install it and how consumers use it, see [README.md](README.md).

---

## Dev environment

This project uses a **Nix flake** (`flake.nix`) with **direnv** (`.envrc`) to provide Node 24 and
pnpm. On entering the directory, direnv activates the flake automatically — no manual `nix develop`
needed.

To verify: `node --version` and `pnpm --version`.

Never install Node or pnpm globally or via another package manager for this project, and never
install dependencies with npm or yarn — the lockfile is pnpm's, and a different resolver can produce
two copies of `@mastra/server` (see the dependency rule below).

```bash
pnpm test          # vitest, includes the Mastra conformance suites
pnpm typecheck     # tsc --noEmit
pnpm build         # tsdown, ESM + CJS + d.ts
pnpm lint          # oxlint
```

---

## Layout

- `src/index.ts` — the adapter. Everything ships from here.
- `src/effect-api-gate.ts` — compile-time assertions against `effect/unstable/http`. Not reachable
  from the entry, so it never reaches the bundle. If an Effect upgrade breaks the adapter, this
  should be what fails first.
- `src/router-collision.test.ts` — records how Effect's router resolves Mastra's four
  same-prefix/different-param-name route pairs. A tripwire, not a feature test.
- `src/conformance.test.ts` — wiring for all six of Mastra's published conformance suites.
- `src/effect-integration.test.ts` — what crosses from Mastra back into Effect: `MastraRouteError` in
  the error channel, and `runInRequest` giving tools and steps the app's services and span.
- `src/regressions.test.ts`, `src/request-body.test.ts`, `src/request-response.test.ts`,
  `src/cancellation.test.ts`, `src/mcp.test.ts` — what the suites do not reach, each case a defect
  that was reproduced before it was fixed. `src/test-support.ts` holds their shared helpers: the
  router served through a fetch handler, and on a real Node server.
- `scripts/check-vendored-effect.mjs` — `pnpm lint-vendor`, run by CI and the pre-push hook.
- `scripts/update-vendored-effect.sh` — updates `docs/repos/effect` as one linear commit; see below.
- `examples/*` — one runnable app per use case, each a workspace member with its own tests. Which
  example covers what is listed once, in the README's Examples table; read that rather than
  opening examples at random.
- `docs/repos/effect` — Effect source vendored as a squashed `git subtree`, pinned to the tag the
  adapter compiles against. Read it instead of guessing at `unstable/http` internals.

Update the vendored source with the script, never with `git subtree pull` on its own:

```bash
scripts/update-vendored-effect.sh 4.0.0-rc.118   # the Effect version, without the `effect@` prefix
```

`git subtree pull --squash` makes a merge commit, and `main` requires linear history, so that commit
could never land. The script runs the same pull, then leaves its changes staged for one ordinary
commit and prints the two `git-subtree-*` trailer lines that commit must end with — they are how the
next pull finds where this one left off.

---

## `@mastra/server` must resolve to exactly one instance

The conformance suite reads `SERVER_ROUTES` from its own resolution of `@mastra/server`. Two copies
means it iterates a different route table than the adapter registered, and the failures that follow
look nothing like the cause.

Check with `pnpm why @mastra/server`. Do **not** judge this from the `node_modules/.pnpm` directory
listing — it keeps orphaned entries from previous installs and will show versions that nothing links
to.

---

## Which Mastra the tests run against

`@mastra/server` is a dependency at `^1.68.0` and `@mastra/core` a peer from `1.68.0`. The lockfile
resolves the newest release, so every job but one tests that; the `Oldest supported Mastra` CI job
pins both to the floor read from `package.json` and runs the whole suite again. Raising the floor
therefore needs nothing but the edit — the job follows it.

**Do not turn the declared range into a prerelease floor.** `^1.68.0-alpha.10` looks harmless and is
not: a consumer using `minimumReleaseAge` has the fresh stable gated out while the older alpha still
satisfies the range, so pnpm silently resolves the prerelease and says nothing.

MCP servers come from `@mastra/mcp`, which the adapter does not depend on — it forwards to whatever
server the app built. Both majors are tested: `@mastra/mcp` is 2.x, which Mastra's MCP transport suite
asserts, and `@mastra/mcp-v1` is a 1.x alias for `src/mcp.test.ts`, whose session-based defects only
1.x can show. `pnpm-workspace.yaml` says why the suite's own `<2` peer range is overridden.

## Route handlers must not surface a typed error

`router.add` is only runnable standalone while its error channel is `never`, and that is what lets
registration bridge Effect to Promise once per route. Anything that can fail must be converted —
`Effect.orDie` for defects, or caught and turned into a `Response` — before it reaches `add`.

---

## Adding an example

An example covers one use case. Give it a README that opens with "Use this when" and "Look elsewhere
when", tests that run under `pnpm test`, and a row in the README's Examples table — that table is
the only index, so an example missing from it is an example nobody finds. CI picks up anything under
`examples/` on its own.

Recursive runs are sequential (`workspaceConcurrency: 1` in `pnpm-workspace.yaml`). Do not raise it:
each example rebuilds the library before it runs, and parallel builds delete `dist/` under each other.

---

## Conventions

When adding response-type handling, mirror `@mastra/elysia` (`server-adapters/elysia` in the Mastra
monorepo). It is the closest in-tree adapter, being fetch-based, and it already encodes decisions
this adapter would otherwise have to rediscover — stream framing, `Transfer-Encoding` stripping, and
not awaiting the MCP transport start call.

Where behaviour is at stake, `@mastra/hono` is the reference: it is Mastra's own, and Elysia shares
several of the defects fixed here (repeated query keys, MCP start failures, `failingItems`). The MCP
client-disconnect handling is ported from it; NOTICE records what came from where.

When an Effect upgrade lands, the vendored subtree has to follow by hand — no bot can run
`scripts/update-vendored-effect.sh`, so a dependency PR that bumps `effect` fails `pnpm lint-vendor`
until someone does.

Code that works around an upstream bug says so where it does it, with the issue link, so it can go
once the issue is fixed. Search for `github.com/mastra-ai/mastra/issues` and
`github.com/Effect-TS/effect/issues` before an upgrade.
