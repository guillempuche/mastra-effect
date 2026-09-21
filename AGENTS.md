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
- `src/conformance.test.ts` — `setupAdapter` / `executeHttpRequest` wiring for the published suites.
- `docs/repos/effect` — Effect source vendored as a squashed `git subtree`, pinned to the tag the
  adapter compiles against. Read it instead of guessing at `unstable/http` internals.

Update the vendored source with:

```bash
git subtree pull --prefix docs/repos/effect https://github.com/Effect-TS/effect.git effect@<tag> --squash
```

---

## `@mastra/server` must resolve to exactly one instance

The conformance suite reads `SERVER_ROUTES` from its own resolution of `@mastra/server`. Two copies
means it iterates a different route table than the adapter registered, and the failures that follow
look nothing like the cause.

Check with `pnpm why @mastra/server`. Do **not** judge this from the `node_modules/.pnpm` directory
listing — it keeps orphaned entries from previous installs and will show versions that nothing links
to.

---

## The test suite needs the `@mastra/core` alpha line

`@mastra/server-adapters-test-suite` declares a peer range of `>=1.64.0-0`, but its
`createDefaultTestContext` spies on an observability-store method that only exists on the
`1.68.0-alpha` line. Installing stable `1.67.0` satisfies the declared range and then fails ~1200
tests behind a `vi.spyOn` TypeError that points nowhere useful.

`@mastra/core` and `@mastra/server` are pinned to exact alpha versions for this reason — **bump them
as a pair**, never one alone.

The suite must also stay listed in `server.deps.inline` in `vitest.config.ts`. It calls `vi.mock` at
module scope, and vitest only hoists that in files it transforms; `node_modules` is externalised by
default. In the Mastra monorepo the suite is a workspace *source* package, so no in-tree adapter ever
hits this and no upstream doc mentions it.

---

## Route handlers must not surface a typed error

`router.add` is only runnable standalone while its error channel is `never`, and that is what lets
registration bridge Effect to Promise once per route. Anything that can fail must be converted —
`Effect.orDie` for defects, or caught and turned into a `Response` — before it reaches `add`.

---

## Conventions

When adding response-type handling, mirror `@mastra/elysia` (`server-adapters/elysia` in the Mastra
monorepo). It is the closest in-tree adapter, being fetch-based, and it already encodes decisions
this adapter would otherwise have to rediscover — stream framing, `Transfer-Encoding` stripping, and
not awaiting the MCP transport start call.
