# notifications

**Lane L** · **Source of Truth:** SoT §4 Stage 8.8, §12 · **Launch stage:** S2 (`docs/launch/SHAKIB.md`)

## Purpose

**Two halves since 5 Sep 2026, one domain.** The OUTBOUND half (everything below
this section) is transactional email. The INBOX half is the in-app notification
read surface — the bell.

## The in-app inbox — `GET /v1/notifications` + `POST /v1/notifications/read-receipts` (5 Sep 2026, review item 12)

The `notifications` TABLE had three writers (`portal.upload` from the portal
notifier, `chase.closed` from auto-close/statement-request, and — new in the
same change — `document.received` from `ingestion-routing`'s `document-sink.ts`
for routed EMAIL/WHATSAPP arrivals) and **no reader**: a client's upload landed
and nothing on the accountant's side changed except by poll. This is the read
half, and the web header's bell is its consumer (10 s poll + window focus).

| File | What it is |
|---|---|
| `inbox.service.ts` | `list` (keyset-paginated newest-first via `common/pagination/cursor`, business name joined, whole-reach `unreadCount` in the same transaction) + `markRead` (the FIRST writer of `readAt` — guarded on `readAt: null`, so the timestamp is set once and never rewritten; omitted ids mean everything unread) |
| `inbox.controller.ts` | The two contracted routes, thin: `coerceQuery` → `parseBoundary` → one service call |

Decisions worth knowing:

- **The "No controller" rule below is RETIRED, and only because the contract
  moved first** — `openapi.yaml` now publishes the two operations. The outbound
  half still has no endpoint and still writes nothing to the database.
- **`documentId`/`chaseId` are read DEFENSIVELY off the `payload` Json** — each
  writer shapes its own payload, so a non-string value or missing key projects
  `null` rather than felling the bell on an old row.
- **No `businessId` filter, by design** — the bell is a practice-wide surface;
  RLS bounds the set (`notifications_tenant`), and the module rule of no second
  tenancy mechanism holds.
- **`markRead` honours its `Idempotency-Key` actor-scoped** (the
  `DocumentManagementService#replayed` pattern): the write is natively
  idempotent, so the guard is against disclosure and key-misuse (`409
  NT-IDM-001`), not double effect.
- **`document.received` is written in the SINK's transaction**
  (`ingestion-routing/queue/document-sink.ts`), not here — same transaction as
  the document so a toast can never name a rolled-back row; UNROUTED documents
  are skipped (no business to hang the row on, and the Unrouted queue is its own
  surface); the accountant's own WEB_UPLOAD/CHAT_UPLOAD never reach the sink, so
  nobody is notified about their own act.

Tests: `inbox.service.test.ts` (recording fake Prisma — the `where`s, the
projection, the replay guard) and the routed-notification case in
`ingestion-routing/queue/document-sink.integration.test.ts` (real Postgres:
once per document, none on redelivery, none for unrouted).

## The outbound half

**Outbound transactional email, and the first thing in this repository that sends any.**

Before S2 a repo-wide grep for `SESClient`, `sendEmail`, `nodemailer`, `SendEmailCommand`
and `smtp` returned zero hits. Only INBOUND mail existed (`ingestion-routing/email`,
`doc@` → S3). With SMS cut for Initial Delivery the client had **no delivery channel at
all**: no invite could reach them, no sign-in code could be delivered, nothing could be
chased. This module is that channel.

Per-event notification *preferences* (SoT §4 Stage 8.8, "granular per event, configurable
in both directions") are still unbuilt — see TODO.

## What is here

| File | What it is |
|---|---|
| `email-sender.ts` | The `EmailSender` seam + `OutboundEmail`/`SentEmail` + `DemoEmailSender` (in-memory outbox) |
| `ses-email-sender.ts` | The real one — Amazon SES v2, eu-west-2 |
| `smtp-email-sender.ts` | The local MailHog transport. **Development only** — no auth, no TLS, refused under `NODE_ENV=production` |
| `select-email-sender.ts` | Config selection for BOTH the sender and the rate limiter |
| `email-copy.ts` | The three messages, pure functions |
| `email-address.ts` | The address boundary — validation, CR/LF refusal, the rate-limit identity |
| `sign-in-code.ts` | The credential wrapper that refuses to reveal itself |
| `email-rate-limit.ts` | Per-address and per-IP ceilings, memory + Redis |
| `notifications.service.ts` | The one door outbound email leaves by |

**The three messages** (S2): client invite · sign-in code · document request.
Plus the two signup messages (27 Aug) and, since 2 Sep 2026, the **team
invite**.

### ⚠ `composeTeamInvite` could NOT reuse `composeClientInvite`

A colleague joining the practice is not a client joining a workspace, and the
difference is one sentence in the client copy: *"There is nothing to install and
no password to choose."* That is true of a client — they sign in with an emailed
six-digit code and never hold a password — and precisely FALSE of a colleague,
whose entire next action is to choose one. A shared composer would have told
every new member of staff not to do the thing the link exists for. The two also
differ in subject: one names a business and describes sending receipts, the other
names an employer.

| Kind | Composer | Per-address ceiling |
|---|---|---|
| `team-invite` | `composeTeamInvite` | **3**/hour |

Held at the SIGNUP ceiling rather than the client-invite one: it is the only
invitation an authenticated caller can point at an address of their choosing with
no existing relationship behind it. The role is deliberately NOT in the copy —
the screen the link opens states it, read from the invitation itself, so the
words a person sees cannot drift from the grant the server will make.

### ⚠ And `composeBusinessPeopleInvite` could reuse NEITHER (2 Sep 2026)

The **THIRD** invitation relationship: a client business adding its own staff
(D45, D49 — `modules/portal/portal-people.service.ts`). Each refusal is one
sentence:

- **`composeTeamInvite`** says *"open the link below to choose a password and set
  up an authenticator app"*, which is right for a colleague joining a firm and
  flatly wrong here — **portal people have no password.** They sign in with a
  six-digit code emailed to the address the message went to, so that instruction
  would send a new starter looking for a screen that does not exist.
- **`composeClientInvite`** gets the password half right and the RELATIONSHIP
  wrong. It is sent in the PRACTICE's name — correct, because a client knows
  their accountant — and this one is not from the accountant at all. The reader
  works for the BUSINESS; naming an accounting firm they may never have heard of,
  in the subject line, is how a legitimate invitation reads as phishing. So the
  employer is named and the practice is not mentioned.

| Kind | Composer | Per-address ceiling |
|---|---|---|
| `business-people-invite` | `composeBusinessPeopleInvite` | **3**/hour |

Three, matching `team-invite`, for the same reason at one remove: the caller here
is a **CLIENT** — the least-vetted principal that can send anything in this
product — so one restaurant adding kitchen staff must not be able to exhaust the
budget the accountant needs to invite a client.

⚠ **The link carries NO token, and that absence is the design.** The invitation's
whole effect is a `contacts` row, and the portal's tokenless sign-in resolves an
address to exactly one business off that row — so the address the mail arrived at
is already everything the sign-in needs. A setup token would add a seven-day
expiry to a relationship that has none, a second credential travelling by email,
and the CLIENT-ONBOARDING journey (company details, then subscribe), which
belongs to the owner and not to somebody hired to photograph receipts.

**No enumeration oracle.** It is only ever sent to an address the caller typed
into their own workspace's People screen, and it says nothing about whether that
address was already known to the product.

## The rules that matter more than the feature

- **The HTML part is DERIVED, never composed.** (28 Aug 2026: Mubasshir reversed the
  plain-text-only stance; the deliverability constraints survive the reversal.)
  `email-html.ts` re-renders the approved plain-text body in the product shell: nothing may
  appear in the HTML that is not in the text, the HTML fetches no remote resource — no
  image, no tracking pixel, no webfont — and the text part stays complete and authoritative
  in a multipart/alternative send. `email-copy.test.ts` asserts the text part is still
  plain and that the HTML carries every line of it; S7's walkthrough re-verifies inbox
  placement with the part attached.
- **The sign-in code is a CREDENTIAL.** Never logged, never in a URL, never in a subject,
  never in an API response or an error — *not even in development*. `SignInCode` makes this
  structural rather than aspirational: template interpolation, `JSON.stringify` and
  `util.inspect` all yield `[sign-in code]`, and `reveal()` is the one door out.
  **`grep -rn 'reveal()'` should return exactly one call site, in `email-copy.ts`.** A second
  one is a finding.
- **Rate-limited per address AND per IP.** Either alone leaves the other wide open — see the
  header of `email-rate-limit.ts`. Address keys carry the kind; the IP key deliberately does
  not.
- **`no-reply@`, never `doc@`.** `doc@` is the inbound document intake address; mail arriving
  there is filed as a client document, so sending from it would ingest every reply as
  paperwork. The task role's `ses:FromAddress` condition and `EMAIL_FROM_ADDRESS` must agree
  or every send is AccessDenied.
- **What reaches the logs:** the kind, the provider message id, and the recipient's *domain*.
  Never the address (Governance §11.6), never the body.
- **No message may claim a ledger was written to** (D42). Asserted in `email-copy.test.ts`.

### The SMTP sender's three asymmetries, closed (2 Sep 2026)

It shipped with headers CRLF-stripped and the DATA block dot-stuffed — both
right — while three things around them were not, and each was a case of one half
of the file being careful and the other half not.

- **The COMMAND lines interpolated raw.** `MAIL FROM:<${fromAddress}>` and
  `RCPT TO:<${to}>` are CRLF-terminated commands, so a newline in an address
  ends the command and begins another: header injection's sibling, and the worse
  of the two, because what is injected is a verb. `commandAddress()` strips CR,
  LF and angle brackets and refuses an address that empties. **Nothing reachable
  trips it** — both values are already parsed by `email-address.ts`, which
  refuses CR/LF — and that is the point: an asymmetry is a thing the next reader
  has to re-derive the safety of every time.
- **`timeoutMs` claimed to be a ceiling on the whole conversation.**
  `socket.setTimeout` measures **inactivity**, and the clock restarts on every
  reply. The comment now says which, and says what the timeout does guarantee (a
  sink that stops answering fails the send rather than hanging the request). A
  real whole-conversation deadline would be a second timer and is not worth one
  against a `localhost` sink production refuses.
- **`EMAIL_REPLY_TO_ADDRESS` was silently dropped** while SES honoured it, so one
  configuration composed two different messages and a reply typed on a laptop
  went to `no-reply@` — the address this module exists to keep mail out of. The
  header is now emitted, omitted when the value is empty, exactly as SES omits
  `ReplyToAddresses`.

## Boundaries

Exposes **only** `index.ts`. The boundary is lint-enforced
(`neoting/no-cross-module-internals`).

**This module writes nothing to the database, on purpose.** There is no email-outbox table
and adding one is `prisma/` — LAW (G7), and not in the S0 batch. The constraint turned out
to be the right shape: the durable record of *why* a message was sent already belongs to the
caller (`invites`, `otp_sessions`, `chases` + `chase_messages`), and a transport-owned second
copy would be a second opinion about what was sent. What replaces the outbox row is
`DemoEmailSender`'s in-memory ring in dev, and SES's own configuration-set metrics + the
`nt-<env>-ses-events` SNS topic in a deployed environment.

It imports `chase/index.ts` for `formatGbp`, `formatDay` and `ChaseItem` — money and dates
come from one implementation, not two. `formatGbp` is string arithmetic on integer pence and
never divides; a local `£${p / 100}` would be wrong and would look right.

**No controller.** Nothing in `openapi.yaml` publishes a notifications endpoint and
`packages/contracts` is LAW. This module exists to be injected.

## Config (`config/env.ts`, the S2 block)

`EMAIL_SENDER` (`demo`|`ses`) · `SES_REGION` · `EMAIL_FROM_ADDRESS` ·
`EMAIL_REPLY_TO_ADDRESS` · `EMAIL_CONFIGURATION_SET` · `EMAIL_RATE_LIMIT` (`memory`|`redis`)

Three boot gates refuse: `demo` in production; `ses` without a From address or a
configuration set; `ses` behind the per-process limiter in production.

⚠ **There is no fallback from `ses` to `demo`, and there must not be one** —
`select-extractor.ts` carries the long version of why, paid for on 25 Aug 2026.

## Locally

`EMAIL_SENDER=demo`. The sign-in code you need in order to sign in is in the in-memory
outbox — `DemoEmailSender.lastTo(address)`. It is a bounded ring (100), and it holds
credentials in memory, which is one more reason the production gate exists.

## Tests

```bash
pnpm --filter @neoting/api test -- notifications
```

## The invite and the verification carry the legal links (4 Sep 2026 — walkthrough findings 1 and 4)

Neither message gave its reader any way to reach the terms: the accountant
accepted them on the signup form and the email said nothing about where they
live, and the CLIENT invite carried nothing at all for someone who has accepted
nothing yet. Both composers now take **required** `termsLink`/`privacyLink`
inputs and render them on their own lines — deliberately UNLABELLED, because a
labelled link renders as a mint button (`email-html.ts`) and only the message's
one action earns a button; the legal pair renders as plain links.

- **`legal-links.ts`** is the one maker: `buildLegalLinks(appOrigin)` →
  `<origin>/legal/terms-of-service` + `<origin>/legal/privacy-notice`, exported
  on `index.ts`. The paths mirror `apps/web/src/views/legal/documents.ts`
  (`legalPath`), and `/legal/*` renders OUTSIDE every wall (M4) — a reader with
  no session, which is exactly who both emails reach.
- ⚠ **The SAME SPA drift trap as `VERIFY_EMAIL_PATH`**: a moved legal route
  answers these links 200 with the app shell. `legal-links.test.ts` reads the
  web package's own source and fails if the halves drift.
- **Callers build the links**, as they build every other link here:
  `auth-tenancy/notifications-signup-mailer.ts` (verification) and both
  `sendClientInvite` callers in `clients-team-settings`
  (`client-intake.service.ts`, `team.service.ts`) spread
  `buildLegalLinks(appOrigin)`.
- The team invite and business-people invite are deliberately untouched — the
  findings named the two messages above, and widening the sweep is a copy
  decision, not a fix.

## Verified against the real thing (26 Aug 2026)

SES account: production access GRANTED, 50,000/day, 14/s, `SendingEnabled`, enforcement
HEALTHY. Identity `neoting.neovogent.com`: `VerifiedForSendingStatus` true, DKIM `SUCCESS`
(3 tokens), MAIL FROM `mail.neoting.neovogent.com` `SUCCESS`. DNS resolves: SPF
(`v=spf1 include:amazonses.com ~all`), the MAIL FROM MX, and DMARC (`p=none`, with `rua=`).

Three real messages sent to a real Gmail address **through this code**, not through the
CLI — SES `Send=3`, `Delivery`, `Bounce=0`, `Complaint=0`, `Reject=0`, suppression list
empty.

## TODO

- [ ] **Subscribe a human to `nt-staging-ses-events`.** It has ZERO subscribers, so bounces
      and complaints publish into a void: account-side suppression still works, but nobody is
      *told*. `observability.tf` forbids declaring the subscription in Terraform (it would be
      created `PendingConfirmation` and look wired while delivering nothing), so this is an
      out-of-band action and the confirmation is the proof.
- [ ] Confirm inbox-vs-spam placement on Outlook — the Gmail send is done, no Outlook address
      was available.
- [ ] Tighten DMARC to `p=quarantine` once `rua` reports are clean (runbook §5.3).
- [ ] Per-event notification preferences (SoT §4 Stage 8.8) — granular, both directions.
- [ ] Wire the consumers: A1/A11 (`sendClientInvite`), A2 (`sendSignInCode`),
      A14 (`sendDocumentRequest`, cut-listed at hour 22).
      ✅ `sendTeamInvite` is wired — `clients-team-settings/practice-team.service.ts`.
- [ ] Update this file on exit — it is how the next session picks up.

## ✅ The signup messages — the seam A1 left, connected (27 Aug 2026)

S2 built this module and merged. **Nothing ever swapped the provider**, so
`auth-tenancy` kept `RecordingSignupMailer`, which sends nothing;
`PracticeSignupService` refuses to create an account at all under
`NODE_ENV=production` while that stand-in is wired, and staging runs
`NODE_ENV=production`. **Signup was dead on the launch target**, and A14's
`POST /v1/auth/email-verification` had no mail to consume.

Two messages were added here to close it:

| Kind | Composer | Per-address ceiling |
|---|---|---|
| `email-verification` | `composeEmailVerification` | **3**/hour |
| `duplicate-signup` | `composeDuplicateSignupNotice` | **2**/hour |
| `password-reset` | `composePasswordReset` (added 2 Sep 2026) | **3**/hour |

`password-reset` is the same class as `email-verification` — a stranger can
point the request endpoint at any address — so it takes the same tight ceiling.
Its copy names no person and no practice (the requester may not be the account
holder), says the link works once and dies in 30 minutes, and says the
authenticator is unchanged. A refused send is RETURNED to
`auth-tenancy/password-reset.service.ts`, which logs and stays silent — the
sign-in-code posture, not the signup mailer's throw, because the caller's `202`
must be uniform.

Both ceilings are tighter than the other three, because signup is the one flow
an unauthenticated stranger can point at an address they do not own.

⚠ **`composeDuplicateSignupNotice` takes no input, and that is the design.** It
names no practice, no person and no address. It exists to make the
uninformative `202` honest — the account holder is the only party entitled to
learn a signup was attempted — and whoever typed the address may not be them. A
message describing the attempt would hand the account straight back to the
person probing for it.

⚠ **The two callers want opposite failure behaviour**, and
`auth-tenancy/notifications-signup-mailer.ts` is where that is reconciled. A
refused verification **throws**, because a practice whose mail never left is an
account that can never be used. A refused duplicate notice **does not**, because
turning a rate-limited courtesy into a 500 tells the caller the address exists.
