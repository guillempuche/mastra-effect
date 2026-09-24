#!/usr/bin/env bash
# Updates docs/repos/effect, the vendored Effect source, to an Effect release — as changes staged for
# ONE ordinary commit.
#
# `git subtree pull --squash` makes two commits, one of them a merge, and main requires linear
# history, so a merge commit can never land there. This runs the same pull, then undoes both commits
# while keeping their changes staged. The commit you make from them must carry the two trailer lines
# printed at the end: they are how the next `git subtree pull` finds where the last one left off.
#
# Usage: scripts/update-vendored-effect.sh 4.0.0-rc.118
set -euo pipefail

version="${1:?usage: scripts/update-vendored-effect.sh <effect version>, e.g. 4.0.0-rc.118}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first: this needs a clean working tree." >&2
  exit 1
fi

base=$(git rev-parse HEAD)
git subtree pull --prefix docs/repos/effect https://github.com/Effect-TS/effect.git "effect@$version" --squash \
  -m "temporary subtree merge, undone below"

if [ "$(git rev-parse HEAD)" = "$base" ]; then
  echo "docs/repos/effect is already at effect@$version: nothing to commit."
  exit 0
fi

# The merge's second parent is the squashed Effect commit, whose message names the upstream commit
# the next pull starts from. Without it the commit would carry a blank trailer and break that pull,
# so stop here, with the pull still in place to look at.
split=$( (git log -1 --format=%B HEAD^2 2>/dev/null || true) | sed -n 's/^git-subtree-split: //p')
if [ -z "$split" ]; then
  echo "Could not read git-subtree-split from the pull's squashed commit, so there is no trailer to print." >&2
  echo "The pull is left in place to inspect. Undo it with: git reset --hard $base" >&2
  exit 1
fi

git reset --soft "$base"

cat <<MSG

docs/repos/effect is now at effect@$version, staged. Commit it (with the commit skill), ending the
message with exactly these two lines:

git-subtree-dir: docs/repos/effect
git-subtree-split: $split

Then bump every effect and @effect/* version to $version and run: pnpm lint-vendor
MSG
