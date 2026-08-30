#!/bin/sh
# Entrypoint for the Dockerfile `dev` stage (docker compose --profile full).
#
# ONE JOB: guarantee packages/contracts is built — and not stale — in the tree
# the container is actually running against, then exec the service command
# unchanged.
#
# Why this cannot be left to the image build: the compose services bind-mount
# the repo root over /app, so the contracts dist/ built into the image is
# hidden behind whatever the host tree has — and a fresh clone has nothing
# (src/generated is untracked, and root turbo `dev` has no dependsOn, so
# nothing builds it as a side effect). apps/api and apps/web both import
# @neoting/contracts through its exports map, which points at dist/: without
# this a cold clone's api dies at first import and the failure blames the
# import, not the missing build.
#
# Why existence alone is not checked: a `git pull` that changes the contract
# leaves the old dist/ in place, and the api then dies with "module does not
# provide an export named …" — observed the first time this stack ran against
# a tree whose base had just been fast-forwarded. So the guard is the same
# marker the apps/api/Dockerfile build guard uses (dist/generated/zod is the
# deepest artefact the build emits) PLUS an mtime comparison: any file under
# the contract's inputs (openapi.yaml, src/ — which includes the orval output
# in src/generated, always older than the dist a build finishes with) newer
# than that marker triggers a rebuild. Same discipline the host workflow
# already demands ("run pnpm build after pulling contracts changes"), just
# automated at the one moment it can be.
#
# Ordering: the compose `migrate` one-shot runs this entrypoint before
# api/workers/web are allowed to start (depends_on: service_completed_
# successfully), so in the compose flow at most one process builds into the
# shared mount. Restarting two services by hand mid-edit can still race the
# build; restart them one at a time if you are editing contracts.
set -eu

cd /app

marker=packages/contracts/dist/generated/zod/index.js

if [ ! -f "$marker" ]; then
  echo '[dev-entrypoint] packages/contracts/dist is missing from the mounted tree - building @neoting/contracts (one-off, ~30s)'
  pnpm --filter @neoting/contracts build
elif [ -n "$(find packages/contracts/openapi.yaml packages/contracts/src -type f -newer "$marker" -print -quit)" ]; then
  echo '[dev-entrypoint] packages/contracts source is newer than its dist - rebuilding @neoting/contracts'
  pnpm --filter @neoting/contracts build
fi

exec "$@"
