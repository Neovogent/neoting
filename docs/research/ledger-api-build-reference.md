# Ledger APIs — build reference

**Written:** 13 September 2026
**Purpose:** everything needed to write the four adapters without going back to the vendors' sites.
**Credentials:** `.env.integrations` in the repo root — gitignored, never committed.
**Companion documents:** `ledger-input-api-request-list.md` (who, and where we are with them) · `accounting-platform-api-access-guide.md` (the programmes and their gates)

> ✅ **Initial Delivery has shipped. This is in scope for the second release** (Shakib, 13 Sep 2026). D42 governed ID and no longer binds.
>
> ⚠ **`CLAUDE.md` and `docs/Source_Of_Truth.md` have not caught up** — both still present D42 as current law, so anyone reading them will conclude this work is forbidden. Updating them is the first task in `docs/ledger-connect-build-brief.md`.
>
> **The export lane stays.** VT Transaction+ has no API and never will; file export remains the permanent answer for every ledger in Tier C. This is a second egress, not a replacement.
>
> Anything below marked **not verified** was not confirmed against a live vendor page and must be checked before it is relied on.

---

## 0. What all four have in common

Every one of the four works the same way, and the shared layer is the real work — the adapters are thin on top of it.

1. **Connect.** The practice is redirected to the vendor, signs in, picks the client organisation, consents. Authorisation-code OAuth 2.0 on all four.
2. **Sync the lists.** Pull categories/nominal codes, suppliers, tax rates and bank accounts so our coding matches theirs. ⚠ **Correction:** `ReferenceSync` is a **database table only** (`prisma/schema.prisma`) — there is no service behind it. The table is ready; the code is not written.
3. **Post.** Create a purchase invoice / bill, then attach the source document to it.
4. **Record the vendor's own reference** as proof it landed — `LedgerPublishSuccess.externalRef`.

**The interface this fits behind already exists:** `apps/api/src/modules/publishing/ledger-adapter.ts`. ⚠ **Nothing else does** — there is no OAuth flow, callback route, token exchange, refresh scheduler or connection UI anywhere in the repo. `Integration.tokenRef` is a *reference*, and **AWS Secrets Manager is already wired into the infrastructure**, so tokens belong there and no schema change is needed. `PublishBillRequest` carries supplier, category, currency, `totalPence`, `taxPence`, date, reference and an attachment *reference* (never bytes). `DemoXeroAdapter` runs the whole path today with a fixture vendor.

**Two rules the interface exists to enforce**, and every adapter must honour:

- **No HTTP call inside a tenant transaction.** The adapter runs post-commit; the executor writes `publishes` rows QUEUED, and the follow-up resolves each to SUCCEEDED or FAILED in its own short transaction. A batch is up to 500 items.
- **A per-item failure is a result, not a throw.** Forty items where item 12 is rejected must publish the other 39. Throw only when the world is broken (no credentials); a vendor saying no, a timeout and a 429 are all `LedgerFailure` with `retryable` set honestly.

### ⚠ The money boundary is where adapters will bite

Money is **integer pence** everywhere in this codebase, lint-enforced. Three of the four vendors put money on the wire as a **JSON number**, which is a float. Every adapter needs its own conversion boundary with the same care as `exports-public-api/canonical/money.ts`, plus a read-back reconciliation before release — several platforms recompute tax server-side and will hand back something different from what was sent.

| Platform | Money on the wire |
|---|---|
| Xero | ⚠ `format: double` on ~98 fields |
| QuickBooks Online | ⚠ JSON decimal number. ⚠ `UnitPrice` overrides `Amount` when both are present |
| Sage Accounting | ⚠ `double`; sometimes returned as a string |
| **FreeAgent** | ✅ **Decimal strings** (`"total_value": "100.0"`) — the only one with no conversion risk |

---

## 1. Xero

| | |
|---|---|
| Docs | `developer.xero.com/documentation` · API reference under *Accounting API* |
| Portal | `developer.xero.com/app/manage` |
| Our app | `4d669651-02e3-464c-a5ee-6fac3f455cac` — Web app, standard auth code |
| Tier | Free. **0 of 5 connections**; a card on file lifts it to 50; certification for 1,000 |

**Auth.** Authorisation-code OAuth 2.0. Access token ~30 minutes. ⚠ **Refresh tokens rotate** — the old one dies the moment it is used, so the new one must be persisted atomically or the connection is lost. Refresh token life **60 days**. Tokens are keyed per user, not per organisation.

⚠ **Scopes: our app gets the new granular scopes only.** Xero's console states that apps created after **2 March 2026** have access to granular scopes only; older apps keep broad scopes until September 2027. Ours was created 13 September 2026. **`accounting.attachments` is in the granted list** — confirmed on the Configuration page, and re-confirmed against the live authorise endpoint on 15 Sep 2026 — so D43 is reachable. ⚠ **CORRECTION, 17 Sep 2026 — and it supersedes the 15 Sep correction that stood here, which was itself wrong.** `accounting.transactions` is a BROAD scope. It was retired for every app created after 2 March 2026, so this app never had it and no portal setting can grant it; Xero's granular replacement for creating a bill is **`accounting.invoices`**. `offline_access` is fine and always was — the 15 Sep probe tested it ALONE, and `offline_access`, `profile` and `email` are OIDC modifiers that are only valid alongside `openid`, so three of that probe's four refusals were artefacts of the method. The requested set is now `openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.attachments`. ⚠ `app.connections` is deliberately absent: it is NON-TENANTED and valid only with the client-credentials grant. `docs/runbooks/ledger-connections.md` carries the reasoning. The line below records what this document originally claimed and is left for the correction to be visible against: Also present: `accounting.transactions`, `accounting.contacts`, `accounting.settings`, `accounting.reports.*`, `app.connections`.

**Posting a bill.** `POST /api.xro/2.0/Invoices` with `Type: "ACCPAY"`. Status choices are `DRAFT`, `SUBMITTED` (Awaiting Approval), `AUTHORISED`. **Default to DRAFT or SUBMITTED** — the practice's own Xero approval workflow is theirs, not ours to skip. A bank-side payment is `POST /BankTransactions` with `Type: "SPEND"`.

**Attachments — the best of the four.** `POST /Invoices/{id}/Attachments/{filename}`, raw bytes. **Up to 10 files, 10 MB each.** ✅ Xero is the only platform offering **both** a real file attachment **and** a clickable `Url` field on the record — D43 satisfied twice over.

⚠ **Idempotency window is 6 minutes** — short. Retries beyond that can duplicate.

⚠ **An organisation may connect only two uncertified apps.** A client already running Dext plus one other tool cannot add us, and this is invisible until it blocks.

⚠ **Bulk Connections** — one consent covering many client organisations — is **Advanced tier only** (certification + security assessment + use-case approval). Without it a 200-client practice needs 200 consent journeys. This is the long pole.

⚠ **Training on Xero data is prohibited.** We answered "No" on the app form, and our privacy notice backs it with AWS's own Bedrock statement.

---

## 2. QuickBooks Online (Intuit)

| | |
|---|---|
| Docs | `developer.intuit.com/app/developer/qbo/docs/api/accounting` |
| Portal | `developer.intuit.com` |
| Workspace | Neovogent AI Solutions — `9341457906047710` |
| App | `8bf8dfee-d7b8-416c-80ec-14533724fdfa`, *in development* |
| Sandbox | **Sandbox Company GB `9341457906234565`** — region GB, QuickBooks Online Plus |

**Auth.** Authorisation-code OAuth 2.0 over OpenID Connect. ⚠ **Refresh token rotates every 24 hours** and lives **100 days**. Use Intuit's discovery document rather than hardcoding endpoints — the assessment questionnaire asks about this explicitly.

⚠ **`realmId` is the company identifier** and comes back on the callback, not in the token. Store it alongside the tokens; without it no API call can be routed.

**Posting a bill.** `POST /v3/company/{realmId}/bill`. A paid item is a `Purchase` with `PaymentType`. ⚠ **No idempotency support at all** — `DocNumber` is the only duplicate guard, so we must generate and store it ourselves.

**Attachments.** `POST /v3/company/{realmId}/upload`, multipart, then link via `AttachableRef`. **100 MB per request**, 17-type allowlist. ⚠ **There is no URL field on the record** — bytes or nothing, so where the file is rejected D43 degrades and `attachmentSent` must say so honestly.

⚠ **Reads are metered and this pipeline is read-heavy.** Design the caching in from the start, not later. Use **Change Data Capture** for incremental reference sync rather than re-reading lists.

⚠ **Capture `intuit_tid` from every response header** and log it. The questionnaire asks, and Intuit support will ask for it on any ticket.

⚠ **Platform Fees are charged based on the company address entered.** Nothing is charged now; know that it exists.

**Before production:** the **App Assessment Questionnaire** — roughly an hour. It asks for hosting location, breach history, MFA, credential storage, data isolation, token-refresh strategy, retry behaviour, error handling, expected connection count, and whether the app is public or private. Every one of those answers is already in our published privacy notice.

---

## 3. Sage Business Cloud Accounting

| | |
|---|---|
| Docs | `developer.sage.com/accounting` — v3.1 API reference |
| Portal | ⚠ **`developerselfservice.sageone.com`** — *not* `developer.sage.com/console`, which serves X3, Sage 200 Spain and Intacct only (§13 of the request list) |
| Our app | `836023aa-410f-4e17-8756-5142559457b9` |

**Auth.** Authorisation-code OAuth 2.0. Refresh token **31 days**, rotating. ✅ **Both the client ID and secret stay retrievable in the portal** behind *Show* — the only one of the four where nothing is a one-time reveal.

✅ **Partner Edition gives one grant covering every client a practice manages** — the same shape as FreeAgent's Practice API, and a major advantage over Xero's per-organisation consent.

**Posting a bill.** `POST /purchase_invoices`, or `POST /other_payments` for something already paid. ⚠ **Sage Accounting Start cannot take purchase invoices at all** — and Start is exactly the plan practices put their smallest clients on. Probe the capability and fall back to `other_payments` with a documented reason.

**Attachments.** `POST /attachments`, base64, linked to the invoice by `origin_id`. ✅ Accepts **PDF, GIF, JPG, JPEG, PNG** — and **TIFF**, which no other platform here takes. Sage's own UI allows **10 attachments per invoice at 2.5 MB each**; whether the API enforces the same cap is **not verified**.

✅ **A documented competitor gap.** Dext falls back to putting a *link* in the Details field on Sage Accounting because it publishes some items as Quick Entries, which cannot hold files. The API supports real attachments on purchase invoices. **Attaching the actual receipt here is something the market leader does not do.**

✅ **Idempotency with a 7-day window** — by far the most forgiving of the four.

---

## 4. FreeAgent

| | |
|---|---|
| Docs | `dev.freeagent.com/docs` |
| Portal | `dev.freeagent.com/apps/12548` |
| Access | ✅ **"accountancy practice managers only"** — the Accountancy Practice API is enabled |

**Auth.** Authorisation-code OAuth 2.0. ✅ **Refresh token effectively never expires (~20 years)** and ✅ **one grant covers every client the practice manages**. Sandbox is a hostname swap, no separate application.

✅ **Money is decimal strings.** The only platform in this market with no float-conversion risk. For a codebase whose central rule is integer pence, this is the gentlest place to build and prove the shared layer.

**Posting a bill.** `POST /v2/bills`, or `/v2/expenses` for an employee expense. Attachment is a **sub-object on the same call** — one request, not two, unlike everywhere else.

**Attachments.** ⚠ **5 MB limit** — the tightest of the four, and our intake accepts photos that will exceed it. Downscaling before send is not optional here. ⚠ The content type for PDFs is the non-standard **`application/x-pdf`**.

⚠ **Breaking change dated 1 December 2026:** bank-transaction explanations move to an array of up to 50 attachments via a new *Bank Transaction Explanation Attachments* endpoint, and the singular `attachment` attribute stops being returned. **Build against the new endpoint from day one.**

**Why it matters more than its market share suggests:** NatWest, RBS, Ulster Bank and Mettle customers get FreeAgent free, so penetration in UK micro-business is well above what the paid numbers imply.

---

## 5. Suggested build order, and why

| | Platform | Reason |
|---|---|---|
| **0** | **The shared layer** | OAuth flow, token vault with atomic rotation, refresh scheduler, per-organisation connection UI, reference sync. All five are platform-agnostic and all five are missing today. **This is the work; the rest are adapters.** |
| **1** | **FreeAgent** | ✅ Build here first. Decimal strings, a real sandbox, tokens that never expire, one grant per practice, and an attachment in the same call. The gentlest place to discover that the shared layer is wrong. |
| **2** | **Xero** | Ship here first. Where the customers are, best attachment story, free to pilot. ⚠ But the least forgiving place to learn: rotating tokens, a 6-minute idempotency window, ~98 float fields. |
| **3** | **Sage Accounting** | Best mechanics — 7-day idempotency, one grant per practice, no connection cap — plus the documented attachment gap we can beat Dext on. |
| **4** | **QuickBooks Online** | ⚠ No connection cap once the questionnaire clears, so it scales furthest. But metered reads and no idempotency mean the caching and duplicate-guard discipline must be designed in, not retrofitted. |

---

## 6. What is still unknown

| Unknown | Why it matters |
|---|---|
| Whether Sage's API enforces the UI's 10 × 2.5 MB attachment cap | Changes whether we downscale for Sage as well as FreeAgent |
| Xero granular-scope coverage for every call we need | The list looks complete, but it has not been exercised against a real organisation |
| Intuit's UK sandbox behaviour for VAT and multi-currency | The questionnaire asks whether we support both; we should know before answering |
| How many uncertified apps pilot practices' clients already have on Xero | The limit is two and it is invisible until it blocks a connection |
