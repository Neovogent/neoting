# NEOTING — the api / workers / migrate image.
#
# ⚠ BUILD CONTEXT IS THE REPO ROOT, not this directory:
#   docker build -f apps/api/Dockerfile .
# pnpm needs pnpm-workspace.yaml, the root package.json and every workspace
# manifest to resolve `--frozen-lockfile`, and the migrate command needs
# prisma/. Building from apps/api gets you a lockfile error that blames the
# lockfile.
#
# ONE IMAGE, THREE COMMANDS (infra/envs/staging/services.tf):
#   api      node apps/api/dist/main.js         (this file's CMD)
#   workers  node apps/api/dist/worker/main.js  (an explicit `command` on the
#                                                task definition, because a
#                                                container definition with no
#                                                command inherits the CMD and
#                                                would silently run a second
#                                                copy of the API)
#   migrate  pnpm prisma migrate deploy         (run-task only, never a service)
#
# WORKDIR stays at the repo root, not apps/api, because the Prisma CLI resolves
# .env and its schema relative to the working directory — the root
# package.json's `prisma.schema` key is what makes `pnpm prisma` work at all,
# and it only applies from here. That is the same trap documented in the root
# package.json's "//prisma" comment.
# They share a build because they share a dependency tree, and a single digest
# means the migration that ran and the code that runs are provably the same
# commit — which is the whole point of expand-contract (Gov §5.3).
#
# ARCHITECTURE: the task definitions pin ARM64 (services.tf — Graviton is ~20%
# cheaper and the data tier is already t4g). CI therefore builds with
# `--platform linux/arm64`. An x86 image on those task definitions dies with
# "exec format error" and no other clue.
#
# SIZE DEBT, stated rather than hidden: the runtime stage carries the full
# workspace node_modules, dev dependencies included, because `pnpm prisma
# migrate deploy` needs the Prisma CLI (a devDependency) and pnpm has no
# `prune --prod` that survives its symlinked store. That is roughly 500 MB of
# image for a staging environment — about $0.05/month of ECR storage and ~30s
# of task pull. Trimming it is issue-worthy, not tonight's problem.

# --------------------------------------------------------------------------
FROM node:22-slim AS base

# openssl is NOT optional and its absence is not loud. node:22-slim ships
# without it; Prisma then prints
#   "failed to detect the libssl/openssl version to use ... Defaulting to
#    openssl-1.1.x"
# as a *warning*, picks the wrong query-engine binary, and fails when it
# actually opens a connection — i.e. during `migrate deploy` against RDS, in
# the deploy pipeline, not here. Measured on this image before it was added.
#
# ca-certificates is for the same class of reason: TLS to RDS (force_ssl=1),
# ElastiCache (transit encryption on) and every AWS endpoint.
#
# qpdf is the PDF guard's real implementation, and it is installed here rather
# than left optional because `config/env.ts` now REFUSES DOCUMENT_GUARD=fixture
# under NODE_ENV=production (S1). The fixture greps the first and last 8 KB for
# `/Encrypt` and misses a mid-file trailer in an incrementally-updated PDF —
# which is most signed or form-filled accounting paperwork — so in a real
# environment it is a password check that reports clean on files the pipeline
# then cannot read.
#
# It goes in `base` rather than `runtime` so the build stage has it too: the
# guard's unit tests drive a fake runner and need no binary, but anything that
# later shells out during a build step would find it. ~2 MB installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates qpdf \
  && rm -rf /var/lib/apt/lists/*

# corepack ships with Node 22 and pins pnpm from packageManager in the root
# package.json — so the image builds with the same pnpm the lockfile was
# written by, without a version pinned in two places.
#
# COREPACK_HOME is moved under /app on purpose. It defaults to the *invoking
# user's* home cache, so the build stage (root) would populate /root/.cache and
# the runtime stage (node) would find nothing — meaning the first `pnpm prisma
# migrate deploy` in a locked-down task would try to download pnpm from
# registry.npmjs.org at run time. Inside /app it is copied with everything
# else and chowned to node. Measured: without this, `pnpm --version` in the
# runtime image prints "Corepack is about to download ...".
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/app/.corepack
WORKDIR /app
RUN corepack enable

# --------------------------------------------------------------------------
FROM base AS build

# ⚠ THE ORDER OF THESE FOUR LINES IS THE SINGLE BIGGEST COST IN THE DEPLOY.
#
# This was `COPY . .` then `pnpm install`, justified by "a fresh CI runner has
# no cache locality anyway". That stopped being true when the deploy job gained
# `cache-from/cache-to: type=gha` — the GHA cache IS that locality, and
# `COPY . .` was what threw it away: ANY commit, a docs typo included,
# invalidated the layer and re-ran a full dependency install UNDER QEMU
# EMULATION, because the task definitions pin arm64 and this org's plan has no
# arm64 runners. Measured on #203, a ONE-LINE api fix: 5m24s of a 17m deploy.
#
# The old comment's real objection stands and is answered rather than dropped:
# enumerating nine workspace manifests by hand DOES rot the day a package is
# added. `pnpm fetch` needs none of them — it resolves from the LOCKFILE ALONE
# and ignores package manifests by design. Nothing copied here is per-package,
# so there is nothing to keep in step.
#
# All four files are load-bearing; none is decoration:
#   pnpm-lock.yaml       what `fetch` actually reads.
#   pnpm-workspace.yaml  without it the lockfile's importers resolve to nothing.
#   package.json         `corepack enable` (base stage) pins pnpm from
#                        packageManager. Absent, corepack has no version to
#                        honour and this stage silently runs a different pnpm
#                        than the lockfile was written by.
#   .npmrc               carries auto-install-peers=true, which CHANGES
#                        RESOLUTION. Omit it and `fetch` populates a different
#                        tree than the install below then asks for.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN pnpm fetch

COPY . .

# --offline is a GUARD, not an optimisation: it forbids reaching the network,
# so a lockfile that has drifted from the manifests fails HERE, loudly, with
# "not found in store" — instead of quietly resolving something the fetch layer
# above never saw and shipping it.
RUN pnpm install --frozen-lockfile --offline

# @prisma/client exports nothing until this runs. Nothing in the api entrypoint
# imports it today (scoped-db.ts is not yet reachable from main.ts), but the
# generate is here rather than later so the failure mode is a build error
# instead of a runtime one the first time a controller touches the database.
RUN pnpm --filter @neoting/api exec prisma generate

# The contracts package is a REAL build now, not just codegen: `pnpm build`
# there runs orval and then tsc, and its exports map points at dist/. This step
# is explicit rather than inherited because these are `pnpm --filter` calls, not
# `turbo run` — nothing here resolves the dependency graph for us, so without
# this line apps/api's tsc cannot even resolve the package's types.
RUN pnpm --filter @neoting/contracts build

# tsc emit — see apps/api/tsconfig.build.json for why a plain tsc works here.
RUN pnpm --filter @neoting/api build

# The compiled output MAY import @neoting/contracts at runtime — controllers
# parse their boundaries with the generated Zod schemas, and "Zod at every
# boundary" is not negotiable (Governance §1.7).
#
# This guard used to forbid that outright, because the package was consumed as
# .ts source through its exports map and Node could not load it: such an import
# deployed green and died on first request with ERR_UNKNOWN_FILE_EXTENSION.
# That is fixed at the source — contracts emits JS and its exports map points at
# it — so the guard is inverted rather than deleted. The failure it protects
# against has not gone away, it has moved: an image that imports the package
# without shipping its build is the same crash with a different message.
RUN if grep -rqE "(from|require\()\s*['\"]@neoting/contracts" apps/api/dist/; then \
      test -f packages/contracts/dist/generated/zod/index.js \
        || { echo "ERROR: apps/api/dist imports @neoting/contracts but packages/contracts/dist is missing. The contracts build did not run." >&2; exit 1; }; \
      if grep -rhoE "from ['\"]\.[^'\"]*['\"]" packages/contracts/dist/generated/ | grep -qv "\.js['\"]$"; then \
        echo "ERROR: packages/contracts/dist has an extensionless relative import. Node cannot resolve it. Did add-js-extensions.mjs run?" >&2; exit 1; \
      fi; \
      echo "contracts: runtime import present, build shipped, specifiers resolvable."; \
    fi

# --------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
# Storage is UTC, full stop (CLAUDE.md invariant). Europe/London is applied at
# render time by the app, never by the container clock — a BST boundary would
# otherwise rewrite every timestamp for an hour.
ENV TZ=UTC

COPY --from=build --chown=node:node /app /app

# The base image's unprivileged user. Nothing in the runtime path writes
# outside /tmp, and the one thing that would (extraction temp files) is
# explicitly allowed by Fargate's writable root — services.tf explains why
# readonlyRootFilesystem is not set.
USER node

# Documentation only — the ALB target group and the app security group both
# pin 3000 independently (infra/envs/staging/alb.tf, network.tf).
EXPOSE 3000

# No HEALTHCHECK: the ALB target group already probes /healthz from outside the
# task, and a container-level check would need curl baked in purely to
# duplicate it. The workers service, which has no load balancer, is the case
# that actually needs one — see the TODO on its task definition.
CMD ["node", "apps/api/dist/main.js"]
