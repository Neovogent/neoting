# publishing/ledger — the live ledger connection (D50)

**Built:** 15 September 2026 · **Decision:** D50 (supersedes D42) · **Brief:** `docs/ledger-connect-build-brief.md`

## What this is

A practice connects a client business's books once; thereafter an **approved**
document becomes a transaction in that client's ledger with the original receipt
attached, and the vendor's own reference comes back as proof. Four platforms:
Xero, QuickBooks Online, Sage Business Cloud Accounting, FreeAgent.

⚠ **Export is not retired and never will be.** VT Transaction+ has no API and
neither does anything else in Tier C of `docs/research/ledger-input-api-request-list.md`.
This is a **second** egress. Every string on this lane has to survive that
reading, and `publish-batch.ts`'s export arm still says *released for export*.

## The four rules that govern every file here

1. **No state change outside Review → Approve.** Nothing in this directory
   posts a transaction. `publishBill` is reachable only from
   `validation-dedupe/proposals/publish-follow-up.ts`, which the engine calls
   **after** an approved `publish.batch` commits. The connection surface manages
   credentials and reads lists; it has no publish method, and giving it one
   would be the second door the whole spine exists to prevent.
2. **No external HTTP call holds a tenant transaction open.** Every vendor call
   sits between short `scopedDb` transactions, never inside one. The comments
   marked "⚠ THE VENDOR CALL" are where that is load-bearing.
3. **A per-item failure is a RESULT, not a throw.** `HttpLedgerAdapter` catches
   even a vendor module that throws, because a bug in one adapter must not take
   a batch of forty down. The only throw left is the world being broken.
4. **Money is integer pence, and `ledger-money.ts` is the only boundary.**
   Three of the four vendors put money on the wire as a JSON number.

## Where the tokens live, and why it is not where the brief said

The brief asked for one **Secrets Manager secret per connection**. That was
taken to Shakib on 15 Sep 2026 and he chose otherwise, because the brief's own
premise does not hold:

- Secrets Manager *is* wired — for PLATFORM credentials, at TASK START, through
  the ECS agent's `valueFrom`. That mechanism cannot carry a value minted when a
  practice presses Connect and replaced on every rotation, and the task role is
  deliberately granted no Secrets Manager read at all.
- `infra/envs/<env>/secrets.tf` says in capitals that a client's Xero refresh
  token must never be written there, for two reasons that still hold:
  **$0.40/connection/month** (~£400/month at 1,000 clients, against an
  £8.50/month product) and a **tenancy boundary enforced by IAM instead of by
  RLS**, which is the inversion Governance §5.2 exists to prevent.

So: **the tokens are sealed with AES-256-GCM and the ciphertext lives in the
`integrations.token_ref` column that already exists.** The one secret is the
platform key, `INTEGRATION_TOKEN_KEY`, which belongs in the `auth` group beside
`SESSION_SECRET`. No schema change (which the brief did ask for), no
per-connection cost, tenancy stays on RLS.

⚠ **Rotating `INTEGRATION_TOKEN_KEY` does not re-seal anything.** Every practice
would have to reconnect every client. `token-vault.ts` carries a `v1` prefix so
a staged rotation can be built; it does not exist.

## The files

| File | What it owns |
|---|---|
| `token-vault.ts` | seal/unseal, the state HMAC, constant-time compare |
| `oauth.ts` | authorisation-code flow, signed `state`, token exchange and refresh, Intuit discovery |
| `token-store.ts` | read → refresh → **conditional** persist; health |
| `vendors.ts` | the four as DATA — endpoints, scopes, limits, idempotency windows |
| `ledger-config.ts` | env → credentials, and the two vendors whose HOST changes with sandbox |
| `ledger-money.ts` | integer pence ⇄ the wire, both directions |
| `ledger-http.ts` | one bearer, one Zod parse, one honest `retryable` |
| `attachment.ts` | fetch, downscale, or say why it could not travel |
| `reference-sync.ts` | the client's own accounts/suppliers/tax rates/bank accounts |
| `xero.ts` · `quickbooks.ts` · `sage.ts` · `freeagent.ts` | the per-vendor half |
| `http-ledger-adapter.ts` | the `LedgerAdapter` router — one implementation, four ledgers |
| `ledger-connections.*` | the connect/sync/disconnect surface |
| `refresh-scheduler.ts` | keeps an **idle** connection's refresh token alive |

## ⚠ The callback must live on the host that holds the SESSION

Found 17 Sep 2026, on the first consent that got far enough to fail properly.

`LedgerConnectionsController.callback` calls `context.require()` — the vendor's
redirect has to arrive carrying the practice's session. The session cookie is
set with **no `domain`** (`auth-tenancy/auth.controller.ts`), so it is
**host-only**, and the web app calls the API **same-origin**
(`VITE_API_BASE_URL` is deliberately unset in `deploy-web.yml`). The cookie
therefore exists on `neoacc.neovogent.com` and nowhere else.

The four applications were registered against `api.neoting.neovogent.com`. Both
names serve the same API behind CloudFront, so every request *worked* — except
the one that needed a cookie. Every vendor's consent ended on
`?connectionError=Authentication+required`, after a correctly formed request and
a completed sign-in, which reads like a broken integration and is a hostname.

⚠ **`SameSite` is a red herring here and cost time.** `lax` already permits a
top-level GET navigation; a **host-only** cookie is not sent to a different host
at any `SameSite` value. Do not go looking at the cookie flags.

The fix is `local.app_host` in `infra/envs/staging/edge.tf`, which
`APP_ORIGIN` and all four `*_REDIRECT_URI` values are now built from, plus one
re-registration per vendor portal. ⚠ **A redirect URI must match byte for byte**,
so the portals and the task definition move together or the consent 400s at the
vendor instead.

## ⚠ The four things most likely to be got wrong next

1. **Rotation.** Xero, QuickBooks and Sage retire the old refresh token the
   moment it is used. `token-store.ts` persists the new one with
   `updateMany({ where: { id, tokenRef: <exactly what we read> } })` —
   optimistic concurrency on the ciphertext itself, so a second process cannot
   install a token the vendor has already retired. `ledger-lane.integration.test.ts`
   asserts that `where` clause directly, because nothing else can see it.
2. **`LedgerAdapter` is obtained from a FACTORY.** A real adapter reads its own
   client's sealed tokens through `scopedDb`, so it needs a tenant context and
   cannot be a boot-time singleton. `LedgerAdapter` itself is unchanged; only
   who constructs one is (`publishing/select-ledger-adapter.ts` carries the two
   rejected alternatives).
3. **`tokenExpiresAt` on the row is a PROJECTION.** The authoritative access
   expiry is inside the sealed blob. The column exists for the screen and the
   sweep; ageing it does not make the store refresh.
4. **`attachmentSent` must stay honest.** Where a vendor will not take the file,
   the publish still succeeds and the result says `false` with the reason
   logged. Claiming an attachment that did not travel makes D43 unverifiable.

## Per-vendor, the bits that bite

- **Xero** — ⚠ **no sandbox**: a developer connects a REAL organisation, so the
  only safe target is Xero's own **Demo Company (UK)**, and the connection
  screen says so because no flag can. 6-minute idempotency window (short enough
  that a slow retry duplicates — `InvoiceNumber` is the guard that outlives it).
  ~98 float money fields. Two-uncertified-app limit per organisation, invisible
  until it blocks. Bills are created **DRAFT** — the practice's own Xero
  approval workflow is theirs, and that is one line in `xero.ts`, deliberately
  not an environment variable.
- **QuickBooks Online** — ⚠ **no idempotency at all**; `DocNumber` is the only
  guard. `realmId` arrives on the CALLBACK, not in the token. Reads are metered,
  so reference sync uses **Change Data Capture** after the first pull.
  `UnitPrice` overrides `Amount`, so only `Amount` is ever sent. `intuit_tid` is
  captured off every response.
- **Sage** — ✅ 7-day idempotency. ⚠ **Start cannot take purchase invoices**, and
  Start is what practices put their smallest clients on: the adapter probes by
  attempting and falls back to `other_payments`. Access tokens last ~5 minutes,
  which is why the store is consulted per item and not per batch.
- **FreeAgent** — ✅ decimal strings, attachment on the same call, a refresh token
  that effectively never expires. ⚠ **5 MB cap**, the tightest, so downscaling
  is mandatory. ⚠ PDFs go up as the non-standard **`application/x-pdf`**.
  The 1 Dec 2026 breaking change is on BANK-TRANSACTION EXPLANATION attachments
  and does not touch bills, which is what we post.

## Tests

```bash
pnpm --filter @neoting/api test -- ledger           # unit, offline
docker compose up -d && pnpm db:migrate
pnpm --filter @neoting/api test -- ledger-lane      # real DB + a real HTTP vendor
```

`ledger-lane.integration.test.ts` stands up a server speaking FreeAgent's shapes
over a real socket and drives connect → sync → publish → attach → rotate →
revoke, plus the four deliberate breakages. Ids are prefixed **`led_`** — a stem
no other suite shares in either direction, because Prisma compiles `startsWith`
to an UNESCAPED `LIKE` and `_` is a wildcard there.

⚠ **It cannot prove a vendor accepts our JSON.** Only the vendor can, through a
consent journey that needs a human with a sandbox password. That half is
recorded as owed rather than implied.

## Current state, honestly

✅ **LIVE on staging since 15 Sep 2026** — `LEDGER_ADAPTER=http`, real
credentials in `/neoting/staging/ledger`, all four offered on the client
Connections tab. The boot gates passed, which is what proves the sealing key and
the applications are genuinely valid rather than merely present.

✅ **All four reach their real consent screen since 17 Sep 2026.** Xero's
`invalid_scope` was OUR scope string: `accounting.transactions` is a BROAD scope,
retired for every app created after 2 March 2026, and this app was created on
13 September. Xero's granular replacement for creating a bill is
**`accounting.invoices`**; `vendors.ts` now asks for that.

⚠ **Two traps left behind by getting that wrong**, both recorded in
`docs/runbooks/ledger-connections.md`:

1. **Never probe Xero scopes one at a time.** `offline_access`, `profile` and
   `email` are OIDC modifiers valid only alongside `openid`, so a solo probe of
   any of them answers `invalid_scope` and means nothing. The 15 Sep probe read
   three false refusals that way and cost a day aimed at a portal setting that
   does not exist.
2. **`app.connections` must stay OUT of the request** even though it is granted
   and `resolveOrgRef` calls that endpoint. It is non-tenanted — client
   credentials only — and adding it re-breaks the consent.

⚠ **No transaction has appeared in any vendor's own screen yet.** All four stop
at the vendor's sign-in for want of a test company to consent as. That is the
acceptance evidence the brief asks for and it is still owed.

✅ Built and proven against a real database and a real HTTP vendor: the shared
layer, all four adapters, the connection surface, the refresh sweep, and the
ledger arm of `publish.batch`.

⚠ **Local runs still need a localhost callback per vendor.** Every application
is registered against `https://api.neoting.neovogent.com/...`, so a laptop needs
`http://localhost:3000/v1/integrations/<vendor>/callback` added at each portal.
**FreeAgent's is added** (15 Sep 2026). ⚠ On STAGING none of that is needed —
the registered URIs are the staging ones, which is why the live test got
further than the local one did.

⚠ **Staging does not run this lane**: `LEDGER_ADAPTER=demo` there, and the
twelve new keys are allowlisted in `scripts/check-env-parity.mjs` until the
infra PR lands them in the task definitions with REAL values.

## TODO

- [x] **DONE, 17 Sep 2026 — Xero's `invalid_scope`.** It was not a portal
      grant. `accounting.transactions` → `accounting.invoices` in `vendors.ts`;
      both research docs corrected. ⚠ `accounting-platform-api-access-guide.md`
      had the right mapping in a table BEFORE the build and it was not carried
      into the code — the research was read, that line was not applied.
- [ ] The four vendor screenshots — the acceptance evidence the brief asks for.
      Blocked on a test company per vendor to consent as, not on code.
- [ ] The infra PR: a `ledger` secret group + the four redirect URIs and
      `LEDGER_SANDBOX` on `services.tf`, then drop the twelve allowlist entries.
- [ ] The **QuickBooks App Assessment Questionnaire** (~1 hour). Every answer is
      already in the published privacy notice; discovery and `intuit_tid` are
      implemented because it asks about both by name.
- [ ] Xero's `Url` field — the second half of D43 on that platform (a clickable
      link *and* the file). Needs the capability-link service, which is another
      module's seam.
- [ ] Supplier matching is exact-on-normalised-name; SoT §17.1 wants fuzzy +
      VAT number with confirmation. Creating a contact is currently part of the
      approved publish rather than its own decision.
- [ ] Update this file on exit — it is how the next session picks up.
