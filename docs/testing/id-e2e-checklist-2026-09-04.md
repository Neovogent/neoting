# ID end-to-end manual test — checklist and evidence log

**Date:** 4 September 2026 · **Requested by:** Mubashir (voice note, 14:15) · **Tester:** Shakib
**Source:** PM voice note transcript (Bengali), item-for-item in the order spoken.
**Ground rule from the PM:** this is a *check*, not a bug-fixing session. Build the checklist, walk it, and produce: written report + screenshot per step + a screen-recorded video. Time budget: ~2 hours.

## How to read this file

Every step has a pre-verified **Code status** (what the repo actually implements, checked 4 Sep against `main` @ `920d8b2`) so you walk in knowing what *should* happen. Where the PM's spoken expectation does not match what is built, the row is flagged **⚠ MISMATCH** — report those as findings, not bugs. Rows marked **✅ proven** were already exercised live today (4 Sep, local stack) at API level; the manual pass adds the UI screenshot on top.

## 0. Environment prep (done once — already applied to this machine's `.env`)

Local gives you *visible* email evidence; staging (`https://neoacc.neovogent.com`) gives you *real* email evidence. Recommended: full pass locally with MailHog screenshots, then repeat the client-facing sends on staging with real inboxes.

| Key | Value | Why |
|---|---|---|
| `EMAIL_SENDER` | `smtp` | Every email lands in MailHog (http://localhost:8025) — screenshot-able. `demo` sends into an invisible in-memory outbox. |
| `SMS_SENDER` | `email` | Chase "SMS" goes through the email transport → visible in MailHog. (`aws` = real SMS wire; needs `SMS_ORIGINATION_IDENTITY`, staging is still on `email` pending carrier review.) |
| `EMAIL_SOURCE` | `mailhog` | Enables the email-intake test (step 6). Poller does **not** delete MailHog messages. |
| `OTP_MODE` | `demo` (leave) | Every second factor and portal code is `000000`. Real TOTP/emailed codes on staging. |
| `EXTRACTOR` | `demo` (leave, or `bedrock` for real extraction) | ⚠ `demo` fabricates supplier/date/total from the **filename hash** at 0.8 confidence — never judge extraction quality under demo. |
| `STATEMENT_READER` | `none` (leave, or `textract` + real S3 per `docs/runbooks/live-local.md`) | Under `none`, **CSV/XLSX statements still import**; PDF/photo statements are refused by name. |
| `BILLING` | `demo` (leave) | ⚠ A client created through intake has **no subscription → its uploads 402**. Use seeded clients (American Burger) for upload/pipeline steps, or run `BILLING=stripe` + `stripe listen`. |

Processes (three terminals): `pnpm dev` · `pnpm --filter @neoting/api dev:worker` · `pnpm --filter @neoting/api worker:email` (only for step 6).
Seeded logins: `shakib@neoting.test` / `demo-neoting-2026` / `000000` (owner — the only account that can Approve/release, D44) · `abdullah@neoting.test` (Standard — use to prove Approve is refused).
Fixtures: `fixtures/synthetic/` (statements 2.1–2.5 + invoices), `docs/runbooks/fixtures/meridian-statement-jul-2026.pdf`, `pnpm demo:email`.

---

## 1. Accountant registration → confirmation email with T&Cs

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 1.1 | Open `/signup`, fill practice name, name, email, password (≥12 chars) | T&C checkbox is **on the form**, linking `/legal/terms-of-service` + `/legal/privacy-notice`; accepted version `0.1` recorded as an audit row | screenshot of form + T&C checkbox | ☐ |
| 1.2 | Submit | Always lands on "check your email" (anti-enumeration: same screen whether or not the address was new) | screenshot | ☐ ✅ proven (202) |
| 1.3 | Open MailHog | **One email: "Confirm your email address for Neo Accounting"** with a `/signup/verify?token=…` link, 48 h expiry | screenshot of email | ☐ ✅ proven |
| 1.4 | Click the link | `/signup/verify` confirms; then `/signup/enrol` shows authenticator QR + 10 recovery codes; then `/signup/done` | screenshots | ☐ (verify ✅ proven via API) |
| 1.5 | — | — | — | — |

**⚠ MISMATCH to report:** the PM expects the confirmation email to carry terms & conditions. As built, **no email contains or links the T&Cs** — acceptance happens on the signup form. The welcome-email format he pushed (`docs/templates/client-welcome-email.md`, merged in #248) is **doc-only, wired to nothing**, marked *DRAFT — do not send* (VAT number placeholder unresolved; legal docs still draft). Decision needed: wire it (blocked on VAT no.) or accept form-based T&C acceptance for ID.

## 2. Accountant login / user flow after onboarding

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 2.1 | Sign in at `/app` with the new account | Three fields: email, password, **authenticator code** (`000000` locally). Session cookie 12 h | screenshot | ☐ ✅ proven (204) |
| 2.2 | Wrong password ×1 | Uniform `401` "check your details" — never says whether the account exists | screenshot | ☐ |
| 2.3 | Fresh account workspace | Honest empty states, zero clients. **No first-run tour** (tour exists only in the no-API synthetic `/demo` mode) | screenshot | ☐ |
| 2.4 | "Forgotten your password?" on login | Always "check your email" → MailHog "Reset your Neo Accounting password" (30-min link) → set new password → sign in. TOTP untouched | screenshots | ☐ |

**⚠ MISMATCH to report:** the PM said "every login sends a code to email". As built, **accountant login is TOTP (authenticator app) — no email code, ever**. The emailed six-digit code is the **client portal's** sign-in, not the workspace's. Also: lost-phone recovery does not exist (recovery codes can't be entered at login — known open gap in `auth-tenancy/CLAUDE.md`).

## 3. Add client → SMS? → email with T&Cs → client accepts and enters portal

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 3.1 | Clients tab → add client (company → contact → business-type questionnaire) | `201`; the intake **is** the invite — no separate send button. D47: no bank/ledger connection asked | screenshots of the 3 steps | ☐ ✅ proven (201) |
| 3.2 | Check MailHog | **One email to the client contact:** "*{Practice} has invited you to Neo Accounting*", with `/app/setup?setupToken=…` link, 7-day expiry. **No SMS. No T&Cs in the email** | screenshot of email | ☐ ✅ proven |
| 3.3 | Open the setup link | `/app/setup` asks the client's registered email → "send me a code" → MailHog "Your Neo Accounting sign-in code" (6 digits, 10 min; `000000` locally) | screenshots | ☐ ✅ proven (202 + email) |
| 3.4 | Enter code | 60-min portal session; onboarding walkthrough incl. questionnaire (if accountant skipped it) and **subscription step: Stripe Checkout £8.50 + VAT/month, paid by the client** (D48) | screenshots | ☐ |

**⚠ MISMATCH to report (two):** (a) "client added time SMS যাইতেছে কিনা" — **no SMS is sent on client add, by design**; ID cut SMS for invites, email is the invite channel, `SMS_SENDER` only governs chases. (b) The invite email carries **no terms & conditions** — nothing shown to the client to "read and accept" before entering, beyond the portal itself. If T&C acceptance by the *client* is required, that's an open product gap to raise.
**Staging caution:** staging Stripe is **LIVE mode** — a real card is charged. Use a 100%-off promotion code (`scripts/billing/create-promotion-code.ts`, see `apps/api/src/modules/billing/CLAUDE.md`).

## 4. Client portal walkthrough — uploads, team member, capture, settings

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 4.1 | Portal Home (`/portal`) | Outstanding asks + "Recently sent" with client-facing status words | screenshot | ☐ |
| 4.2 | Upload tab: drop a receipt image/PDF | Per-file accept/refuse with reasons (D46 flag-never-block); ⚠ under `BILLING=demo` an intake-created client 402s — use a seeded client, or note the 402 as correct entitlement behaviour | screenshot | ☐ |
| 4.3 | Capture tab | Live camera, multi-page tray, uploads real bytes | screenshot / phone video | ☐ |
| 4.4 | Settings → People: add a team member | Live add/remove (BUSINESS_ADMIN/USER_ADMIN manage); new person gets "you've been added" email (tokenless — signs in at `/portal` with address + code) | screenshots + MailHog | ☐ |
| 4.5 | Settings → other tabs | Business details / notification prefs / upload notes are **read-only by design** (no server path yet); Plan shows subscription + Stripe customer portal | screenshot | ☐ |
| 4.6 | Document approval in the client panel | **NOT BUILT live.** `/approve/:requestId` renders "unavailable in this release" when the API is on; the flow the PM saw is the synthetic front-end prototype only. No backend, deliberately (portal principals have no approval authority in the contract) | screenshot of the unavailable screen | ☐ |

**Confirms the PM's own suspicion:** he said "front-end সাজায়ে রাখছি, back-end বানাইছে নাকি কইতাছি না" — answer: **backend does not exist**; report it as such (contract change needed, not a bug).

## 5. Bank statement upload → scrape everything → match documents

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 5.1 | Bank tab (American Burger) → upload `fixtures/synthetic/2.1-meridian-statement-2026-08.csv` | Within ~1 min: Statements tab row with `assurance: complete`, `provenBy: balanceContinuity`; Transactions tab fills, all UNMATCHED. D41: completeness is *proven*, not confidence-guessed | screenshots | ☐ |
| 5.2 | Upload `2.2-…gap…csv` | `incomplete` with the **named finding** (`balanceBreak`, exact missing amount) | screenshot | ☐ |
| 5.3 | Re-upload 2.1 | `rowCount: 0` — duplicate import adds nothing (fingerprint dedupe) | screenshot | ☐ |
| 5.4 | PDF statement (`meridian-statement-jul-2026.pdf`) | Locally under `STATEMENT_READER=none`: **refused by name** (correct). With `textract`+real S3, or on staging: parses (proven 31 Aug: opening £4,520.00 / closing £4,348.65, 12 lines) | screenshot either way | ☐ |
| 5.5 | Upload matching invoice (`fixtures/synthetic/3.2-bidfood-2026-08-03.png`) | Document lands, extraction runs, **"Suggested bank match"** appears on the document (exactly-one-candidate rule; confidence 1.0 pence-equal / 0.9 within £1+10-day tolerance) | screenshot | ☐ |
| 5.6 | Confirm the match | Three-call Review → Approve dance; bank line leaves the unmatched set; `matchedBy: auto-suggester` | screenshots | ☐ |

Note: a confirmed match cannot yet be *broken* (`bank.unmatch` has no ProposalKind) — known gap, not a test failure. Statement **removal** is built but **dormant** (kind not in contract yet): the Remove button being disabled on live rows is correct, don't file it.

## 6. Email intake — forwarded invoice from a registered sender

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 6.1 | Start `pnpm --filter @neoting/api worker:email`, then `pnpm demo:email` (sends from `owner@americanburger.test`, a registered contact, with a PDF invoice attached) | Document appears in the Inbox **routed to American Burger**, notes email provenance, flows Processing → To Review/Ready | screenshots | ☐ |
| 6.2 | `pnpm demo:email --unregistered` | Document is **accepted but lands Unrouted** (D45 is enforced as routing, D46 never silently drops); routable only via "Move to client" through Review → Approve | screenshot | ☐ |
| 6.3 | Matched against bank | Same suggester as 5.5 — email-sourced invoice can match a statement line | screenshot | ☐ |

Staging note: the email poller has **no ECS service yet** (`EMAIL_SOURCE=fixture` on staging) — email intake is local-only for now; say so in the report.

## 7. Categorisation — no guess, no empty fields, confidence

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 7.1 | Open a processed document | Per-field values + per-field **confidence + provenance**; overall confidence = the *weakest* field, not the average | screenshot | ☐ |
| 7.2 | Category | Uncoded docs show "**Suggested category — not applied**" with confidence — an AI opinion is a suggestion attached to review, never a silent coding (ladder: accountant rule → practice default → client history → AI suggest/escalate) | screenshot | ☐ |
| 7.3 | Placeholder/zero checks | A placeholder supplier (`Unknown`, `—`, `n/a`…) or **£0.00 total blocks Ready** (PR #249; not retroactive — pre-fix stored docs may still sit on Ready until reprocessed) | screenshot | ☐ |

**⚠ MISMATCH to report:** the PM's "confidence up to 98%" has **no mechanical embodiment** — the confidence-threshold gate is a deliberately empty seam ("thresholds are eval-calibrated and do not exist yet"), and the honest measured categorisation accuracy on record is **~62.5–79%**. Do not represent 98% anywhere; flag it as an expectation-setting conversation.

## 8. Inbox states: In review → Ready → Publish

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 8.1 | Inbox tabs | **To Review · Ready · Processing · Published · Failed** (PM said "in review, ready, publish" — matches, plus Processing/Failed) | screenshot | ☐ |
| 8.2 | Fix a To Review doc's missing field | Stages a `document.update-coding` proposal → Read review → Approve → doc moves to Ready | screenshots | ☐ |
| 8.3 | Publish | Via chat "publish ready documents for <client>" or Approvals queue → `publish.batch` proposal → **owner-only** Approve (D44). Inbox's own Publish button is disabled live with a tooltip — correct, not a bug | screenshots | ☐ |
| 8.4 | As `abdullah@` try to Approve | Refused (`NT-PRM-001`) — D44 enforced server-side | screenshot | ☐ |
| 8.5 | Approve before opening Read review | Unreachable — server-enforced (hash echo) | screenshot | ☐ |

Language discipline for the report: **Published = approved-and-released-for-export** (D42). Never write "posted to ledger".

## 9. Export → VT import, with per-row source-document link (D43)

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 9.1 | Export tab → client + period → "Export for VT" | Two downloads: ZIP of headerless 7-column CSVs (one per date+direction, for VT `Transaction ▸ Journal ▸ Import…`) + source-document ZIP with manifest | screenshots + keep the files | ☐ |
| 9.2 | Open a CSV row | **Column B carries reference + `https://…/d/<code>` link** — the D43 cell the PM asked for, replicated onto every leg by VT | screenshot of the cell | ☐ |
| 9.3 | Paste the link in a browser | `GET /d/<code>` → 302 → presigned S3 → **the original invoice opens, sessionless**. (Already confirmed through the production edge, 2 Sep — `docs/…/exports` A10 record + PR #246) | screen recording of the click-through | ☐ |
| 9.4 | Import into VT Transaction+ | Rows land; unresolvable category codes travel bare with an `analysis-account-unprefixed` warning (manual mapping in VT) — known, not a failure | screenshots | ☐ |

## 10. Chase — SMS/email/portal notification for what's missing

| # | Action | Expected (as built) | Evidence | Result |
|---|---|---|---|---|
| 10.1 | Bank tab → unmatched line → compose chase (chat LIVE_CHASE card) or "Request statement" | Proposal shows the **exact message text** at Read review; the reviewed bytes are the sent bytes | screenshot | ☐ |
| 10.2 | Approve (as owner) | Send executes; with `SMS_SENDER=email` the message arrives in MailHog; Chases tab shows the board (+ SMS-outbox panel under `SMS_SENDER=demo`) | screenshots | ☐ |
| 10.3 | Single missing doc copy | SoT §8.2 verbatim: "*<Business> Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: <link>*" — **doc named + link**, as the PM asked | screenshot | ☐ |
| 10.4 | Multiple missing docs | **One grouped message listing each item** ("a, b and c") — not a bare count | screenshot | ☐ |
| 10.5 | Link check | `/p/<token>` — HMAC-signed, 7-day, grants nothing without the OTP. Not a third-party shortener (deliberate; a tiny-URL would hide the destination) | screenshot | ☐ |
| 10.6 | Open link → OTP → upload the asked doc | Emailed code (registered contact only, D45) → upload → **chase auto-closes** → accountant gets in-app notification | screenshots | ☐ |

**⚠ MISMATCH to report:** the PM said "no amounts in the SMS". The SoT §8.2 copy he signed off **deliberately includes the amount and date** per item — that's what's built and tested (`chase/sms-copy.test.ts`). What is genuinely never in a message: **credentials/OTP** (the code travels separately). If he now wants amounts out, that's an SoT change, not a bug.
Known scope limits (say so in the report): detection + accountant-initiated chases only; no reminder scheduler/quiet-hours yet; portal notification = the outstanding-asks list + in-app notification, not push.

---

## Already-proven summary (4 Sep, local, API-level — screenshots still owed by the manual pass)

| Flow | Proof |
|---|---|
| `POST /v1/practices` signup | `202`; "Confirm your email address" in MailHog |
| Email verification | `200 {"alreadyVerified":false}` |
| New-accountant login | `204` + `/v1/me` shows practice, `isOwner: true` |
| Client intake | `201`; "…has invited you…" email in MailHog to the contact; **no SMS** |
| Portal sign-in code | `202`; "Your Neo Accounting sign-in code" in MailHog |

## The findings list for the PM (report these, fix nothing)

1. **No T&Cs in any email** — signup email is verification-only; client invite email has none; the welcome template (#248) is unwired, DRAFT, and blocked on the VAT registration number.
2. **Accountant login has no email code** — it's TOTP by design; the email code is the client portal's.
3. **No SMS on client add** — email invite only; SMS exists only as the chase channel (and staging still delivers chases by email pending carrier registration).
4. **Client-panel document approval is not built** — synthetic prototype only; live shows "unavailable"; needs a contract change.
5. **Chase SMS includes the amount** — per SoT §8.2, contradicting the voice note; credentials never included (that part holds).
6. **98% confidence target doesn't exist in the product** — thresholds are an empty seam awaiting eval calibration; measured accuracy ~62.5–79%.
7. **First-run tour is synthetic-mode only** — a fresh live accountant gets empty states.
8. Known-and-correct oddities a tester will hit: statement Remove disabled (dormant kind), Inbox Publish button disabled live (chat/Approvals path instead), intake-created client 402s under `BILLING=demo`, PDF statements refused under `STATEMENT_READER=none`, `document.reprocess` doesn't re-run extraction, a confirmed bank match can't be broken yet.
