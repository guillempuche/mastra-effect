---
name: release
description: Cut and publish a release of @guillem_puche/mastra-effect to npm. Use when asked to release, publish, cut a version, ship to npm, or bump the version. Covers the pre-release checks that matter for this package — the Mastra alpha pin, the Effect peer range, and what actually lands in the tarball.
---

# Releasing this package

`release-it` does the mechanical work (version bump, changelog, tag, GitHub release, `npm publish`).
This skill covers the judgment `release-it` cannot make.

```bash
pnpm release:dry   # always first
pnpm release       # requires a clean tree on main, with an upstream
```

`before:init` runs `pnpm typecheck && pnpm test && pnpm build`, so a release cannot ship red.

## Decide these before bumping

**1. Does the `@mastra/core` / `@mastra/server` pin need to move?**

`devDependencies` pin both to an exact alpha because the published conformance suite requires
`>=1.68.0-alpha` despite advertising `>=1.64.0-0`. Check whether a newer alpha exists and whether
the suite still passes on it. **Bump them as a pair, never one alone.**

`dependencies` carries a *range* (`^1.68.0-alpha.10`), not the exact pin. Keep it that way — an
exact pin in a published package forces that version on every consumer and collides with their own
`@mastra/server`.

**2. Has the Effect line moved?**

`peerDependencies` says `effect >=4.0.0-rc.116 <5`. If Effect has released past the pinned rc, run
the subtree update and re-check `src/effect-api-gate.ts` compiles — that file exists to fail loudly
on drift:

```bash
git subtree pull --prefix docs/repos/effect https://github.com/Effect-TS/effect.git effect@<tag> --squash
pnpm typecheck
```

Also re-run `src/router-collision.test.ts`; it records router behaviour that a vendored FindMyWay
change could flip.

**3. Is the version right for what changed?**

`ignoreRecommendedBump` is on, so `release-it` asks rather than inferring. While the package is
`0.x`, a breaking change is a minor. Once it is `1.x`, adapter-contract changes are majors —
including anything that changes which `SERVER_ROUTES` the adapter can serve.

## Check the tarball, not the repo

`files` is `["dist"]`, so only the build, README, LICENSE and package.json ship. Confirm with:

```bash
npm pack --dry-run
```

Nothing from `src/`, `examples/` or `docs/repos/` should appear. If `docs/repos/effect` ever shows
up, the tarball goes from ~37 kB to megabytes.

## First publish only

The package is scoped, and scoped packages default to restricted. `publishConfig.access` is set to
`public` so this is handled — but verify the first publish actually landed public:

```bash
npm view @guillem_puche/mastra-effect
```

Confirm `npm whoami` matches the scope owner before the first release.

## Conventional commits

The changelog is generated from commit types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`,
`cicd`. `chore` is hidden. A release with nothing but `chore` commits produces an empty changelog
section — usually a sign the release is not worth cutting.
