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

## `NT-PRM-001` — actor lacks permission for this action kind

**Status:** `403` · **Surface:** `POST /v1/action-proposals/{id}/approve` · **Added by:** stage A12

**Symptom.** A member of the practice approves a `publish.batch` or a
`chase.send` and is told only the practice's super admin can.

**What it means.** D44, enforced where Governance §11.2 says it must be:
`assertCan(actor, 'publish.release', resource)` on the engine's approve path,
before the executor runs. Accountants and their team **compose and edit**; only
the firm's **super admin** releases — authorises a chase to send, or moves an
item Ready → Published. The check is `canRelease(role) && memberships.is_owner`
on the actor's **practice-wide** membership.

**This is not a tenancy refusal.** A proposal the caller cannot see is `404`
with `NT-VAL-001` and always was; RLS decides that first, and the caller never
reaches this code. A `403` means the proposal is theirs and the authority is
not — which discloses nothing, because every fact it implies is already on
`GET /v1/action-proposals/{id}` for that same caller.

**Diagnose.**

```sql
-- Who may release in this practice? Expect exactly one row.
SELECT u.email, m.role, m.is_owner
  FROM memberships m JOIN users u ON u.id = m.user_id
 WHERE m.practice_id = :practiceId AND m.business_id IS NULL
   AND m.role = 'PRACTICE_ADMIN' AND m.is_owner = true;
```

**Fix.** Ask the person that query returns to approve it. Nothing is lost by the
refusal: the proposal is not consumed, so the same reviewed proposal is still
approvable by them.

**⚠ If that query returns NO rows**, the practice has no one who can release.
Two known causes:

1. **A seeded demo database.** `prisma/seed.ts` gives `mem_priya` `is_owner`
   and the *login-able* demo admin `mem_shakib_demo` none, so on a seeded
   laptop the account you can sign in as composes but cannot release. Adding
   `isOwner: true` to that seed row is a `prisma/` change and therefore a
   contract-change issue (G7) — tracked in `apps/api/src/modules/approvals/CLAUDE.md`.
2. **An owner who has left.** There is no ownership-**transfer** operation in
   the contract yet. Until there is, the repair is a DBA `UPDATE` on
   `memberships.is_owner`, done deliberately and recorded — not a code change.

**Prevention.** A UI that hides the button is not an implementation of this
(Governance §11.2, in as many words), and hiding it alone would also be dishonest
— the action exists, the user simply may not take it. `BusinessMember` carries
`role`, `scope` and `isOwner` precisely so a screen can show who may release, and
this refusal carries a detail written to be shown to the person who read it.

---

## `NT-DOC-001` — rejected by a reviewer

**Status:** not a wire error · **Surface:** `documents.failure_code` · **Added by:** stage A12

**Symptom.** A document sits on the Rejected/Failed surface with this code and a
plain-English reason a colleague wrote.

**What it means.** **Nothing failed.** A human approved a `document.reject`
proposal, and the reason on the row is their words, verbatim — the contract
requires it (*"a rejection without a reason is not a rejection"*). This is the
only entry in this file that is not an incident, and it exists so that triage can
tell a decision apart from a defect: `NT-ING-004` means sanitisation refused the
bytes and `NT-EXT-001` means we could not read them, while this means we read it
fine and a person said it does not belong in these books.

**Why a new `DOC` family.** Every other document failure code names a subsystem
that failed. Reusing one here would tell an operator — and a runbook reader —
that the pipeline broke on a document it handled perfectly, and would make an
`NT-ING-*` alert ambiguous between "our sanitiser is refusing things" and "the
client's bookkeeper is busy". `Document.failureCode` is a free `string` in
`openapi.yaml`, so this code is a documentation decision, not a LAW change; it is
**not** in the `ErrorCode` enum and never reaches the wire as one.

**Fix.** None is needed. If the rejection was a mistake, `document.reprocess`
clears the code and the reason and returns the document to Ready or To Review —
reject and reprocess undo each other, which is why neither needs the super admin.

**Prevention.** Not applicable, deliberately. Do not alert on this code.

---

## `NT-AUTH-004` — email verification link not valid

**Status:** `401` · **Surface:** `POST /v1/auth/email-verification` · **Added by:** stage A14

**Symptom.** Someone clicks the link in their signup email and is told it is not
valid. Their account stays unusable: `auth.service.ts` refuses a session to an
unverified address, with the same `NT-AUTH-003` a wrong password gets, so from
the sign-in screen it looks like the password is wrong.

**What it means.** One code for six causes, deliberately: missing, malformed,
forged, minted for another purpose, naming a user that no longer exists or is
deactivated, or naming an address that has since changed. Splitting them would
answer "does this token name a real account here" for whoever is asking, which is
the question the whole login lane refuses.

**Diagnose.** The common cause is not an attack — it is a mail client that
wrapped the URL. The token is `base64url.base64url`, long, and clients break long
URLs across lines; a truncated token fails the signature and arrives here.

```sql
-- Is this address waiting on verification at all?
SELECT id, email_verified, deactivated_at, created_at
  FROM users WHERE email = :email;
```

`email_verified = true` already means the link worked and the person is looking
at a stale tab — treat it as `NT-AUTH-005`'s remedy, not this one. A row that
does not exist means the signup never completed; check whether
`POST /v1/practices` returned a `500 NT-SRV-001`, which is what it does when the
registered mailer cannot actually send.

**The other real cause: `SESSION_SECRET` changed.** The key is derived from it
(`signed-claims.ts`), so rotating it invalidates every outstanding verification
link — and every TOTP enrolment, which is the more expensive half. Check the
deploy history before hunting a bug.

**Fix.** Sign up again from the same address. Nothing needs correcting
server-side, and a stale link is not evidence of anything to fix.

**Prevention.** M9's signup screen should offer "resend the verification email"
so that this refusal has somewhere to go from. There is no resend operation in
the contract today — the remedy is a second signup, which the duplicate-signup
notice handles honestly, but it is worse copy than it needs to be.

---

## `NT-AUTH-005` — email verification link expired

**Status:** `401` · **Surface:** `POST /v1/auth/email-verification` · **Added by:** stage A14

**Symptom.** The link was genuinely ours and is more than 48 hours old
(`EMAIL_VERIFICATION_TTL_MS`).

**What it means.** Exactly what it says, and it is the one thing on this path
that is safe to say precisely. An expiry is a fact about a token its holder
already had, so it discloses nothing about who is registered — the same reasoning
that lets `NT-AUTH-002` distinguish an expired session from `NT-AUTH-001`.

**Diagnose.** Nothing to diagnose. If this fires on a link that is *not* two days
old, the clock on an API task is wrong — compare `date -u` inside the container
with a known-good source before looking anywhere else.

**Fix.** Sign up again to get a fresh link.

**Prevention.** 48 hours is chosen to survive a weekend and a spam folder. If
this code shows up often in logs, the mail is arriving late or in spam, and the
fix is deliverability (`docs/runbooks/`, SES suppression and DMARC) rather than a
longer TTL — a longer TTL just means a leaked mailbox is a standing key.

---

## `NT-AUTH-006` — enrolment refused, address not verified

**Status:** `409` · **Surface:** `POST /v1/auth/totp-enrolment` (and `/confirm`) · **Added by:** stage A14

**Symptom.** A user who knows their password is told to verify their email
before they can set up an authenticator app.

**What it means.** The password verified and the address did not. Enrolment
refuses an unverified account on purpose (issue #195): verification is what
proves the mailbox, and letting an unverified account enrol makes that check
decorative.

⚠ **This code is named rather than collapsed into `NT-AUTH-003`, and the reason
is worth understanding before anyone "tidies" it.** It is reachable *only* after
the password has already verified — so there is no enumeration left to protect,
and a user told merely "invalid credentials" would retype a correct password for
ever.

**Diagnose.**

```sql
SELECT email_verified, totp_secret_ref IS NOT NULL AS enrolled
  FROM users WHERE email = :email;
```

**Fix.** Follow `NT-AUTH-004`'s path: click the verification link, or sign up
again for a fresh one. Then enrol.

**Prevention.** M9's flow puts verification immediately before enrolment for
exactly this reason, so in the intended journey this refusal is unreachable. It
fires when someone bookmarks the enrolment screen or returns to a stale tab.

---

## `NT-AUTH-007` — enrolment refused, an authenticator is already set up

**Status:** `409` · **Surface:** `POST /v1/auth/totp-enrolment` (and `/confirm`) · **Added by:** stage A14

**Symptom.** A user tries to set up an authenticator and is told they already
have one.

**What it means.** `users.totp_secret_ref` is set. Re-enrolment is a
credential-reset flow with its own threat model and **this release does not have
one** — so this endpoint refuses rather than replacing a factor by accident.

⚠ **If the user genuinely cannot produce codes, this is the state that matters,
and the answer is a recovery code, not a re-enrolment.** Ten were shown once at
enrolment. `TotpEnrolmentService.recoveryCodesLeft(userId)` reports how many
remain.

⚠ **A recovery code cannot currently be SUBMITTED.** `SessionCreateRequest.totp`
is `pattern: '^[0-9]{6}$'`, so a nineteen-character recovery code is a `400` at
the controller and never reaches the verifier that would accept it. That is a
known contract gap, recorded in the module `CLAUDE.md` since A2 and **not closed
by A14** — so today a user in this state with a lost phone has no self-service
route back in, and the only remedy is an operator clearing the column:

```sql
-- LAST RESORT, and it removes the account's second factor entirely.
-- Confirm the person's identity out of band FIRST. They can then enrol again.
UPDATE users SET totp_secret_ref = NULL, totp_enabled_at = NULL WHERE id = :userId;
```

**Diagnose.** Confirm it is not the race: two tabs confirming one enrolment makes
the second answer this code, correctly, and nothing is wrong. The write is
conditional on the ref still being null precisely so the first one's seed is not
silently replaced.

**Prevention.** Widening `SessionCreateRequest.totp` (or adding a recovery
operation) is the fix that removes the SQL above from this page. It needs a
contract-change issue.

---

## `NT-AUTH-008` — enrolment session not valid

**Status:** `401` · **Surface:** `POST /v1/auth/totp-enrolment/confirm` · **Added by:** stage A14

**Symptom.** A user scans the QR, types the code, and is told the setup session
is no longer valid.

**What it means.** The `enrolmentToken` from the first step did not verify, has
expired (15 minutes, `TOTP_ENROLMENT_TICKET_TTL_MS`), or names a different user
than the credentials did.

**Why there is a token at all.** It carries the candidate enrolment so that
**nothing is written until a real code comes back** — see
`totp-enrolment-ticket.ts`. Writing at step one is what made a single mis-scan a
permanent lockout in the shape A14 removed.

**Fix.** Start the enrolment again. It costs nothing: no row was written, so
there is no half-finished state to clean up, and the previous candidate simply
expires. **This is the good failure** — the whole two-step exists so that this
refusal is recoverable instead of terminal.

**Diagnose.** If it fires *immediately* rather than after a delay, suspect
`SESSION_SECRET` differing between API tasks: the ticket is signed by whichever
task served `begin` and verified by whichever serves `confirm`. Both read the
same `/neoting/<env>/auth` secret, so a mismatch means a deploy in flight with
two task revisions live.

**Prevention.** Fifteen minutes is sized for scanning a QR and copying ten
recovery codes onto paper. If real users hit this, lengthen the TTL rather than
removing the ticket — the ticket is the lockout fix.

---

## A note on codes this file does not add

**Stripe webhook signature failures are `NT-INT-001`, not a new code.** The
`INT` family is inbound-integration auth, which is exactly what a webhook
signature is. A separate billing code for it would make an `NT-INT-001` alert
ambiguous in the other direction, and the two incidents — "Meta's signature
failed" and "Stripe's signature failed" — genuinely share a runbook: verify
against the **raw** body, before parsing, and check whether a proxy re-serialised
it.
