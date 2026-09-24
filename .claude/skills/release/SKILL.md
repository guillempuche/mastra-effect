---
name: release
description: Cut and publish a release of @guillem_puche/mastra-effect to npm. Use when asked to release, publish, cut a version, ship to npm, or bump the version. Covers the pre-release checks that matter for this package — the Mastra and Effect ranges, what actually lands in the tarball, and the one-time setup the first publish needs.
---

# Releasing this package

Two halves, on purpose:

- **Locally, `release-it`** bumps the version, writes the changelog, commits, tags `v<version>` and
  pushes. It never publishes (`npm.publish` is `false` in `.release-it.json`).
- **In CI, `.github/workflows/release.yml`** runs on that tag: the whole CI workflow first, then — on
  Node 24, behind the `release` environment's reviewer — packs and publishes with npm trusted
  publishing, which attaches a provenance attestation. It refuses any ref that is not
  `v<package.json version>` on a commit in `main`.

```bash
pnpm release:dry   # always first
pnpm release       # requires a clean tree on main, with an upstream
```

`before:init` runs `pnpm typecheck && pnpm test && pnpm build`, so a release cannot be cut red.

## Decide these before bumping

**1. Is the Mastra floor still right?**

`@mastra/server` is `^1.68.0` and the `@mastra/core` peer starts at `1.68.0`. The `Oldest supported
Mastra` CI job tests exactly that floor, and every other job tests the newest release. If the
adapter now needs something newer, raise both together; the job follows `package.json` on its own.

Never replace the declared range with a prerelease floor such as `^1.68.0-alpha.10`. A consumer
running `minimumReleaseAge` then has the fresh stable gated out while the older alpha still
satisfies the range, so pnpm resolves the prerelease silently.

**2. Has the Effect line moved?**

`peerDependencies` says `effect >=4.0.0-rc.117 <5`. If Effect has released past the pinned rc, bump
it, then update the vendored subtree to match — `pnpm lint-vendor` fails until you do — and check
`src/effect-api-gate.ts` still compiles:

```bash
scripts/update-vendored-effect.sh <version>   # stages the update; commit it with the trailers it prints
pnpm lint-vendor && pnpm typecheck
```

Never run `git subtree pull` on its own: it makes a merge commit, which `main` refuses.

Also re-run `src/router-collision.test.ts`; it records router behaviour that a vendored FindMyWay
change could flip.

**3. Is the version right for what changed?**

`ignoreRecommendedBump` is on, so `release-it` asks rather than inferring. While the package is
`0.x`, a breaking change is a minor. Once it is `1.x`, adapter-contract changes are majors —
including anything that changes which `SERVER_ROUTES` the adapter can serve.

## Check the tarball, not the repo

`files` is `["dist", "NOTICE"]`, so only the build, NOTICE, README, LICENSE and package.json ship. CI
asserts this on every run; to look yourself:

```bash
npm pack --dry-run
```

Nothing from `src/`, `examples/`, `scripts/` or `docs/repos/` should appear. If `docs/repos/effect`
ever shows up, the tarball goes from ~200 kB to tens of megabytes.

## First publish only

Trusted publishing cannot create a package, and the workflow's safeguards depend on repository
settings that only the owner can make. In order:

1. **Publish `0.0.x` once by hand**, from a machine logged in as the scope owner (`npm whoami`):
   `pnpm build && npm publish --access public`. The package is scoped, so without `--access public`
   it would be private.
2. **On npmjs.com, add a trusted publisher** for the package: GitHub Actions, repository
   `guillempuche/mastra-effect`, workflow `release.yml`, environment `release`. Then, in the package
   settings, require two-factor authentication and disallow tokens, so only the workflow can publish.
3. **In the GitHub repository settings, create the `release` environment** with yourself as a
   required reviewer, and limit its deployments to tags matching `v*`. Until it exists, GitHub creates
   it on first use with no protection, and a pushed tag publishes with nobody approving it.
4. **Make CI a required check on `main`** (branch protection or a ruleset), so a red change cannot be
   merged in the first place.

`release-it` pushes its release commit straight to `main`, which the branch protection only allows
because the owner can bypass it. Anyone else cutting a release needs that bypass too, or a release
PR instead.

Afterwards, confirm the version landed public and signed:

```bash
npm view @guillem_puche/mastra-effect
npm audit signatures
```

## Conventional commits

The changelog is generated from commit types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`,
`cicd`. `chore` is hidden, which is why release commits are `chore(release)`. A release with nothing
but `chore` commits produces an empty changelog section — usually a sign the release is not worth
cutting.
