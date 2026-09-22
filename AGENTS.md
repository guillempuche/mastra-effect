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

## Testing runs against an older Mastra than the package declares

Every manifest declares `@mastra/*` at `^1.68.0`, which is what a consumer should get. Tests run
against `1.68.0-alpha.10`, pinned by `overrides` in `pnpm-workspace.yaml`.

The reason is a single route. The pinned conformance suite (`0.1.0-alpha.0`) asserts that every
route it does not explicitly exclude answers under 400, and stable `1.68.0` changed
`POST /auth/logout` to reply `404 {"error":"Logout not configured"}` when no logout provider is
configured. The suite already excludes the auth routes that need providers — `sso/login`,
`credentials/sign-in`, `refresh` and others — but not `logout`, so it fails on a route this adapter
forwards perfectly correctly. Worth reporting upstream.

Remove the override once a suite release covers the stable line, and re-run the suite to confirm.

**Do not turn the declared range back into a prerelease floor.** `^1.68.0-alpha.10` looks harmless
and is not: a consumer using `minimumReleaseAge` has the fresh stable gated out while the older
alpha still satisfies the range, so pnpm silently resolves the prerelease and says nothing.

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
