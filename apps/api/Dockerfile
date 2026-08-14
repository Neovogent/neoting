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
# qpdf is deliberately NOT installed yet: DOCUMENT_GUARD defaults to `fixture`
# and staging does not set it. It belongs here the moment that flips.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
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

# No manifest-only pre-copy layer: `COPY . .` costs cache locality that a
# fresh CI runner does not have anyway, and enumerating nine workspace
# manifests by hand is a step that silently rots the day a package is added.
COPY . .

RUN pnpm install --frozen-lockfile

# @prisma/client exports nothing until this runs. Nothing in the api entrypoint
# imports it today (scoped-db.ts is not yet reachable from main.ts), but the
# generate is here rather than later so the failure mode is a build error
# instead of a runtime one the first time a controller touches the database.
RUN pnpm --filter @neoting/api exec prisma generate

# tsc emit — see apps/api/tsconfig.build.json for why a plain tsc works here.
RUN pnpm --filter @neoting/api build

# Fail the build, loudly, if the compiled output ever gains a RUNTIME import of
# the contracts package. That package is consumed as .ts source through its
# exports map; Node cannot load it, so this would deploy green and crash on
# first request with ERR_UNKNOWN_FILE_EXTENSION. Comments mentioning the
# package are fine — only import/require statements are the bug.
RUN if grep -rnE "(from|require\()\s*['\"]@neoting/contracts" apps/api/dist/; then \
      echo "ERROR: compiled output imports @neoting/contracts at runtime. See tsconfig.build.json." >&2; \
      exit 1; \
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
