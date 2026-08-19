# Runbook — hosting `apps/web` on Vercel

**Status:** written 20 Aug 2026 · **Owner:** Shakib · **Related:** `docs/runbooks/staging-demo.md` §5,
`infra/envs/staging/edge.tf` (why `app.` and `portal.` are not built on AWS)

What it takes to put the workspace and the OTP portal on a URL a client can
open, talking to the deployed API. `edge.tf` always assumed this — *"apps/web
runs on Vercel with Deployment Protection for the whole sprint"* — it just never
happened.

---

## The one idea this rests on

**The browser must only ever talk to the Vercel origin.** Vercel proxies `/v1/*`
to `api.neoting.neovogent.com` server-side, so the page and the API share an
origin. That is the same trick `vite.config.ts` plays in dev, and it is what
makes everything else unnecessary.

Without it there are two independent blockers, and fixing only one gets you a
login that appears to succeed and then 401s on every subsequent call:

1. **No CORS.** `apps/api/src/main.ts` never calls `enableCors`, deliberately —
   the dev proxy means no CORS surface has to exist. A cross-origin SPA cannot
   call the API at all.
2. **`SameSite=Lax` on the session cookie** (`session-cookie.ts`). Even with CORS
   added and `credentials: true`, a cross-site XHR does not send a Lax cookie.
   Making it `SameSite=None` is an auth change with CSRF consequences, and it is
   not worth making for a hosting decision.

Proxying costs one file and changes neither the API nor the infrastructure.

Verified on the CloudFront side: the default cache behaviour uses
`Managed-CachingDisabled` + `Managed-AllViewerExceptHostHeader`, so cookies and
headers are forwarded to the origin in both directions. The one exception is
`/v1/reference/*`, which deliberately strips cookies (`edge.tf` explains why) —
a public, cacheable route, unaffected by any of this.

---

## What is in the repo

`vercel.json` at the repo root:

- **`buildCommand`** builds `@neoting/contracts` first. `apps/web` depends on it
  as a workspace package and its `dist/` is untracked, so a plain
  `pnpm --filter @neoting/web build` fails to resolve the types.
- **`outputDirectory`** is `apps/web/dist`.
- **`rewrites`**, in order — `/v1/*` and `/healthz` to the API, then everything
  else to `/index.html`. The catch-all is what makes a hard refresh of
  `/p/<token>` or `/clients/1/costs` work: `apps/web/src/lib/router.ts` is a
  hand-rolled history router, so those paths exist only in the client.
  Vercel checks the filesystem *before* rewrites, so `assets/`, `favicon.png`
  and `index.html` are still served as files.

---

## What you do in Vercel (about five minutes)

1. **New Project → import `Neovogent/neoting`.** Leave *Root Directory* as the
   repository root — not `apps/web`. The build needs the workspace.
2. Vercel reads `vercel.json` for the build, install and output settings. It
   picks pnpm up from `packageManager` in the root `package.json`.
3. **Environment Variables** — add for *Production* and *Preview*:

   | Name | Value |
   |---|---|
   | `VITE_API_ENABLED` | `true` |
   | `HUSKY` | `0` |

   `VITE_API_ENABLED` is **not optional and not defaulted.**
   `apps/web/.env.development` sets it, and Vite loads that file in *dev mode
   only* — `pnpm build` runs in `production` mode, so without this the deploy
   builds a perfectly working **synthetic** app that never calls the API. That
   is deliberate in the repo ("tests and built bundles stay synthetic unless
   told otherwise"), and it is the single most likely thing to waste an hour.

   Do **not** set `VITE_API_BASE_URL`. Unset means empty, which means relative
   `/v1/...` requests, which is what hits the rewrite. A value here bypasses the
   proxy and puts you back on the CORS path.

   Do **not** set `VITE_API_MOCKING=enabled` — that starts the MSW worker.

   `HUSKY=0` stops the root `prepare` script from trying to install git hooks in
   a build container.

4. **Deploy.**
5. **Protect it.** Settings → Deployment Protection → enable. This URL has a
   login wall in front of published demo credentials (`shakib@neoting.test` /
   `demo-neoting-2026` / `000000`, METH_MODE §7) and synthetic client data. It
   should not be indexable or open to the internet at large. Share it with the
   client by link with protection on, or turn protection off only for the
   window of the demo.

---

## Check it worked

```bash
curl -s https://<your-app>.vercel.app/healthz            # {"status":"ok"} — the proxy is live
NT_SMOKE_BASE=https://<your-app>.vercel.app scripts/smoke/staging-golden-path.sh
```

The smoke passing through the Vercel origin proves the whole chain: rewrite →
CloudFront → WAF → ALB → ECS → RDS, with the session cookie surviving the hop.

Then in a browser: open the root, log in with the cast card, and confirm the
context header names the practice. If the app loads but shows synthetic data
with a dev badge and never asks you to log in, `VITE_API_ENABLED` did not reach
the build.

---

## Known limits, stated so they are not surprises

- **Rate limiting sees one client.** The WAF rules in `edge.tf` are per-IP, and
  every request now arrives from Vercel's egress addresses. A rate rule that
  fires would throttle all users at once rather than one abuser. Fine for a
  demo; it needs `X-Forwarded-For`-aware rules before this is a real front door.
- **The email arrival beat does not work on staging** — `EMAIL_SOURCE=fixture`,
  because the S3 poller has no ECS service. WhatsApp and upload both do.
- **Seeded documents have no image.** The seed writes rows, not S3 objects, so
  previews 404 for them. Documents uploaded after the seed are real end to end.
- **This is still not the plan of record.** `docs/DEMO_SCRIPT_2026-08-21.md`
  runs on the laptop and has been rehearsed. Treat the URL as the thing you send
  afterwards, not the thing you present from, until it has been rehearsed too.
