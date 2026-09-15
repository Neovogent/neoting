# Build brief — connect the four ledgers, production-ready

**Written:** 13 September 2026 · **For:** whoever builds this (agent or engineer) · **Decided by:** Shakib

---

## ⚠ Read this before you read CLAUDE.md, or you will refuse this work

**Initial Delivery has shipped.** This is the second release.

The repo does not know that yet. `CLAUDE.md` and `docs/Source_Of_Truth.md` still present **D42** as current law — *"No ledger API, no auto-publish. Export is the sole egress."* That was true for ID and is **no longer the governing decision**. If you read it and conclude this brief is out of scope, you have read a stale file, not a contract.

**Shakib: `CLAUDE.md` and the SoT need updating to say ID has shipped and what the second release contains.** Until that happens every agent entering this repo will hit the same wall. That edit is the first task in the list below.

**What does NOT change:** the export lane stays. VT Transaction+ has no API and never will, and file export remains the permanent answer for every ledger in Tier C of `docs/research/ledger-input-api-request-list.md`. You are **adding** a second egress, not replacing the first.

---

## The goal, in one paragraph

A UK accounting practice connects a client business's ledger once. From then on, when an accountant approves a coded document in Neoting, the transaction is created in that client's books through the vendor's API, **with the original receipt attached to it**, and the vendor's own reference comes back as proof it landed. Four platforms: **Xero, QuickBooks Online, Sage Business Cloud Accounting, FreeAgent.** Target is **production-ready for a real client's books**, not a demo.

---

## What already exists — read these first

| Thing | Where | State |
|---|---|---|
| `LedgerAdapter` interface | `apps/api/src/modules/publishing/ledger-adapter.ts` | ✅ **Complete and correct.** Do not redesign it. `PublishBillRequest` already carries supplier, category, currency, `totalPence`, `taxPence`, date, reference and an attachment *reference*. Returns `externalRef` + `attachmentSent` |
| `DemoXeroAdapter` | same module | ✅ Working fixture proving the whole path. Keep it — it is what the test suite runs against |
| `selectLedgerAdapter(env)` | same module | ✅ The seam where real adapters drop in. No call site changes needed |
| `publish.batch` executor | `apps/api/src/modules/validation-dedupe/proposals/publish-batch.ts` | ⚠ Currently **releases for export only** and never calls a ledger. This is where the ledger lane gets re-enabled |
| `Integration` table | `prisma/schema.prisma` | ✅ Has `kind`, `orgRef`, **`tokenRef`**, `tokenExpiresAt`, `health`, `lastSyncAt`, error fields, `isActive`. Unique on `(businessId, kind)` |
| `IntegrationKind` enum | `prisma/schema.prisma` | ✅ Already contains `XERO`, `QUICKBOOKS`, `SAGE`, `FREEAGENT` — **no schema change needed for any of the four** |
| `ReferenceSync` table | `prisma/schema.prisma` | ⚠ **Table only — there is no code behind it.** `integrationId`, `listKind`, `payload` (JSON), `syncedAt`, unique on `(integrationId, listKind)`. The service is yours to write |

**What does not exist at all:** any OAuth flow, any callback route, any token exchange, any refresh scheduler, any connection UI, any real vendor adapter. That is the bulk of this job.

**Credentials and API detail, already gathered — you should not need to visit any vendor site:**
- `.env.integrations` (repo root, gitignored) — client IDs, secrets, redirect URIs, sandbox IDs for all four
- `docs/research/ledger-api-build-reference.md` — auth models, endpoints, attachment limits, money formats, rate limits, per-vendor traps

---

## Invariants you may not break

These come from `CLAUDE.md` and are not negotiable:

- **Money is integer pence. No floats, anywhere.** Lint-enforced. ⚠ Three of the four vendors put money on the wire as a JSON number. Every adapter needs its own conversion boundary, built with the same care as `exports-public-api/canonical/money.ts`.
- **No state change outside the ActionProposal / Review → Approve path.** Approve is unreachable until Read-review has been opened, **enforced server-side**. A ledger connection must not create a second way in.
- **Every Prisma query goes through `scopedDb(ctx)`.** An unscoped query is a tenancy leak and a CI failure.
- **Zod at every boundary — including adapter responses.** Vendor JSON is untrusted input. Parse, don't trust.
- **No secrets in the diff.** Not in `.env`, not in a fixture, not in a comment.
- **UTC in storage, Europe/London in rendering.**

And two rules the adapter interface exists to enforce — they are written out in `ledger-adapter.ts` and you should read them there:

1. **No external HTTP call may hold a tenant transaction open.** The adapter runs in the engine's **post-commit follow-up**, never inside the effect. The executor writes `publishes` rows `QUEUED`; the follow-up resolves each to `SUCCEEDED` or `FAILED` in its own short transaction. A batch is up to 500 items.
2. **A per-item failure is a result, not a throw.** A batch of 40 where item 12 is rejected must publish the other 39 and land item 12 on the Rejected surface with a reason. Throw only when the world is broken.

**Stop and ask Shakib before:** any change to `prisma/`, `packages/contracts`, `packages/component-grammar`, `packages/tokens` or `packages/validators` (these are LAW — a contract-change issue must be approved *before* a PR opens); any auth or permission logic; adding a dependency; any public API contract.

---

## Build order

Shakib has chosen **all four at once**. That is the instruction. But the four adapters sit on one shared layer, and building that layer once — and proving it — before fanning out is how "all four at once" is done competently rather than four times over.

### Stage 0 — housekeeping
Update `CLAUDE.md` and `docs/Source_Of_Truth.md` so they state that ID has shipped and describe this release. Every agent after you depends on it.

### Stage 1 — the shared layer (this is the actual work)

Platform-agnostic, used by all four:

- **OAuth 2.0 authorisation-code flow** — a connect endpoint that redirects to the vendor, and a callback that exchanges the code for tokens. One connection per client business, keyed `(businessId, kind)` — the table already enforces that.
- **Token vault.** ⚠ `Integration.tokenRef` is a **reference, not a token** — nothing is stored in the database. **AWS Secrets Manager is already wired into the infrastructure** (`infra/envs/*/`, injected into ECS via `valueFrom`), so `tokenRef` should point at a secret there. **No schema change needed — keep it that way.**
- **Atomic refresh with rotation.** ⚠ Xero, QuickBooks and Sage all **rotate refresh tokens** — the old one dies the moment it is used. Persist the new one atomically or the connection is permanently lost. This is the single most likely source of a silent, unrecoverable bug in this whole job.
- **Refresh scheduler** — tokens expire on very different clocks (see the reference doc; QuickBooks rotates every 24 hours, FreeAgent's lasts ~20 years).
- **`ReferenceSync` service** — pull categories/nominal codes, suppliers, tax rates and bank accounts into the existing table so coding matches the client's own chart. ⚠ Use QuickBooks' **Change Data Capture** rather than re-reading lists; its reads are metered and this pipeline is read-heavy.
- **Connection UI** — a practice connects, sees health, and can disconnect. Intuit **requires** a disconnect URL.

### Stage 2 — the four adapters

Each implements `LedgerAdapter` behind `selectLedgerAdapter(env)`. Per-vendor endpoints, limits and traps are all in `docs/research/ledger-api-build-reference.md`; the highlights that will bite:

| | Watch for |
|---|---|
| **Xero** | ⚠ Idempotency window is only **6 minutes**. ⚠ ~98 float-typed money fields. ⚠ An organisation may hold only **two uncertified apps** — a client already on Dext plus one other tool cannot add us. ✅ Best attachment story: real file **and** a clickable `Url`. ✅ `accounting.attachments` scope is granted |
| **QuickBooks Online** | ⚠ **No idempotency at all** — `DocNumber` is the only duplicate guard, so generate and store it yourself. ⚠ `realmId` arrives on the callback, not in the token — store it or nothing can be routed. ⚠ No URL field: bytes or nothing. ⚠ Capture `intuit_tid` from every response header and log it |
| **Sage Accounting** | ✅ **7-day idempotency window** — the most forgiving. ⚠ Sage Accounting **Start cannot take purchase invoices** and Start is what practices put their smallest clients on; probe capability and fall back to `other_payments` with a recorded reason |
| **FreeAgent** | ✅ Money is decimal **strings** — no conversion risk. ⚠ **5 MB attachment limit**, the tightest of the four; our intake accepts photos that exceed it, so downscaling is mandatory. ⚠ Breaking change **1 December 2026** on bank-transaction explanation attachments — build against the new endpoint from day one |

### Stage 3 — production readiness

Shakib's answer was **"ready for a real client's books"**, so this stage is in scope, not optional:

- **Duplicate protection** that works per-vendor given the idempotency table above.
- **Read-back reconciliation before release.** ⚠ Several platforms recompute tax server-side and hand back something different from what was sent. Compare and surface a mismatch rather than assuming success.
- **`attachmentSent` must be honest.** Where a vendor rejects the file, say so — never claim an attachment that did not travel. D43 depends on this.
- **Retry behaviour** — 429s and timeouts are `retryable`; a vendor saying no is not.
- **The QuickBooks App Assessment Questionnaire** — about an hour. Every answer it wants (hosting region, breach history, MFA, credential storage, data isolation, token strategy, retry behaviour, connection estimate) is already in our published privacy notice at `neoacc.neovogent.com/legal/privacy-notice`.

---

## Testing — drive it in Chrome, end to end

A green unit suite proves nothing here. The only test that counts is the whole journey, in a real browser, against the real sandboxes.

**Sandboxes are already provisioned** — IDs in `.env.integrations`. Intuit's is **Sandbox Company GB** (region GB, `9341457906234565`); ⚠ ignore the auto-created US one.

For **each** of the four, with Claude in Chrome:

1. Start the app locally (`docker compose up -d`, `pnpm db:migrate && pnpm db:seed`, `pnpm dev`).
2. Sign in as a practice user and open the connection screen.
3. **Click connect and complete the vendor's consent flow in the browser.** Confirm you land back on our callback and the `Integration` row is written with a live `tokenRef`.
4. Confirm `ReferenceSync` populated — categories, suppliers, tax rates.
5. Take a seeded document through the real path: read → code → **Read review opened** → **Approve**.
6. **Open the vendor's own UI in Chrome and confirm the transaction is there** — correct supplier, correct total to the penny, correct tax, and **the receipt visibly attached to it**. A screenshot of the vendor's screen showing the attached document is the acceptance evidence for each platform.
7. Check `publishes` shows `SUCCEEDED` with the vendor's reference in `externalRef`.

**Then break it on purpose**, because these are the paths that fail in front of a paying accountant:
- Revoke the connection at the vendor and confirm we fail with a readable reason rather than a stack trace.
- Force a token refresh and confirm the rotated token persists — reconnect afterwards to prove the old one was replaced, not orphaned.
- Publish a batch where one item is rejected; confirm the rest land and the failure carries a reason.
- Send an oversized attachment to FreeAgent and confirm `attachmentSent` reports **false** honestly.

⚠ **Do not create test data in a real client's books at any point.** Sandboxes only until Shakib says otherwise.

---

## Definition of done

- All four connect, sync reference data, post a transaction and attach the source document — evidenced by screenshots of each vendor's own UI.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass.
- No float touches money anywhere in the new code.
- No unscoped Prisma query.
- Every vendor response parsed through Zod.
- No secret in the diff.
- Token rotation proven by reconnecting after a refresh, not assumed.
- The four failure paths above each produce a readable reason on the Rejected surface.
- `CLAUDE.md` and the SoT updated so the next person is not told this work is forbidden.

---

## Report back with three things

Per `CLAUDE.md`, in plain English, no jargon:

1. **What now behaves differently** — what an accountant can do that they could not before.
2. **What you could not check, and why** — especially anything only provable against a real client's ledger.
3. **What you need from Shakib next.**
