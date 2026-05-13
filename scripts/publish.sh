#!/usr/bin/env bash
# Publish the SDK to npm under the right dist-tag.
#
# Default `npm publish` (and `pnpm publish`) puts EVERY version on the
# `latest` dist-tag — including pre-releases like `0.1.0-next.0`. That's
# the wrong default: a consumer doing `npm install scorezilla` would
# pick up our pre-release without asking for it.
#
# This wrapper detects the dist-tag from the version string itself:
#
#   • Stable (no dash):           `--tag latest`
#   • Pre-release `-<tag>.<N>`:   `--tag <tag>` — e.g. `0.1.0-next.0` → `next`
#
# Provenance is opt-in via `NPM_PUBLISH_WITH_PROVENANCE=1` (set in
# sdk-release.yml — this repo is public, so the flag works). Outside that
# env, publishes go through without provenance — useful for one-off manual
# publishes from a developer's terminal.
#
# Use from CI as `bash scripts/publish.sh`.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")

# Match the pre-release tag if the version has the canonical SemVer
# pre-release shape `<x.y.z>-<tag>.<N>`. The BASH_REMATCH index 1 captures
# the alphabetic tag (`next`, `rc`, `alpha`, etc.).
if [[ "$VERSION" =~ -([a-zA-Z]+)\.[0-9]+ ]]; then
  TAG="${BASH_REMATCH[1]}"
elif [[ "$VERSION" == *-* ]]; then
  # Pre-release without a `.N` suffix (rare; e.g. `0.1.0-beta`). Treat the
  # whole after-dash portion as the tag.
  TAG="${VERSION#*-}"
else
  TAG=latest
fi

PROVENANCE_FLAG=()
if [[ "${NPM_PUBLISH_WITH_PROVENANCE:-}" == "1" ]]; then
  PROVENANCE_FLAG=(--provenance)
  echo "Provenance: ENABLED (NPM_PUBLISH_WITH_PROVENANCE=1)"
else
  echo "Provenance: DISABLED (set NPM_PUBLISH_WITH_PROVENANCE=1 to turn on)"
fi

echo "Publishing scorezilla@${VERSION} under npm dist-tag: ${TAG}"

# We DO NOT `exec` here. Two reasons:
#   1. `changesets/action`'s publish-detection parses stdout. `npm publish`
#      output matches its expected pattern; pnpm's does not. Using
#      `npm publish` keeps SRI generation + release annotation + smoke
#      test working without forking `changesets/action`.
#   2. We need to write a sentinel to $GITHUB_OUTPUT after the publish
#      completes so the workflow can gate post-publish steps on a signal
#      we control end-to-end (independent of changesets/action's parsing).
#
# `NODE_AUTH_TOKEN` is already exported by setup-node + the action's
# `env:` block, so npm picks up auth from ~/.npmrc.
npm publish --access=public --tag "$TAG" "${PROVENANCE_FLAG[@]}"

# Signal published name+version to the workflow. Quoted carefully to avoid
# shell metacharacter trouble even though name/version are well-formed.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'published=true\n' >> "$GITHUB_OUTPUT"
  printf 'published_name=%s\n' "$(node -p "require('./package.json').name")" >> "$GITHUB_OUTPUT"
  printf 'published_version=%s\n' "$VERSION" >> "$GITHUB_OUTPUT"
fi
