# Runbook — hosting `apps/web` on CloudFront

**Status:** written 26 Aug 2026 · **Owner:** Shakib · **Supersedes:**
`docs/runbooks/vercel-web.md` · **Related:** `infra/envs/staging/web.tf`,
`infra/envs/staging/edge.tf`, `.github/workflows/deploy-web.yml`

Launch stage **S3**. The SPA moves off Vercel onto a private S3 bucket behind
its own CloudFront distribution, with the API proxied from the same origin.

---

## The one idea this rests on — unchanged from Vercel

**The browser must only ever talk to one origin.** `apps/api/src/main.ts` never
calls `enableCors`, deliberately, and the session cookie is `SameSite=Lax`
(`session-cookie.ts`). A genuinely cross-origin SPA therefore cannot
authenticate: you get a login that appears to succeed and then 401s on every
subsequent call.

Vercel solved this with a server-side rewrite. CloudFront solves it with cache
behaviours on one distribution:

| Path | Origin | Why |
|---|---|---|
| `/` and everything else | private S3 bucket, via OAC | the SPA |
| `/v1/*` | the existing ALB | the API, first-party cookie |
| `/d/*` | the existing ALB | capability URLs — see the warning below |
| `/healthz` | the existing ALB | the smoke probe |

⚠ **`/d/*` is the one that is easy to lose.** `GET /d/{code}` is served at the
origin **root**, not under `/v1` — `docs/launch/PLAN.md` records this, and it is
excluded from codegen on purpose. It is the link that makes an exported VT line
reach its source document (D43, stage A8), which is step 9 of the launch
walkthrough and the acceptance test for the whole product. Without its own
behaviour it matches the SPA default, gets rewritten to `/index.html`, and every
document link in every export returns the app shell with a `200`.

---

## What exists after `terraform apply`

- `nt-staging-web-252959251643` — private, versioned, SSE-S3, all four public
  access blocks on. Noncurrent versions expire after 7 days.
- A CloudFront distribution, `Component=web`, sharing the WAF ACL and the
  security-headers policy with the `api.` distribution (`edge.tf`).
- `nt-staging-web-spa-router`, a CloudFront Function.
- `app.neoting.neovogent.com` — A and AAAA aliases in Route 53.
- Two SSM parameters the deploy workflow reads:
  `/neoting/staging/web/bucket` and `/neoting/staging/web/distribution-id`.

**Verified before merge** (26 Aug 2026): `terraform plan` reports
**14 to add, 0 to change, 0 to destroy**. Nothing existing is touched — the
`api.` distribution, the ALB, the WAF and every alarm are left exactly as they
are.

---

## Why SPA routing is a CloudFront Function and not `custom_error_response`

The recipe everyone reaches for maps 403/404 to `/index.html` with a 200. **It
is wrong on this distribution and it fails invisibly.**

`custom_error_response` is a **distribution-level** property — CloudFront
applies it to every cache behaviour, including the ones pointing at the ALB. So
`GET /v1/documents/does-not-exist`, which the API correctly answers `404` with a
`problem+json` body, comes back as the HTML app shell with status `200`. Every
client Zod-parsing that response gets a parse error instead of a not-found, and
`GET /d/{revoked-token}` reports success for a capability URL that was
deliberately revoked.

A viewer-request function is attached **per behaviour**, so it touches the SPA
path and nothing else. The rule it applies: a final path segment containing a
dot is a real file; anything else is a client-side route from
`apps/web/src/lib/router.ts` and gets the shell.

---

## Deploying

`.github/workflows/deploy-web.yml` runs on push to `main` touching `apps/web/**`,
`packages/contracts/**`, `packages/tokens/**`, `packages/component-grammar/**` or
`pnpm-lock.yaml`, and on `workflow_dispatch`. **A rollback is a
`workflow_dispatch` from the commit you want live.**

It builds, uploads in two passes, invalidates, waits, then smokes three things.

⚠ **`VITE_API_ENABLED=true` is not optional and not defaulted.**
`apps/web/.env.development` sets it and Vite loads that file in *dev mode only*
— `pnpm build` runs in production mode. Without it the workflow succeeds,
publishes, and serves a perfectly working **synthetic** app that never contacts
the API and shows seeded demo data to whoever opens it. `VITE_API_BASE_URL` must
stay **unset** (unset means same-origin, which is what hits the `/v1/*`
behaviour) and `VITE_API_MOCKING` must stay unset (`enabled` starts the MSW
worker and the app answers itself).

**Why the upload is two passes, in this order.** Assets first: Vite writes
content-hashed filenames, so every asset the new `index.html` references already
exists by the time the shell is served. The reverse order leaves a window where
the shell asks for a chunk that is not there yet and the app white-screens.
Neither pass uses `--delete`, because that would remove the old chunks while
browsers mid-session still have the old shell cached.

`mockServiceWorker.js` is excluded from both passes. It only activates when
`VITE_API_MOCKING=enabled`, and not uploading it means a stray request 404s
rather than registering a service worker that answers the API from fixtures —
a failure that survives a hard refresh and looks like the API lying.

---

## Serving `neoacc.neovogent.com` — what Shakib has to do

Everything above is automatic. This part is not, and the reason is DNS.

Measured 26 Aug 2026:

```
neovogent.com          NS -> peyton.ns.cloudflare.com, ali.ns.cloudflare.com
neoting.neovogent.com  NS -> ns-{326,803,1428,2004}.awsdns-*   (Route 53)
neoacc.neovogent.com   NXDOMAIN
```

`neoacc.` is a name in the **Cloudflare** zone. This repository has no Cloudflare
provider, and the wildcard certificate does not cover it — `*.neoting.neovogent.com`
matches one label under `neoting.neovogent.com`, and `neoacc.neovogent.com` is
not under it at all.

We **delegate** it, exactly as `neoting.neovogent.com` was already delegated. The
alternative — hand-writing a CNAME to the distribution plus a CNAME for the ACM
challenge — was rejected, and not for effort. The validation CNAME must survive
**forever**, because ACM re-validates against it at every renewal. Delete it as
tidying-up and the certificate silently fails to renew about thirteen months
later, taking the customer-facing hostname down, with nothing reporting a
problem in between.

### Phase 1 — create the zone

Set the **variable default** in `infra/envs/staging/web.tf`:

> ⚠ **Not `terraform.tfvars`, and not `-var`.** `infra/.gitignore` ignores
> `*.tfvars`, and the CI apply job runs a bare `terraform plan -out=tfplan`
> with no `-var` and nothing in `TF_VAR_`. A tfvars value works on your
> laptop, never reaches CI, and the next apply on `main` reads `null` and
> plans to **destroy the hosted zone** — leaving the Cloudflare delegation
> pointing at a zone that no longer exists. The same applies to phase 3.

```hcl
web_public_zone_name = "neoacc.neovogent.com"
```

Merge and let CI apply, then read the nameservers:

```bash
cd infra/envs/staging
terraform output -json web_public_zone_nameservers
```

Four `ns-*.awsdns-*` names. **Plan is 15 to add** — the zone plus the 14 above.
No certificate is created, and the distribution is untouched.

### Phase 2 — delegate in Cloudflare

In the Cloudflare dashboard for **neovogent.com** → **DNS** → **Records**, add
**four** records, one per nameserver:

| Field | Value |
|---|---|
| Type | `NS` |
| Name | `neoacc` |
| Nameserver | one of the four from the output |
| TTL | Auto |

There is no proxy toggle on an NS record — if you see an orange cloud you have
picked the wrong type. Confirm from a machine that is not yours:

```bash
nslookup -type=NS neoacc.neovogent.com 8.8.8.8
```

Wait until that returns the AWS nameservers. **Do not skip this** — ACM DNS
validation blocks until the challenge is answerable, so a `terraform apply`
started before delegation is live hangs for its full timeout and CI's apply job
dies at 45 minutes having changed nothing.

### Phase 3 — turn it on

```hcl
web_public_zone_name      = "neoacc.neovogent.com"
web_public_zone_delegated = true
```

**Plan is 21 to add.** Terraform mints the certificate (SANs:
`neoacc.neovogent.com` + `*.neoting.neovogent.com`, so one certificate covers
both aliases), writes both validation records into their respective zones,
attaches the certificate and adds the alias. Apply takes 5–15 minutes because
`wait_for_deployment` is on.

`app.neoting.neovogent.com` keeps working throughout — the public name is
**appended**, never substituted, so there is always a known-good URL to compare
against while a delegation propagates.

⚠ **Never taint or recreate `aws_route53_zone.web_public` once delegated.** A new
hosted zone gets four new nameservers, the Cloudflare NS records then point at a
zone that no longer exists, and the hostname goes NXDOMAIN until someone
re-copies them by hand. It is the one resource here a human has to touch again.

---

## Check it worked

```bash
curl -sI https://app.neoting.neovogent.com/ | head -1        # 200, text/html
curl -s  https://app.neoting.neovogent.com/healthz           # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' \
     https://app.neoting.neovogent.com/app                   # 200, not 404
```

The workflow asserts all three after every deploy. Each covers a different half
of the design and each can fail while the others pass:

1. `/` proves the bucket, the OAC and the bucket policy.
2. `/healthz` proves the ALB behaviour, the origin-verify header and the ALB
   listener rule. **This is the one that catches the expensive mistake** — if the
   `custom_header` is wrong the SPA loads perfectly and every API call 403s,
   which reads as an auth bug for hours.
3. `/app` proves the CloudFront Function is attached and published.

Then in a browser: open the root, sign in, and confirm the context header names
the practice. If the app loads straight into a workspace with no login prompt,
open the network tab and look at where `/v1/me` actually went — that is the whole
diagnosis, and it means `VITE_API_ENABLED` did not reach the build.

---

## Known limits, stated so they are not surprises

- **Rate limiting still sees one client per edge, not per user.** The WAF rules
  in `edge.tf` are per-IP and were written for the `api.` distribution. They now
  front two distributions. A rate rule that fires throttles broadly rather than
  one abuser; it needs `X-Forwarded-For`-aware rules before this is a real front
  door under load.
- **The shared WAF ACL now protects two distributions.** `edge.tf`'s "ONE SHARED
  ACL" banner already says prod should split it per distribution; that is more
  true now than when it was written, because the portal's ruleset is meant to be
  tighter than the workspace's.
- **`nt-staging-ci-deploy` holds `PowerUserAccess`**, which is far more than a
  static-site deploy needs. A scoped role (`s3:PutObject`/`DeleteObject` on the
  web bucket, `cloudfront:CreateInvalidation` on the one distribution,
  `ssm:GetParameter` on `/neoting/staging/web/*`) is the right end state.
- **This is the staging environment**, and `docs/launch/PLAN.md` flags it as a
  standing risk: it was built to be disposable. Confirm its deletion-protection
  and backup posture before a customer's records live in it.
- **`vercel.json` is still in the repo.** It is harmless once the Vercel project
  is disconnected, and removing it is a separate change — do it when you turn
  the Vercel project off, not before, so there is a way back.
