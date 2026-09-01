# portal — the OTP client portal (server)

**Lane G** (chase engine + OTP portal) · **Source of Truth:** SoT §4 Stage 8.3–8.5, §6, §15 (tenancy) · **Stage:** METH Stage 9

## Purpose

The no-app client journey's server half. An SMS link plus six digits become a
session that can see exactly the chased items and upload against them — no app,
no account, no password. Everything a portal endpoint needs to know *who is
asking and what they may touch* lives here.

## ⚠ Initial Delivery (ID) — read this before the sections below

**The portal is an identity gate in ID, and D45 makes that a server rule.** OTP goes to the **registered** number, and only that number — plus **team members the client has added** — may upload. Anything else is refused.

- **Accept anything a phone can produce:** device camera capture or file upload; images, HEIC, PDF, XLSX, CSV, screenshots. The client should never have to convert a file to be heard.
- **Unacceptable documents are flagged, never blocked** (D46). The client is not stopped at the door because the AI doubts a file; the flag travels with the document and a human decides. A batch is **separated per file** and each is judged individually — never treated as one document.
- **Every rejection is visible and reasoned** (SoT §21): a legitimately-sent document that identity-gating refuses must show up on the Rejected/Failed view with a reason, and the sender must be told. A silent drop is the failure mode D45 is most likely to cause, and the one §4 Stage 1’s guarantee forbids.

## Contracts it must honour

- `packages/contracts/openapi.yaml` — `createPortalSession`, `getPortalContext`,
  `createPortalUpload`, the `portalSession` security scheme, `NT-OTP-001` /
  `NT-OTP-002` (**LAW**, G7)
- `prisma/` — `otp_sessions`, and the delegated policies in `prisma/sql/rls.sql`
  (**LAW**, G7). Stage 9 changed **nothing** in `prisma/`: the model and the
  policies were already there and were built to.

## ⚠ Bearer, not cookie — a recorded divergence

`METH_MODE.md` Stage 9 says *"issue portal cookie"*. `openapi.yaml` declares
`portalSession: {type: http, scheme: bearer}` and puts both authenticated portal
operations under it. **The contract wins (G7)**, so the portal credential is
`Authorization: Bearer <token>` and `openapi.yaml` was not edited to match the
prose. Anyone reading the plan and expecting `Set-Cookie` should read this line
instead. (It is also the better answer: the portal is a separate build entry
(D37) on a phone browser, and a bearer needs no CSRF story.)

## The invariant everyone gets wrong here: what the delegated RLS actually covers

`prisma/sql/rls.sql` has exactly **two** delegated branches, and both key on
**document** ids:

```
documents_delegated_upload    USING (scope='delegated_upload' AND id = ANY(granted) AND business_id IS NOT NULL)
                              WITH CHECK (scope='delegated_upload' AND business_id = app_business_id())
extractions_delegated_upload  USING/WITH CHECK (scope='delegated_upload' AND document_id = ANY(granted))
```

`chases`, `bank_transactions` and `otp_sessions` have **no** delegated branch.
Their policies go through `app_can_access_business()`, which begins
`app_session_scope() = 'user'`. **A delegated context reading any of them gets an
empty set, silently.** So `GET /portal/context` cannot read the chase under a
delegated context, and the bearer resolver cannot read the session row under one.

The honest division — say it this way, do not overclaim:

- **The delegated policies enforce the DOCUMENT boundary.** A portal session can
  read and write exactly the document ids in its grant, in its own business.
  That is a database guarantee.
- **The `otp_sessions` row enforces the CHASE boundary.** Chase and transaction
  reads run under the practice **SYSTEM** context (the worker pattern) and must
  be constrained **in the query** to `facts.chaseId`. That is an application
  guarantee resting on a row the server wrote, not on SQL.

`ScopeContextSchema` also **refuses** a `delegated_upload` context whose
`grantedItemIds` is empty — and a session's grant *is* empty until its first
upload. That is an ordinary state, so `delegatedScopeFor()` returns
`{ok: false, reason: 'no-granted-items'}` rather than throwing from the bottom of
a query.

**The resolution, and the upload path that depends on it:** `POST
/portal/uploads` derives the document id from its own signed intent
(`documentIdFor(uploadId)`, ingestion-routing) and calls
`PortalSessionService.grantItems` with it **before** completion. Completion under
the delegated context then writes and reads exactly that document and nothing
else.

## What is built (METH Stage 9)

| File | What it is |
|---|---|
| `portal.controller.ts` | The three contracted routes, and **exactly** those three. Thin: resolve the bearer, parse with the generated zod, call ONE service, map dates to ISO. A test pins the handler list, because a fourth route on this surface is a contract change (G7), not a convenience. |
| `portal-context.service.ts` | `GET /portal/context`. The chase + its transactions + the business name, read under the practice SYSTEM context and constrained to `facts.chaseId`, projected through the **chase module's own** `toChaseItem`. |
| `portal-upload.port.ts` | The `PortalUploadService` interface + `PortalUploadIntent`. The controller depends on this, not on the implementation, so it unit-tests with no object store, no Prisma and no signing secret. |
| `portal-upload.service.ts` | `PrismaPortalUploadService.createPortalUpload(facts, request, key)` — the delegated intent. Mirrors web upload's `createUpload` from ingestion-routing's *mechanisms*, and **grants the derived document id to the session before returning**. See "The delegated upload path" below. |
| `portal-session-token.ts` | The bearer. `base64url(claims).base64url(hmac)` — the house format, fourth instance. Claims `{otpSessionId, businessId, practiceId, expiresAtMs}`, secret `PORTAL_SESSION_SECRET`, TTL **60 min**. Missing/malformed/forged collapse to one `invalid`; `expired` stays distinct. Empty secret refuses to sign *and* to verify. |
| `portal-session.service.ts` | `createSession(linkToken, otp)` → verify link (chase seam) + OTP → resolve the chase → upsert `otp_sessions` → mint the bearer. `grantItems(facts, ids)` — the only thing that widens a session. |
| `portal-session-context.ts` | `PortalSessionContextResolver.resolve(authorizationHeader)` → `PortalSessionFacts`, plus `resolveOnboarding()`, `delegatedScopeFor()` and `systemScopeFor()`. **Two doors, not one door with a flag** — see below. |
| `chase-verdict.ts` | The pure chase-validation copy — `describeChaseMismatch`. See "The post-upload half" below. |
| `portal-upload-status.service.ts` | The post-upload read: document state + extraction + verdict, under the delegated scope for the document and the SYSTEM scope for the chase. **Unrouted** — no contract path, so no provider (see below). |
| `portal-upload-notifier.ts` | The accountant's `portal.upload` notification row (SoT §4 Stage 8.8). |
| `otp-attempts.ts` | **A2** — the attempt counter, the lockout and the minted-code compare. Pure. See below. |
| `portal-onboarding.service.ts` | **The invited client's way in** — `requestSignInCode` + `createOnboardingSession`, the two operations `openapi.yaml` published and no controller implemented until the S7 walkthrough hit the 404. Mints the code, hashes it, emails it, and exchanges it for a bearer. See below. |
| `portal.module.ts` / `tokens.ts` / `index.ts` | Wiring, DI symbols, the public seam. |

## The OTP is real, and it is counted (launch stage A2)

Until A2 the portal OTP was the literal string `'000000'` — the same code for
every client of every practice, published in this directory and in the seed —
and `otp_sessions.attempts` / `locked_until` were **read and written by
nothing**. This file said so out loud (*"METH Stage 9 says 'Rate-limit
nothing'"*), which was an acceptable demo decision and not a shipping one.

**Five wrong codes on one link, then fifteen minutes locked.** Tighter than the
sign-in lane's ten because there is no password in front of it: the link plus the
code IS the whole credential, so the budget for guessing it has to be smaller.

**A locked link gets the SAME `401 NT-OTP-001` as every other failure**, word for
word — never a `429`, never a distinct message. `openapi.yaml` mandates the
uniform 401 here, and the key is why: this counter lives on a row keyed by
`link_token_hash`, and that row exists only for a real chase, so any
distinguishable answer would confirm the link names something. (The sign-in lane
*does* answer `429`, because its counter is keyed on a string the caller typed
and so reveals nothing about who exists — `auth-tenancy/CLAUDE.md` has the full
argument. The two differ because the keys differ, not by accident.)

**⚠ A failed attempt now CREATES the `otp_sessions` row, and the row is
deliberately not a session.** Before A2 a row appeared only on success, so a
failure had nowhere to be recorded and the two columns were unreachable. The
counter row is written with `verified_at` NULL and `expires_at` = now, so
`PortalSessionContextResolver` refuses it on **two** independent checks — proven
against real Postgres in `portal-otp-lockout.integration.test.ts`, because
"counting a failure accidentally mints the credential that failing withheld" is
the way this could have gone badly. It is bounded: `link_token_hash` is
`@unique`, so one link can only ever produce one row.

**What is NOT counted:** a link token that does not verify. There is no chase
behind it, so no tenant to write under — and nothing to brute-force either, since
the token is 256 bits of HMAC. Counting it would let an anonymous caller create
rows by sending noise.

**⚠ THE ORDER OF CHECKS CHANGED, and it improved the timing story.**
`createSession` used to verify link and OTP together and resolve the chase only
after both passed — so a SUCCESS was measurably slower than any failure, which is
the distinction that matters. Counting needs a tenant anchor, so the chase now
resolves for every request whose link verifies. What is still distinguishable is
"this link verifies" (which its holder already knows); what is now
indistinguishable is right code versus wrong.

**`OTP_MODE=totp` compares against `otp_sessions.otp_hash` / `otp_expires_at`**,
not RFC 6238 — a client holding a forwarded link on a borrowed phone has no
authenticator app and never will, so the portal's factor is a one-time code we
mint and send, which is exactly what those two columns describe. The hash is a
plain SHA-256 and `otp-attempts.ts` is honest that six digits is 20 bits and
therefore trivially reversible by anyone holding the column: what it buys is that
the code is not sitting in the clear next to the row saying who it went to. The
real defence is the counter and the short expiry.

✅ **The invited-client half now mints that code** — `portal-onboarding.service.ts`
hashes it with `hashOtp` and sets `otp_expires_at`, which is what A2 said
whoever landed either route would have to do. The CHASE half still does not:
`modules/chase` (A13) sends the link and mints no code, so under
`OTP_MODE=totp` a chase link opens no session. That is still the honest state,
and it is now one gap rather than two.

## The five endpoints, and the decisions inside them

| Route | Auth | Side effect | Failure |
|---|---|---|---|
| `POST /v1/portal/sessions` | public (`security: []`) | `ingest` | one `401 NT-OTP-001` for every verification failure |
| `GET /v1/portal/context` | `portalSession` bearer | `none` | `401 NT-OTP-002` |
| `POST /v1/portal/uploads` | `portalSession` bearer | `ingest` | `401 NT-OTP-002` |
| `POST /v1/portal/sign-in-codes` | public (`security: []`) | `ingest` | **none — `202`, always** |
| `POST /v1/portal/onboarding-sessions` | public (`security: []`) | `ingest` | one `401 NT-OTP-001` for every verification failure |

This table read **three** rows until 28 Aug 2026. `openapi.yaml` published them in
S0's ID LAW batch, M6 built the screens against them, and no controller
implemented them — so the setup link an invited client was emailed reached a
screen whose first request 404'd. Growing this surface to five is the contract
being MET, not widened, which is the one direction that needs no issue first.
`portal.controller.test.ts` pins the list at five; a sixth is a G7 conversation.

Every write here is legitimately outside Review → Approve: the contract marks
all four `x-nt-side-effect: ingest`, the same standing as web upload —
submitting evidence, or opening a session for yourself, creates a new record and
changes no existing one. No chase and no document moves state from here.

**`Idempotency-Key` on `POST /portal/sessions` is required, parsed, and
deliberately NOT replay-cached.** The header is contract-required on every
mutation, so a missing or non-UUID one is a 400. But this operation is *public
and unauthenticated* and its response carries a **credential** — a replay cache
keyed on a caller-supplied header would hand a live portal bearer to anyone who
presented the same key, which is a worse hole than the one idempotency closes.
It is already idempotent where it counts: `link_token_hash` is `@unique`, so N
verifications of one link upsert ONE row and keep its grant. A fresh bearer per
call is not a duplicated side effect — each is an hour of its own. (The
*upload* mutation does pass its key through to the upload service, which is
bearer-authenticated.)

**`GET /portal/context` never returns an empty list.** `PortalContext.items` is
`minItems: 1`, and the `chase.send` executor resolved every transaction at
approve time — so no reachable item means a row that should not exist, not a
legitimate empty result. That is a **500 `NT-SRV-001`** (declared on the
operation), never a 200 the generated client would reject and never a 4xx that
blames the client. A missing business row is the same answer for the same
reason: `businessName` is required and is never invented.

**Order of checks on `POST /portal/uploads`: authenticate, then validate.** A
caller with no valid bearer gets `401 NT-OTP-002` and learns nothing about which
of their fields we would have objected to.

**Why the bearer carries the business and the practice.** `otp_sessions` is a
tenant table, so reading the row needs a scope context — which is what the row
would have told us. That bootstrap is broken by bytes we signed ourselves, the
same move `UploadClaims` makes. The **row still outranks the token**: the
resolver re-reads it and re-checks `scope`, `verifiedAt`, `expiresAt` and
`businessId`, so a session shortened or unverified after minting loses.

**The practice sweep, and why it exists.** `createSession` runs before any
session exists, and the Stage 8 link token carries only `{chaseId, exp}` — so
the chase's practice has to be *found*, not read. One unscoped query over
`memberships`+`users` (the sanctioned exemption, same argument as
`resolveSystemActor` #20 and `session-scope.ts`: neither table carries RLS)
yields every practice's SYSTEM actor, and each candidate context is asked
whether it can see this chase. First hit owns it. It cannot widen anything: the
chase id came out of an HMAC we signed and names exactly one chase. It costs one
scoped lookup per practice, on an endpoint hit once per client per chase.

**The actor a delegated write is attributed to.** The recipient contact's
provisioned user **when that user actually exists**, the practice SYSTEM actor
otherwise — decided once at session creation and stored in `otp_sessions.user_id`
so it cannot drift between the session and its uploads.
`documents.submitter_user_id` is an FK to `users` and every policy needs a
non-null actor, so the actor must be a real user row; a contact is not one and an
invented id is not an option. `Contact.userId` carries **no** foreign key, so it
is checked against `users` rather than trusted. SoT §3.3's phone-number-only
contacts have no user at all, so the SYSTEM actor is the common case — the same
actor every WhatsApp/email document already carries.
`otp_sessions.contact_id` is deliberately **NULL**: the link is forwardable, we
do not know who is holding it, and a guess in an audit column is worse than an
absence. Who we *asked* is `requested_from_contact_id` (SoT Stage 8.3).

## The invited client's way in — `sign-in-codes` + `onboarding-sessions`

`portal-onboarding.service.ts`. A11 creates the client and emails a **setup
link**; M6 built the screen it lands on; the seam between them belonged to
nobody until the S7 walkthrough found it the way a customer would — the link
arrives, the screen loads, and the request 404s.

**The setup token is the link, not the credential.** It names the workspace; the
six-digit code proves the person. A token alone opens nothing, which is why the
token may sit in a URL and the code may never.

**⚠ The two operations are deliberately asymmetric, and getting this backwards
is the whole risk on this surface.**

| | Answers | Why |
|---|---|---|
| `requestSignInCode` | **always, silently — `202`** | Whether an address is registered on a workspace is not something an unauthenticated caller may learn. The setup link travels by email through people who are not always the client, so the MAIL is what distinguishes the outcomes and it goes to the address, never to the caller. |
| `createOnboardingSession` | one `401 NT-OTP-001` for every refusal | By then the caller holds a code we sent to that address. Wrong code, locked, expired, unknown token and wrong address are still one answer, for the same reason the chase path gives them one. |

Four refusals collapse into that silence: a token that was never ours, an
expired invite, an already-accepted one, and an address that is not the
registered one (D45). `portal-onboarding.service.test.ts` asserts **nothing was
sent** for each rather than that something was reported — reporting is exactly
what would leak.

**A send failure is the one thing not swallowed.** The caller still sees `202`,
but the log carries it (§11: the address's DOMAIN and the business, never the
address and never the code), because a client waiting for a code that never left
is otherwise invisible. The code is still minted and stored, so a retry works.

**The invite is found by the same sanctioned sweep `resolveChase` uses** — one
unscoped read over `memberships` (which carries no RLS) yields each practice's
SYSTEM actor, and each context is asked whether it can see this invite. RLS
answers, not a filter. One scoped lookup per practice, once per client at
onboarding, never on a hot path. The unit harness's Prisma double answers
`invite.findUnique` only under the practice whose context is set, so the sweep is
really exercised rather than short-circuited.

**The code, and its two clocks.** Six digits from `randomInt(0, 10**6)` with
`padStart` — not `randomBytes % 1_000_000`, which is biased low, and not a
100000–999999 range, which throws away a tenth of the space to exclude leading
zeros. Stored as `hashOtp` (the same plain SHA-256 the chase path uses) with
`otp_expires_at` at **ten minutes**, a number the mail states so the copy and the
constant cannot drift. The `otp_sessions` ROW lives as long as a session does;
the CODE lives ten minutes. Conflating the two would either expire the link or
keep a code alive for a week.

**⚠ The code is single-use, and the clearing is what makes it so.** Opening a
session sets `otp_hash` to NULL; without that a code stays live for the rest of
its ten minutes after it has already been spent. Pinned by test.

**Re-requesting a code clears the attempt counter**, deliberately: a client who
mistyped twice and then asked for a fresh code has not earned a lockout. The
ceiling that stops this being an unbounded mail tap is the per-address one in
`notifications` (`email-rate-limit.ts`), not this counter. The LOCKOUT is
unchanged — five wrong codes on one link, then fifteen minutes, checked BEFORE
the code is compared so a locked link is not a timing oracle.

**The session opens with `scope = ONBOARDING`, not `DELEGATED_UPLOAD`**, and it
carries no chase. That matters for what it can do: the delegated RLS branches key
on granted DOCUMENT ids and this session has none, so it is a proof of identity
and not yet a grant. `GET /portal/context` needs a chase and will refuse it.

✅ **The subscribe step is unblocked** — contract change **#205**, approved and
landed 28 Aug 2026. `PortalSession` gained an OPTIONAL `businessId` and
`createCheckoutSession` gained `portalSession` beside `workspaceSession`, so the
invited client can now pay at the end of their own onboarding, which is the only
flow D48 and SoT §24.5 describe. `apps/web` needed no change: it had parsed the
field as optional all along.

Two things about it that belong here rather than in `billing/`:

- **`businessId` is optional because a CHASE session deliberately omits it.** Its
  business is not its holder's to act on — they may upload against granted
  documents and nothing else — so handing them an id they could put in a request
  body widens the credential for no purpose. Optional says which kind of session
  this is; required would say every portal session is a billing principal.
- **The field is an ANSWER, never an instruction.** `billing.controller.ts`
  re-derives the business from the session and answers **404** to a body naming a
  different one. 404 and not 403: a 403 would confirm the other business exists.

## ⚠ A silent refusal must not also be a silent LOG

`requestSignInCode` answers `202` whatever happened, and that is the contract —
telling the outcomes apart would answer *"is this address registered on this
workspace"* for anyone who types one. What it must NOT do is keep the reason
from its own operator.

It did, and the cost was a night: an invited client pressed "send me a code",
saw "Sent — check your email again", and nothing arrived. Nothing was logged
either, so there was no way in from the outside. SES's own send count is what
finally showed the request never reached a mail at all.

Two separate silences, both closed:

- **`resolveInvite` now returns a REASON**, logged server-side with the
  address's DOMAIN and never the address or the token (§11). `no-practice-actor`
  is spelled out apart from `unknown-token` on purpose — they are
  indistinguishable from every symptom and have nothing in common as fixes: one
  is an unprovisioned tenant, the other a bad link. It was the first, and every
  symptom pointed at the second.
- **A refused send is RETURNED, not thrown.** `NotificationsService` answers with
  a `SendOutcome` verdict precisely so a sign-in endpoint can stay uniform to its
  caller, and a `try/catch` never sees it. A rate-limited code therefore looked
  identical to a delivered one, from the outside AND in the logs. `sent === false`
  is now logged.

## ⚠ `resolve` and `resolveOnboarding` are two DOORS, and that is the safety

They differ by exactly which `otp_sessions.scope` they accept, and each refuses
the other's with the same uniform `NT-OTP-002`. A separate method rather than a
parameter, because the parameter version has a default and the default drifts:

- `resolve` → `DELEGATED_UPLOAD` only. An ONBOARDING row here would be handed
  document-write powers it was never granted.
- `resolveOnboarding` → `ONBOARDING` only. A chase row here would let a
  forwarded chase link buy a subscription.

An onboarding session has `chaseId: null` and an empty grant that nothing ever
widens, so `delegatedScopeFor` refuses it outright — it *cannot* become a
document grant even by mistake. What it can do is name its own business, under
`systemScopeFor`, which sees the whole practice: **every query made under it must
be constrained to `facts.businessId` in the query**, the same application
guarantee the chase boundary rests on. `portal-session-context.test.ts` pins both
doors and both refusals.

The expiry sentence also stopped saying *"Open the link from your text message
again"* in the same change. There is no SMS in ID (D40/D47) — `apps/web` swept
that claim at launch M8, and this was the server-side copy that pass could not
see.

## The `otp_sessions` write shape

```
scope                   = DELEGATED_UPLOAD
businessId              = the chase's business
chaseId                 = the chase
requestedFromContactId  = chase.recipientContactId        (who we texted)
contactId               = NULL                            (who is holding the link is unknown)
userId                  = that contact's users row, if it exists; else NULL → actor falls back to SYSTEM
linkTokenHash           = sha256(linkToken), hex          (@unique — plain SHA-256, not a KDF: the
                                                           token is 256 bits of HMAC, not a password)
grantedItemIds          = []                              (widened per upload by grantItems)
verifiedAt              = now
expiresAt               = now + 60 min
```

`link_token_hash` is `@unique`, so re-verifying the same link **updates that
row** rather than colliding: `verified_at`/`expires_at` refresh,
`granted_item_ids` is kept (a document already uploaded stays readable to the
session), and the P2002 race re-reads and updates. Covered by a test.

## The delegated upload path — `POST /portal/uploads` → `POST /document-uploads/{id}/complete`

Two requests, two modules, one document. The signature:

```ts
PrismaPortalUploadService.createPortalUpload(
  facts: PortalSessionFacts,        // the RESOLVED otp_sessions row — the only source of tenancy
  request: PortalUploadIntent,      // filename, mimeType, byteSize, transactionId? — no businessId, ever
  idempotencyKey?: string,
): Promise<DocumentUpload>          // the SAME shape web upload returns
```

**What the session decides and the client cannot.** `businessId` comes from
`facts`, `channel` is fixed at `SMS_PORTAL` (which is what pins the 25 MB client
cap, not the 100 MB accountant one), `practiceId` is read from the **business
row** under the practice SYSTEM context, and `splitMode` is `SINGLE_DOCUMENT` —
nothing splits, and a camera photo is one document. The contract's
`PortalUploadRequest` has no `businessId` for exactly this reason: a client
holding a forwarded SMS link does not get to name whose books their photo lands
in.

**⚠ THE CRUX — the grant is appended before the intent is returned.**
`documents_delegated_upload` keys on `id = ANY(app_granted_item_ids())`, and a
freshly-verified session's grant is EMPTY. The document id is knowable before the
document exists — completion derives it as `documentIdFor(uploadId)` — so
`createPortalUpload` computes it from the signed token and calls
`PortalSessionService.grantItems` with it **before** handing the intent back.
After that the delegated context covers exactly the one document this client is
about to create, and RLS is what admits the write.

Order matters and is tested: after signing (the id derives from the token),
before the response (an intent the client never received is one they cannot
complete), and never on a replay (the same `Idempotency-Key` returns the same
intent and must not widen the grant twice).

**Completion lives in `ingestion-routing/web-upload`**, because the contract puts
the portal bearer on `completeDocumentUpload` — one completion path, two trust
levels, no second door. `delegated-completion.ts` there turns an `Authorization`
header into the two contexts and the notification closure; the document is
written under the DELEGATED one, and the provenance
(`uploaded-by-delegated-session`, on `documents.submitter_label` **and** as a
`document_events` row) plus the accountant's notification under the practice
SYSTEM one, because neither `document_events` nor `notifications` has a delegated
branch. A session may complete only intents whose derived id is in its own grant
— 404 otherwise, and Postgres behind that.

**The replay store is namespaced by session** on both halves
(`portal-upload:<otpSessionId>:<key>`, `portal-complete:<otpSessionId>:<key>`).
`Idempotency-Key` is a client-generated UUID over a flat map; two sessions
reusing one key must miss, never be handed each other's signed intent — which
would carry the other session's `businessId`.

**`transactionId` is carried, never trusted.** It rides in the signed claims as
`UploadClaims.chaseTransactionId` and lands in the provenance event's `detail` as
`declaredTransactionId`. Nothing branches on it: auto-close compares the
extraction against every open chase (SoT Stage 8.5), so a client who taps the
wrong item still gets the right outcome. It is recorded rather than dropped
because this lane's invariant is that nothing is silently dropped.

## The post-upload half — chase validation, status, and the accountant

SoT §4 Stage 8.5 is one sentence and it is the whole specification:

> *"the AI checks the uploaded document against the chased transaction (supplier
> / amount / date). Mismatch → instant in-portal feedback: "This looks like a
> £420 invoice, but we need the £600 Google transaction from 5 Aug.""*

| File | What it is |
|---|---|
| `chase-verdict.ts` | `describeChaseMismatch(document, transaction)` → `{kind: 'match' \| 'mismatch', reasons, message}`. **Pure.** The copy above, verbatim, for the case SoT describes. |
| `portal-upload-status.service.ts` | `portalUploadStatus(row, target)` (pure) + `PortalUploadStatusService` — the poll-able read: document state + extraction + verdict, under the two scopes. |
| `portal-upload-notifier.ts` | `PortalUploadNotifier.notifyUploadReceived(session, {documentId})` — the `portal.upload` `notifications` row (SoT §4 Stage 8.8). |

**Stage 9 adds no second auto-close.** Stage 8's ingest hook
(`chase/auto-close.ts`) already closes a matching chase for every arrival
channel. Everything here *reads* and *describes*; the only write is the
notification.

**The reasons are PROBED, never re-implemented.** The verdict is
`chaseMatchesDocument` — the predicate the chase actually closes on. Naming
*which* of supplier/amount/date failed would normally mean rewriting the three
comparisons here, and then the copy drifts the day a tolerance moves: the portal
says "we need £600" about a receipt that closed the chase. Instead each gate is
probed with the SAME predicate, holding the other two open by forcing them to
the transaction's own values (an amount cannot differ from itself; a `null`
document date skips the date gate by design). No tolerance and no normaliser is
read in this file. A test asserts `reasons.length === 0` **iff**
`chaseMatchesDocument` across the whole cast — that assertion is the anti-drift
guarantee, not the comment.

**The copy, exactly.** The lead names the document's amount always, and its
supplier and its date **only when they are what differs**, so the
single-difference case reads as SoT writes it rather than repeating a supplier
that already agrees. The "we need" clause is always complete:

```
match      Received, thank you — that's the £600 Google transaction from 5 Aug.
amount     This looks like a £420 invoice, but we need the £600 Google transaction from 5 Aug.
supplier   This looks like a £600 Amazon invoice, but we need the £600 Google transaction from 5 Aug.
date       This looks like a £600 invoice from 1 Jul, but we need the £600 Google transaction from 5 Aug.
all three  This looks like a £420 Amazon invoice from 1 Jul, but we need the £600 Google transaction from 5 Aug.
unreadable We couldn't read that document, but we need the £600 Google transaction from 5 Aug. Please try a clearer photo.
```

`unreadable` is not a difference — it is the absence of one side of the compare
(no supplier, or no total), which cannot be written as "£420 vs £600" because
there is no £420. The extracted supplier is untrusted content on its way into a
sentence: whitespace-collapsed, clamped to 60 characters, never shown to a model.

**⚠ Nothing routes to the status service yet, and the gate left it that way.**
`openapi.yaml` publishes three portal operations and **no** status path (LAW,
G7), so no request can reach it: it is an in-module library — built, tested,
waiting for a path — and it is deliberately **not** a Nest provider, because a
provider nothing injects claims a live surface that does not exist.

- `statusFor(facts, documentId)` — one document, or a **404** when the session
  was never granted it (404-never-403, and the absence is RLS's, not a filter's).
- `statusesForSession(facts)` — every document this session uploaded.

**`received` has exactly ONE implementation, and it is the chase module's.**
`GET /portal/context` projects through `toChaseItem`, whose predicate is
"this transaction is no longer `UNMATCHED`, OR the caller says the chase-level
close credits THIS item" — the same flag the accountant's chase detail renders,
per item, for every arrival channel. A second `receivedTransactionIds` grew here
during Stage 9 and was **removed at the gate**: it was unreachable, it ignored
`matchState`, and it answered nothing for a grouped chase.

⚠ **A `CLOSED_RECEIVED` chase means ONE line arrived, not all of them** — and
getting this wrong was a real bug the review caught. Stage 8's auto-close matches
a document against `chase.transaction` and closes the *whole* chase, so a grouped
chase ("one text, many receipts", SoT §8.2) goes `CLOSED_RECEIVED` with its other
lines still outstanding. Passing `isChaseReceivedClose(chase.state)` for every ref
therefore marked them all received off one upload: a client who sent the Currys
receipt saw "nothing is outstanding", the Google row disabled — so the receipt we
were still asking for was never collected, and we had said in plain English that
it was not needed. The fix is **not** a second auto-close: the chase-level close
credits only `chase.transactionId` (the line it actually matched), and every other
ref falls back to its own `matchState`. Two tests pin it, and they fail against
the old derivation. What the client sees on a mismatch today
is `ChasePortalView`'s copy naming the chased item ("it does not look like the
£600 Google payment of 5 Aug"); `describeChaseMismatch`'s fuller sentence
("this looks like a £420 invoice…") is server-side and waits for a route.

**⚠ The notification is written where the document is CREATED, and that is not
this module.** `notifications` carries only `notifications_tenant`, which begins
`app_session_scope() = 'user'` — a **delegated context cannot write it**, so the
write runs under the practice SYSTEM context. And "a client uploaded" only
becomes true at `POST /document-uploads/{uploadId}/complete`; notifying at
intent time would announce bytes that may never land.

**It is wired, as a closure.** `delegated-completion.ts` (in
`ingestion-routing/web-upload`) resolves the session and closes over the
notifier as `DelegatedCompletion.notifyUploadReceived`;
`web-upload.service.ts`'s `afterDelegatedCreate` calls it on the
`delegated !== null && created` branch. So `WebUploadService` gained no
constructor dependency and never learns what a `notifications` row is, and a
notification failure is logged rather than fatal — the document is already
persisted, and a retry would find `created: false` and strand it in RECEIVED.

Idempotent on the document id (a replayed completion writes no second toast),
by a read-then-write rather than a constraint: `notifications` has no unique key
for it and Stage 9 changes nothing in `prisma/`. Two genuinely concurrent
completions of one intent could still write two rows — a duplicate toast, not a
duplicate document, and the alternative is a migration this stage may not make.
// DEMO-MOCK: notification delivery channels — `channels` stays `[]` and
`recipientUserId` null rather than claiming a fan-out that does not happen.

## Environment

| Variable | Added by | Note |
|---|---|---|
| `PORTAL_SESSION_SECRET` | **Stage 9** | Signs the bearer. Empty = fail closed (refuses to sign or verify). No production boot-refusal — the SESSION_SECRET stance. |
| `PORTAL_LINK_SECRET` | Stage 8 | Verifies the SMS link. Reused, not re-declared. |
| `OTP_MODE` | Stage 1, extended by S1 | **Reused, not duplicated** — auth-tenancy already declared it. `demo` → the literal `000000`, and S1 REFUSES `demo` under `NODE_ENV=production`. `totp` → the minted code in `otp_sessions.otp_hash` (A2). |

A **second** secret rather than reusing `PORTAL_LINK_SECRET` on purpose: the link
is a 24 h public URL handed to whoever holds the paperwork; the bearer is a
short-lived credential that has already passed the OTP. Rotating one must not be
forced to invalidate the other.

## Boundaries

`index.ts` is the seam. The one cross-module consumer the contract itself
creates: `POST /v1/document-uploads/{uploadId}/complete` accepts the portal
bearer alongside the workspace session, so `ingestion-routing/web-upload` needs
`PortalSessionContextResolver` + `delegatedScopeFor` — and nothing else from in
here. The three portal endpoints live **inside** this module and import the
files directly.

Portal endpoints do **not** use `common/context`'s `RequestContext`: that
resolver reads the `nt_session` cookie into a practice-staff context, and a
portal caller has neither. They read their own `Authorization` header.

## Reused, never re-implemented

- `verifyPortalLink` + `PORTAL_LINK_DEFAULT_TTL_SECONDS` — `modules/chase/index.ts`
- `chaseMatchesDocument`, `CHASE_MATCH_*`, `ChaseAutoClose` — same seam. Stage 8
  **already auto-closes** a matching chase from the ingest hook. Stage 9 adds the
  portal-facing *mismatch* feedback, never a second auto-close.
- `signUploadToken`/`UploadClaims`, `uploadIntentKey`, `DocumentStore.presignPut`,
  `documentIdFor`, the channel cap + MIME allowlist — `ingestion-routing`.
  Mirror `web-upload.service.ts` end to end; anything needed across the boundary
  is exported through `ingestion-routing/index.ts`.
- `resolveSystemActor`, `systemContext`, `scopedDb`, `AppException`,
  `parseBoundary` + the generated `createPortalSessionBody` /
  `createPortalUploadBody` / `getPortalContextResponse` zod.
- **`toChaseItem` / `chaseItemRefs` / `isChaseReceivedClose` — `modules/chase/index.ts`.**
  Grown to the chase seam by this stage. The accountant's chase detail and the
  client's portal list are *the same facts at two trust levels* (one `ChaseItem`
  schema serves both in `openapi.yaml`), so the portal projects through the chase
  module's function rather than growing a second opinion about what a chased item
  is — and `chases.service.ts`'s private copy of the `itemRefs` narrowing was
  folded into the shared one at the same time, so there is one, not three.

## Tests

```bash
pnpm --filter @neoting/api vitest run src/modules/portal/          # unit, offline, no DB
pnpm --filter @neoting/api vitest run src/modules/portal/portal.integration.test.ts   # + real Postgres
pnpm --filter @neoting/api vitest run src/modules/portal/portal-upload-feedback.integration.test.ts
pnpm --filter @neoting/api vitest run src/modules/portal/portal-delegated-upload.integration.test.ts
```

The unit suites use a Prisma stand-in that **simulates the practice scoping** (it
reads `app.practice_id` out of `scopedDb`'s `set_config` call), so the sweep and
the context read are exercised against something that behaves like
`chases_tenant` rather than a stub that always answers.

`portal-onboarding.service.test.ts` is fifteen cases and most of them assert an
ABSENCE: every refusal resolves and **sends nothing**, which is the only way to
test a rule whose whole point is that it has no visible effect. Its double must
expose `$executeRaw` on the TRANSACTION client, not just the root one —
`scopedDb` sets the RLS context with a tagged template inside the transaction,
and a double missing it fails in a way that reads like a service bug. `portal-context.service.test.ts`
also parses its own output with the generated `getPortalContextResponse` — the
contract checking the projection, including `minItems` and integer pence.

`portal.integration.test.ts` (prefix `p9_`, full teardown at both ends, file-serial
like every other suite here) is the acceptance, and proves the three things only a
real database can answer:

1. **The chase read genuinely needs the SYSTEM context** — the same
   `chase.findUnique` returns `null` under the delegated context and the row
   under the system one. The claim in this file is asserted, not described.
2. **A portal session cannot read a document it was not granted** — two documents
   in the *same business*, one in the grant, one not; the ungranted one is
   invisible to `findUnique` and absent from a `findMany` over the whole business.
3. **The chase boundary is the session row** — facts pointed at another
   practice's chase get `401`, because `where id = facts.chaseId` is what narrows
   a context that can see the whole practice.

`portal-upload-feedback.integration.test.ts` (same `p9_` namespace, same
teardown discipline) is the post-upload half of that acceptance: the
`portal.upload` notification is written **once** per document under the SYSTEM
context, the verdict for a granted document is the match/mismatch copy, a
document the session was never granted 404s out of `statusFor` and is absent
from `statusesForSession`, and an empty grant reads as nothing rather than
throwing. Its last case is the LIVE one: a chase closed by another channel reads
as `received` through `PortalContextService`, the only `received` there is. Its
facts come from the REAL bearer through the REAL resolver, so it exercises the
same session a request would.

`portal-delegated-upload.integration.test.ts` (prefix **`p9u_`** — disjoint from
the `p9_` above, so the two suites' teardowns cannot reach each other's rows) is
the upload half, end to end through the REAL services: link + OTP → intent →
`completeDelegatedUpload` → document, provenance, notification, job. It proves
the five things only Postgres can answer:

1. **The grant is what makes the write legal** — the derived id is on the
   `otp_sessions` row before completion, and it is the only thing there.
2. **A delegated session cannot write into another business** — the handler's own
   404 is bypassed by forcing the grant open to a foreign document id, so
   `documents_delegated_upload`'s WITH CHECK is the only thing left. The
   assertion matches Postgres's own `row-level security` message, not merely
   "it threw".
3. **The provenance row really is writable under the SYSTEM context** and really
   does carry `uploaded-by-delegated-session` + the session and chase ids.
4. **The session can read its own document back** (what the status poll needs),
   and cannot once the grant points elsewhere.
5. **The job carries `documentId` + `practiceId` + `routing.businessId`**, which
   is what makes extraction and Stage 8's auto-close run for a portal document
   with no second worker path.

Storage is `InMemoryDocumentStore` on purpose: the presigned *signature* is
`web-upload.integration.test.ts`'s question (it PUTs to real MinIO), and needing
`RUN_S3_INTEGRATION=1` here would leave the tenancy assertions unrun on an
ordinary `pnpm test` with docker up.

## TODO — what Stage 9 still owes

- [x] `portal.controller.ts` — the three contracted operations, registered in
      `portal.module.ts` (which `app.module.ts` already imports). Generated zod
      via `parseBoundary`, `Idempotency-Key` enforced on both mutations, 106
      lines.
- [x] `GET /portal/context` — `portal-context.service.ts`, reading under
      `systemScopeFor(facts)` constrained to `facts.chaseId`, projecting through
      the chase module's `toChaseItem`. Empty is a 500, never a 200.
- [x] The negative test the acceptance demands (`portal.integration.test.ts`,
      and again from the status read in `portal-upload-feedback.integration.test.ts`).
- [x] Chase validation feedback — `chase-verdict.ts` + `portal-upload-status.service.ts`.
      The SoT sentence, verbatim, probed off `chaseMatchesDocument` so it cannot
      drift from the predicate the chase closes on.
- [x] `POST /portal/uploads` — `portal-upload.service.ts`, wired at
      `PORTAL_UPLOAD_SERVICE` (the `UnwiredPortalUploadService` stub is gone),
      and the completion half in `ingestion-routing/web-upload`. See "The
      delegated upload path" above.
- [x] **The accountant's notification is wired.** It is called from
      `ingestion-routing/web-upload`'s completion on the
      `delegated !== null && created` branch, as a closure
      (`DelegatedCompletion.notifyUploadReceived`) built by
      `delegated-completion.ts` — so web upload never learns what a
      `notifications` row is, and `WebUploadService` gained no constructor
      dependency. A notification failure is logged, never fatal: the document is
      already persisted, and a retry would find `created: false` and strand it
      in RECEIVED.
- [x] **Gate pass (Stage 9 close).** Contracts build → `tsc` → lint → tests →
      build green for `@neoting/api` and `@neoting/web`. Two collision artefacts
      from the parallel build were reconciled and nothing else was touched:
      `receivedTransactionIds` (a second, unreachable `received` predicate) was
      removed in favour of the chase module's `toChaseItem`, and the
      `PORTAL_UPLOAD_STATUS` provider/token were dropped because no contract
      path reaches the status service. The stale "TODO: wire the notification"
      block in this file was deleted — it had already been wired as a closure,
      and following it would have written a second toast.
- [ ] The portal's editable extraction overlay records corrections as a
      `document_events` row (METH Stage 9 build item 4). `statusFor` gives the UI
      the header to render; the correction write is not built.
- [ ] The status service has no route. When the contract grows one
      (`GET /v1/portal/uploads/{documentId}` or similar), wire
      `PortalUploadStatusService` as a provider and the mismatch sentence the SoT
      asks for reaches the phone unchanged.
- [ ] Post-demo: give the **link** token a `practiceId` claim (a chase-module
      format change, so a Stage 8 decision) and the practice sweep in
      `resolveChase` collapses to a single lookup.
- [x] **A2: `otp_sessions.attempts` / `locked_until` are read and written.** Five
      wrong codes per link, then fifteen minutes, with the uniform `NT-OTP-001`.
      Proven against real Postgres in `portal-otp-lockout.integration.test.ts`.
- [ ] **Per-IP limiting is still absent, deliberately.** `main.ts` never calls
      `app.set('trust proxy', …)`, so behind the ALB `req.ip` is the load
      balancer for every request — an IP ceiling would be one global ceiling for
      every client at once, and `X-Forwarded-For` without `trust proxy` is an
      attacker-supplied header. `main.ts` is not this stage's path. SoT §15's
      "per number and per IP" needs that wired first.
- [x] **`POST /v1/portal/sign-in-codes` and `POST /v1/portal/onboarding-sessions`
      are implemented** (28 Aug 2026), which was the invited-client half of the
      `otp_hash` gap. The code is hashed with `hashOtp` and `otp_expires_at` is
      set, as this list required.
- [x] **The CHASE half mints its code (1 Sep 2026).**
      `PortalOnboardingService.requestChaseCode` — `POST /portal/sign-in-codes`
      with a `linkToken` (contract widened; `email` no longer required) verifies
      the link, resolves the chase by the sanctioned sweep, writes
      `otp_hash`/`otp_expires_at` onto the link's row (the counter-row shape —
      NOT a session), and emails the code to the chase's REGISTERED recipient
      contact, never a typed address (D45). Uniform 202; every refusal a logged
      reason. `createSession` now also CLEARS `otp_hash` on success, so chase
      codes are single-use like onboarding's.
      `portal-chase-code.integration.test.ts` proves link → code → totp session
      → single-use → lockout counting → silent refusals against real Postgres.
- [ ] **`PortalSession` has no `businessId`, so an onboarding session cannot
      reach checkout.** A contract-change issue for Shakib (G7); the web half is
      already written to accept the field the day it lands.
- [ ] Update this file on exit — it is how the next session picks up.

## Signing in WITHOUT a setup link (29 Aug 2026)

`setupToken` is optional on `POST /portal/sign-in-codes` and
`POST /portal/onboarding-sessions`.

**It was required, and that made the portal a one-week door.** The invite expires
after seven days, so a client who onboarded, subscribed and came back a
fortnight later was locked out of their own workspace — with no route back that
did not involve telephoning their accountant.

| | route | how the workspace is named | otp row key |
|---|---|---|---|
| first sign-in | token present | the invite, plus the address checked against it (D45) | `hashSetupToken(setupToken)` |
| every one after | token absent | the address alone, via `contacts` | `signInSessionKey(businessId, email)` |

- **⚠ EXACTLY ONE BUSINESS, OR NOTHING.** `resolveByAddress` refuses an address
  that is a contact of two businesses (`ambiguous-address`). Picking one would
  open somebody's books on a coin toss, and the person it opened them to would
  have no way of telling. It is logged loudly because it is a dead end for a real
  person and only an operator can fix it.
- **No `isPrimary` condition**, deliberately: D45 lets a client add their own
  team members and lets those people upload, so any contact of the business is
  entitled to sign in to it.
- **The two routes use DIFFERENT otp rows**, so a first sign-in and a return
  cannot overwrite each other's code. The tokenless key is per business AND per
  address, so two people at the same client do not either — the loser would
  otherwise experience a code that simply never worked.
- **Both refuse identically to the caller.** The routes differ in what they
  check, never in what they admit to: `requestSignInCode` cannot report failure
  at all, and every `createOnboardingSession` refusal is one `401 NT-OTP-001`.
- The sweep is the sanctioned one `resolveInvite` and `resolveChase` use: one
  unscoped read over `memberships` for each practice's SYSTEM actor, then RLS
  answers per practice. It runs once per sign-in, never on a hot path.

## ⚠ All three portal doors take BOTH kinds of session (29 Aug 2026)

The context read, the upload intent and the completion each called
`resolver.resolve(...)`, which accepted `DELEGATED_UPLOAD` only. So a client who
signed in to their own portal — with a code they had just typed correctly — was
answered **`NT-OTP-002 — missing or invalid portal session`** by the very
endpoints written for them, and `getBusinessContext` was unreachable code.

| door | resolver | takes |
|---|---|---|
| `GET /portal/context` | `resolveForContext` | chase **and** own-portal |
| `POST /portal/uploads` | `resolveForUpload` | chase **and** own-portal |
| `POST /document-uploads/{id}/complete` | `resolveForUpload` | chase **and** own-portal |
| `POST /billing/checkout-sessions` | `resolveOnboarding` | own-portal **only** |

**⚠ There is deliberately no bare `resolve` any more.** It is the name a reader
reaches for by default, and the default must not be the variant that silently
excludes half the sessions this module issues — which is precisely how this bug
happened. Every caller names the operation it is resolving *for*.

What makes the widening safe is tenancy, not scope: every query on both context
branches is constrained to `facts.businessId`, and `createPortalUpload` needs
nothing from the session but that same id — it takes no chase and files against
no other business. The holder proved control of an address registered as a
contact of exactly one business (D45).

What did **not** widen: the billing door, which is how a subscription is paid
for, and `delegatedScopeFor`, which still refuses a session with no granted
items. A chase session's `chaseId` is still the only thing that makes the
context return chase items.
