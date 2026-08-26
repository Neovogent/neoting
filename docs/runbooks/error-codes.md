# Runbook — error codes

Governance §13.4: *"Each code has a runbook page (symptoms → diagnosis queries →
fix → prevention); user-facing errors show the code; **new codes require a
runbook entry to pass review**."*

This file exists because the ID LAW batch added two families and had that gate to
clear. **It covers the codes added since, not every code in the contract** — the
older families (`ING`, `EXT`, `RTE`, `OTP`, `PUB`, `PRP`, `MDL`, …) are still
owed the same treatment, and each should land here as its lane touches it rather
than in one retrospective sweep nobody reads.

The authoritative list of codes is the `ErrorCode` enum in
`packages/contracts/openapi.yaml`. If a code is there and not here, this file is
the one that is behind.

---

## `NT-EXP-001` — nothing to export

**Status:** `422` · **Surface:** `POST /v1/exports`

**Symptom.** An accountant picks a client and a period, presses Export for VT,
and gets a refusal naming the period.

**What it means.** No document reached **Published** inside that range for that
client. Under D42, Published is an internal state meaning approved and released
for export — so this is almost never an export bug. It is either the wrong dates
or work that has not been released yet.

**Diagnose.**

```sql
-- Where did this client's documents actually stop?
SELECT state, inbox, count(*)
  FROM documents
 WHERE business_id = :businessId
   AND received_at >= :periodStart AND received_at < (:periodEnd::date + 1)
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

A pile in `READY` is the common answer: the documents are coded and waiting for
the super admin to release them (D44). A pile in `FAILED` is an extraction
problem wearing an export costume — follow `NT-EXT-*` instead.

**Fix.** Release the batch, or widen the period. Nothing to change in code.

**Prevention.** The export screen should show the Published count for the chosen
period *before* the button is pressed. A refusal that could have been a disabled
button is a refusal we chose to ship.

---

## `NT-EXP-002` — capability link revoked or expired

**Status:** `410` · **Surface:** `GET /d/{code}`

**Symptom.** An accountant types a code out of a VT row and gets "this link is
no longer available" instead of the document.

**What it means.** Exactly what it says, and the distinction from `404` is
deliberate: `404` is a code that never existed, `410` is one that did. This is
the one place the contract does **not** hide existence, because the code is
CSPRNG-generated and rate-limited (so it is not a useful oracle) while an
accountant holding a dead link genuinely needs to know it was revoked rather
than assume they mistyped it.

**Diagnose.**

```sql
SELECT id, document_id, business_id, expires_at, revoked_at, access_count, last_accessed_at
  FROM document_links WHERE code = :code;
```

`revoked_at` set → someone approved a `document.revoke-link` proposal; the audit
trail names who and why. `expires_at` in the past → the practice's
`practices.document_link_ttl_days` elapsed.

**Fix.** Re-export the period. A new export mints a live link, and the code will
be different — that is the point of revocation, not a defect.

**Prevention.** Revocation is an approved proposal precisely so the review card
names every document whose link is about to stop working. A revocation that
surprised someone means the review was not read, not that the mechanism failed.

⚠ **This route is unauthenticated by design and the code is the whole
authorisation.** Investigating a report here, never paste a live code into a
ticket, a chat message or a log line.

---

## `NT-EXP-003` — export batch over the synchronous cap

**Status:** `422` · **Surface:** `POST /v1/exports`

**Symptom.** A wide period, or a first export for a client with a backlog, is
refused with a number.

**What it means.** ID generates exports **synchronously**, on purpose — a
download button that works beats an export pipeline that mostly does. The cap is
what keeps that honest.

**Fix.** Export in smaller periods. The files import into VT's Universal Input
Sheet independently, so two months in two files is not worse than one file; it
is two imports.

**Prevention.** The refusal must name the cap and the actual count. A truncated
file that looked complete is the failure this whole surface is designed against
(SoT §24.3.4) — **never** silently emit fewer rows than were asked for.

---

## `NT-BIL-001` — no active subscription

**Status:** `402` · **Surface:** any entitlement-gated operation

**Symptom.** A client uploads and is told their subscription is not active.

**What it means.** `businesses.subscription_status` is not `ACTIVE` or
`TRIALING`. Entitlement is enforced in the **service layer**, never in
`scopedDb` or an RLS policy — see the prevention note, it is the important part.

**Diagnose.**

```sql
SELECT id, name, stripe_customer_id, subscription_status, plan, subscription_current_period_end
  FROM businesses WHERE id = :businessId;
```

Then compare against Stripe's own view of that customer. Stripe is the source of
truth; this table is a projection written only by `POST /v1/webhooks/stripe`. A
disagreement means a webhook was missed, not that the client is unsubscribed —
check Stripe's event log for failed deliveries before telling anyone their card
declined.

**Fix.** Replay the missed event from the Stripe dashboard. If the card genuinely
failed, the client fixes it in the Stripe customer portal
(`POST /v1/billing/portal-sessions`); Stripe's own dunning has already emailed
them.

**Prevention — the part that matters.** Reading and **exporting** must survive a
lapse; only new uploads stop. D32 commits to export at cancellation, and
entitlement inside RLS would break that promise invisibly: the tenant would not
see a billing message, they would see an **empty workspace**, and their own
records would appear to have been deleted. That is why this check lives in the
service layer and must stay there.

---

## `NT-BIL-002` — already subscribed

**Status:** `409` · **Surface:** `POST /v1/billing/checkout-sessions`

**Symptom.** A second checkout is refused for a business that already has an
active subscription.

**What it means.** A guard against double-charging a client who pressed the
button twice, or who reached the subscribe screen from a stale tab.

**Fix.** Send them to the Stripe customer portal instead — card changes,
invoices and cancellation all live there, and we deliberately build none of the
three.

**Prevention.** The subscribe call-to-action should not render for a business
whose `subscription` is active. `BusinessSummary.subscription` exists so the UI
can know that without a second request.

---

## A note on codes this file does not add

**Stripe webhook signature failures are `NT-INT-001`, not a new code.** The
`INT` family is inbound-integration auth, which is exactly what a webhook
signature is. A separate billing code for it would make an `NT-INT-001` alert
ambiguous in the other direction, and the two incidents — "Meta's signature
failed" and "Stripe's signature failed" — genuinely share a runbook: verify
against the **raw** body, before parsing, and check whether a proxy re-serialised
it.
