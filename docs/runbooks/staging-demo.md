# Runbook — staging as a demo environment

**Status:** current as of 19 Aug 2026 · **Owner:** Shakib · **Related:** METH_MODE.md Stage 15, issue #146,
`docs/DEMO_SCRIPT_2026-08-21.md` (the local demo, which is the plan of record)

Staging is a **flex, not a dependency**. The 21 Aug demo runs from a laptop
(`docs/DEMO_SCRIPT_2026-08-21.md`). This runbook is how staging gets to a
comparable state, and what it can and cannot show once it is there.

---

## 0. What staging can and cannot demo

| Beat | Staging | Why |
|---|---|---|
| Login, `/v1/me`, context header | yes | `AUTH_MODE=session` + `SESSION_SECRET` (§1) |
| Documents, inboxes, chases, approvals, bank, publish — as API | yes | the whole spine is deployed |
| WhatsApp arrival | yes | real HMAC webhook, fixture media fetcher |
| Web upload → extract → Review → Approve | yes | `OBJECT_STORE=s3`, `INGEST_QUEUE=bullmq`, `EXTRACTOR=demo` |
| Email arrival (`doc@`) | no | `EMAIL_SOURCE=fixture` — the S3 poller is a separate process with no ECS service (`services.tf` says so) |
| PDF hardening | no | `DOCUMENT_GUARD=fixture` — qpdf is deliberately not in the image |
| **Anything in a browser** | no | see §5 — this is the real limit |

**§5 is the headline: there is no deployed frontend.** `edge.tf` says it outright
— `app.` and `portal.` are deliberately not built, `apps/web` was to run on
Vercel for the sprint, and it does not today. The API also has no CORS surface
(`main.ts` never calls `enableCors`), on purpose: locally the Vite dev proxy
makes the session cookie first-party. So staging demos through `curl`, not
through a screen, unless §5 is done first.

---

## 1. The secret values (once, out of band)

`SESSION_SECRET`, `PORTAL_LINK_SECRET` and `PORTAL_SESSION_SECRET` are injected
from `/neoting/staging/auth`. Terraform owns the secret's **shape**, never its
values — `aws_secretsmanager_secret_version.app` carries
`ignore_changes = [secret_string]` so an apply cannot overwrite a live key
(`secrets.tf` explains at length).

**Order matters.** A task definition naming a JSON key the secret does not hold
fails at task start with `ResourceInitializationError` — which reads like a
broken image and is not. So: put the value, *then* apply.

`put-secret-value` replaces the **whole** JSON. Omitting a key deletes it, so
write all four:

```bash
# 1. compose the full group. file://, never an inline --secret-string:
#    an inline value lands in shell history and in the CloudTrail request.
{
  echo '{'
  echo '  "session_secret": "'"$(openssl rand -hex 32)"'",'
  echo '  "otp_pepper": "'"$(openssl rand -hex 32)"'",'
  echo '  "portal_link_secret": "'"$(openssl rand -hex 32)"'",'
  echo '  "portal_session_secret": "'"$(openssl rand -hex 32)"'"'
  echo '}'
} > /tmp/auth.json

# 2. write it
aws secretsmanager put-secret-value \
  --secret-id /neoting/staging/auth \
  --secret-string file:///tmp/auth.json

# 3. DELETE THE FILE. It holds four live signing keys.
rm -f /tmp/auth.json

# 4. confirm the keys exist without printing them
aws secretsmanager get-secret-value --secret-id /neoting/staging/auth \
  --query SecretString --output text | jq 'keys'
```

Rotating `session_secret` logs every staging session out. Fine here; in prod it
needs a dual-key verify window (the ROTATION banner in `secrets.tf`).

Console note: an AWS Identity Center (SSO) session cannot read this secret. The
KMS key policy matches `role/nt-*` and `user/Mubashir`, and an SSO role ARN
matches neither — it fails at the KMS layer with `AccessDenied` while the secret
itself is perfectly readable. Use an IAM principal, or add the SSO ARN pattern
to `kms-secrets.json.tftpl`. Do not widen the grant to the account root.

---

## 2. Apply, then deploy

Merging a PR that touches `infra/envs/staging/**` auto-applies on `main`
(`TERRAFORM_AUTO_APPLY=true`).

**The apply and the stage-9 deploy race on the same push, and the deploy usually
wins.** That matters here: the deploy reads the *latest ACTIVE revision* of the
`nt-staging-api` family, swaps the image, and registers a new revision from it.
If it reads the family before the apply has registered the revision carrying the
new environment, staging gets the new code with the **old** environment and looks
fine.

So after the apply reports success:

```bash
gh workflow run check.yml --ref main     # re-runs stage 9 against the new revision
```

and then prove which environment is actually serving — `services-stable` and a
200 from `/healthz` do **not** prove it (that is the #90–#107 incident: CI stayed
green while staging sat pinned at build #89 for eighteen deploys):

```bash
# what the SERVICE is running, not what the family's latest revision is
td=$(aws ecs describe-services --cluster nt-staging --services nt-staging-api \
       --query 'services[0].taskDefinition' --output text)

aws ecs describe-task-definition --task-definition "$td" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text

aws ecs describe-task-definition --task-definition "$td" \
  --query 'taskDefinition.containerDefinitions[0].secrets[].name' --output text
```

The `image` tag is a commit SHA (ECR tags are immutable — `compute.tf`), so
"which commit is in staging" is answerable from that one field.

---

## 2b. Create the application's database role — ONCE, before the api can serve

⚠ **Do this before believing a green deploy.** Until 19 Aug 2026 the `nt_app`
role did not exist in the staging database and the api task carried no database
credential at all, so every DB-backed request answered 500 while `/healthz`
returned 200 and CI stayed green. `db-app-role.tf` generates the password and
says "the migration step consumes it" — no migration step ever did.

```bash
netcfg=$(aws ecs describe-services --cluster nt-staging --services nt-staging-api \
           --query 'services[0].networkConfiguration' --output json)

task=$(aws ecs run-task --cluster nt-staging \
  --task-definition nt-staging-migrate --launch-type FARGATE \
  --network-configuration "$netcfg" --started-by "app-role" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["node","apps/api/dist/db/app-role.js"]}]}' \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster nt-staging --tasks "$task"
aws ecs describe-tasks --cluster nt-staging --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode'          # must be 0
```

Idempotent — re-run it after a migration adds tables, and to repair the role.

The script asserts in SQL that the role holds neither `SUPERUSER` nor
`BYPASSRLS` and `RAISE EXCEPTION`s if it does, because either grant makes every
policy in `prisma/` inert *silently* — a tenancy leak returns more rows, it does
not throw. `prisma db execute` returns no rows, so a non-zero exit is the only
channel that assertion has.

**Follow-up worth doing after the demo:** this belongs in the deploy pipeline
between `migrate` and the service update, exactly as CI's stage 4a2 does it for
the test database. It is an operator step today only because changing the deploy
path two days before a client demo is the riskier of the two options.

---

## 3. Seed the demo cast

`prisma/seed.ts` opens with `TRUNCATE ... RESTART IDENTITY CASCADE`, so it is
re-runnable and needs no `migrate reset` — which is just as well, because
Governance §1.3 forbids `migrate reset` anywhere but a laptop.

It runs as a **command override on the migrate task definition**, not a task
definition of its own: that family already carries the schema owner's credential
(the only role that may `TRUNCATE`), and it holds that credential for the seconds
a task runs rather than the life of a service (`services.tf` explains why the
master credential lives nowhere else).

```bash
# the network configuration is READ from the api service — subnet and SG ids are
# Terraform's to know, and a hardcoded copy is wrong the first time they change
netcfg=$(aws ecs describe-services --cluster nt-staging --services nt-staging-api \
           --query 'services[0].networkConfiguration' --output json)

task=$(aws ecs run-task --cluster nt-staging \
  --task-definition nt-staging-migrate --launch-type FARGATE \
  --network-configuration "$netcfg" \
  --started-by "seed-manual" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["node","apps/api/dist/db/seed.js"]}]}' \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster nt-staging --tasks "$task"
aws ecs describe-tasks --cluster nt-staging --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode'          # must be 0

aws logs get-log-events --log-group-name /nt/staging/migrate \
  --log-stream-name "migrate/migrate/${task##*/}" \
  --limit 100 --query 'events[].message' --output text
```

`run-task` returns HTTP 200 with an empty `tasks` array and a populated
`failures` array when placement fails, so an empty `$task` means it never
started — check `failures`, do not read the exit code.

**The guard.** `apps/api/src/db/seed.ts` refuses unless `NEOTING_ENV` is one of
`local`, `dev`, `staging` — an allow-list, so an unset or renamed environment
refuses too. It then relaxes `NODE_ENV` for the child process only, because
`prisma/seed.ts`'s own guard keys off `NODE_ENV=production`, which in this repo
means "the production *build*" and is set on staging deliberately for parity.
`apps/api/src/db/seed-environment.ts` carries the full reasoning. The order —
assert, then relax — is the whole safety property.

**What the seed does not do:** it writes document *rows*, not S3 *objects*. The
docs bucket stays empty, so previews and thumbnails 404 for seeded documents on
staging. Documents uploaded *after* the seed are real end to end.

---

## 4. Smoke the golden path

`scripts/smoke/staging-golden-path.sh` runs it. Everything below the login is
proposal-gated, so this is also a live test of the constitution:

```bash
scripts/smoke/staging-golden-path.sh                                       # the staging edge
NT_SMOKE_BASE=http://localhost:3000 scripts/smoke/staging-golden-path.sh   # or a local api
```

It checks, in order: `/healthz` · login with a wrong password is refused · login ·
`/v1/me` carries the practice and the in-scope businesses · documents, chases,
proposals and bank transactions are readable and seeded · **approve without
review is refused server-side** · review then approve succeeds · logout ·
the session is dead afterwards.

Beat 5b of the local script — the constitution demo — is the one worth watching:
a refusal of approve-before-review from a *deployed* environment is the claim
"nothing changes state without a named human" being true rather than asserted.

---

## 5. What is missing for a browser demo on staging

Three things, in order of cost. None is Stage 15 scope; recorded here so the
next person does not rediscover them.

1. **No hosted frontend.** `edge.tf` leaves `app.` and `portal.` unbuilt on
   purpose (pointing them at the ALB would 404 behind a valid certificate,
   which "looks deployed" — the worst state). `apps/web` needs a host.
2. **No CORS.** `main.ts` never calls `enableCors`, deliberately: locally the
   Vite proxy makes `/v1` first-party. A browser on any other origin cannot
   call the staging API at all. Serving the SPA from the same origin as the API
   avoids needing CORS; anything else needs a real allow-list plus
   `credentials: true`, and the session cookie is `SameSite=Lax`, so a
   cross-site XHR would not send it even then.
3. **The email lane.** `EMAIL_SOURCE=fixture` until the S3 poller gets an ECS
   service.

Until then: staging proves the spine, the laptop demos the product.
