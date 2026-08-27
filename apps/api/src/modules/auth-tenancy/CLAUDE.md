# auth-tenancy

**Lane A** · **Source of Truth:** SoT §3 (roles), §6 (onboarding), §15 (tenancy) · **Owner:** see the project board

## Purpose

Practices, businesses, users, memberships, sessions, TOTP, SMS-OTP portal sessions, and the RLS request context every other module depends on.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- This module owns `scopedDb` and the GUC pattern. If it is wrong, every other module's tenancy is wrong. The application database role must NOT own the schema — Postgres silently bypasses RLS for the table owner.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- auth-tenancy
```

## Current state

### The signup chain — verification and enrolment (launch stage A14)

Contract-change issue **#195**, approved. Three operations, no migration:

| Operation | Side effect | Service |
|---|---|---|
| `POST /v1/auth/email-verification` | `ingest` | `email-verification.service.ts` |
| `POST /v1/auth/totp-enrolment` | **`none`** | `totp-enrolment.service.ts` · `begin` |
| `POST /v1/auth/totp-enrolment/confirm` | `ingest` | `totp-enrolment.service.ts` · `confirm` |

All three are `security: []` and live in `signup-chain.controller.ts`, which
injects no `RequestContext`. **A1 and A2 each built half of one journey and
neither half had a door**: signup minted a verification token nothing consumed,
so an account created through the product's own front door could never become
usable, and the second factor fails closed for an account with no enrolment, so
under `OTP_MODE=totp` — what staging runs — that refusal pointed at an endpoint
nobody had built. Not "no new customers": nobody able to sign in at all.

**⚠ THE TWO-STEP WAS NOT REAL, AND THAT WAS THE SERIOUS FIND.** A2's `begin`
wrote `users.totp_secret_ref` and `confirm` only set `totp_enabled_at` — but
**nothing on the login path reads `totp_enabled_at`**; `auth.service.ts`
verifies against the ref alone. So the factor went live at step one. Mis-scan
the QR, mistype the manual seed, or run a skewed clock, and the account has a
second factor nothing can produce a code for; start again and #195's
"an account that already has an enrolment may not enrol" refuses you; and this
release has no reset flow. **One mis-scan, permanent lockout, on the account
holding a practice's clients' books.** `totp-enrolment.service.test.ts` pins
the regression by name.

The fix is `totp-enrolment-ticket.ts`: the candidate never touches the database
until a code proves an authenticator received it, travelling instead as a
signed, short-lived, user-bound ticket (15 min). Read that file before changing
anything here — it carries the disclosure argument for why an AES-GCM envelope
is safe to put in a response, and why letting the client post the *seed* back
would have been worse. Consequences worth knowing:

- **`begin` writes nothing**, which is why the contract classes it
  `x-nt-side-effect: none`. That is a fact about the implementation, not a
  taxonomy choice — if anything here starts writing, the contract is wrong and
  Governance §10.6's route-table test is what should say so.
- **`confirm`'s write is a conditional `updateMany`** on `totpSecretRef: null`,
  so "already enrolled" holds under a race rather than being a check two
  concurrent requests can both pass. `update()` cannot express it.
- An abandoned enrolment costs nothing and can simply be restarted. That is the
  property, and it is the whole point.

**Enrolment is authenticated by PASSWORD ONLY** — the one authenticated route
that cannot require a second factor, because its purpose is that the caller has
none. ⚠ It therefore opens a window in which whoever knows the password can
claim the factor. What bounds it is written at the service, not glossed: an
unenrolled account cannot be logged into by anyone, so nothing is taken from a
user who was already in; and **it shares ONE lockout counter with sign-in**,
keyed on the same normalised address, so it cannot be used as an unthrottled
password oracle. Two counters would have doubled the guesses available against
every address, at the cheaper of the two doors.

**Two extractions rather than a third copy**, both proven by the tests that
already existed:

- `signed-claims.ts` — one HMAC claims scheme, now shared by A1's
  email-verification token and A14's enrolment ticket. The key is derived from a
  **purpose label**, so the two token spaces are disjoint; `password.test.ts`
  passes unchanged, which is what proves the extraction is byte-compatible.
  `session-cookie.ts` deliberately stays separate (request-path verifier, its
  own verdict shape, risk with no reader).
- `credentials.ts` — one answer to "did this email and password authenticate
  anyone, and is that account usable". Login and enrolment share it, so the
  unverified-address rule cannot drift on the endpoint that hands out
  authenticator seeds. Its `CredentialVerdict` is a three-way rather than a
  boolean **for one reason**: login must collapse `unverified` into the uniform
  `NT-AUTH-003` (naming it answers "does this firm have an account here"), while
  enrolment may name it, because by then the password has verified.

**Five new codes, each with a runbook page** (`docs/runbooks/error-codes.md`):
`-004` invalid link · `-005` expired link · `-006` address not verified ·
`-007` already enrolled · `-008` enrolment ticket bad or expired. `-004/-005`
split exactly the way `-001/-002` do. `-006/-007` are reachable only after the
password verified, so naming them answers nothing an attacker did not have.

**The `Idempotency-Key` is required and parsed but deliberately NOT
replay-cached** on the two mutations — the call `portal.controller.ts` already
makes on `POST /portal/sessions`, and for the same reason: a replay cache keyed
on a caller-supplied header, on a public endpoint, hands the first caller's
response to the second, and `verifyEmailAddress`'s response names an email
address. Both operations are idempotent by construction instead — a one-way flag
under a conditional write, and a replayed confirmation meeting `NT-AUTH-007`.

⚠ **This did NOT add a "no second factor configured, let them in" branch and
must never grow one.** It is the door the refusal points at, not a way round it.

### Real MFA and a sign-in lockout (launch stage A2)

Two holes, both wide open until this stage. **The second factor was the literal
string `'000000'`** — one code, on every account, in every practice, published in
this directory and in `prisma/seed.ts`, and `OTP_MODE` admitted no other value so
it could not even be switched off. **And nothing in the API counted a failed
attempt**: a six-digit code with unlimited tries is a four-digit code by
lunchtime.

**The pieces, and where each lives:**

- `totp.ts` — RFC 6238 through **otplib** (the one dependency A2 was authorised
  to add), plus ten single-use recovery codes. SHA-1 / 6 digits / 30 s, which
  are the RFC's and every authenticator app's defaults — a "stronger"
  configuration is a QR that scans and then produces codes that never verify.
  Tolerance is **±1 step**, not the common ±2. `totpEngine` is exported because
  a test must generate codes with the SERVER's parameters, not its own.
  ⚠ otplib's **class** rather than its functional `verify`: the functional one
  returns a TOTP-or-HOTP union whose HOTP half has no `timeStep`, and the class
  needs its `crypto`/`base32` plugins passed explicitly or it throws
  `CryptoPluginMissingError` at the first call.
  ⚠ otplib **throws** `TokenLengthError` on anything but six digits, so
  `verifyTimed` shape-checks first and swallows guardrail throws — a mistyped
  code must be a failed login, not a 500, and without it the 19-character
  recovery branch was unreachable.
- `totp-secret.ts` — what `users.totp_secret_ref` holds, and what makes the
  column name honest: an **AES-256-GCM envelope** (`ntotp1.iv.tag.body`) around
  `{secret, recoveryHashes}`, keyed by a purpose-derived HMAC of
  `SESSION_SECRET` — the same derivation argument as `email-verification.ts`, so
  a session cookie, a verification token and a TOTP seed are three disjoint key
  spaces. Unwrap returns **null** for tamper/wrong-key/bad-shape (a failed
  login) but **throws** for an empty secret (a missing variable, said out loud).
  ⚠ Rotating `SESSION_SECRET` invalidates every enrolment. The upgrade is a KMS
  data key; the `ntotp1` tag exists so a second scheme lands beside this one.
- **Recovery codes are hashed with SHA-256, NOT the scrypt in `password.ts`, and
  that is deliberate.** They are ~79 bits of CSPRNG output from a 31-symbol
  alphabet, so there is no dictionary for a work factor to defeat — and ten
  scrypts per wrong code is a full second of blocked event loop that any
  anonymous caller can trigger. Same argument `portal-session.service.ts`
  records for `link_token_hash`. The hashes live inside the encrypted envelope;
  no code is ever stored in the clear, and spending one rewraps under a fresh
  nonce.
- `sign-in-throttle.ts` — the lockout. **Ten failures per address per 15 minutes,
  then a `429 NT-RATE-001` with `Retry-After`.** Also holds the single-use TOTP
  time-step claim (RFC 6238 §5.2 replay).
- `totp-enrolment.service.ts` — `begin` / `confirm` / `recoveryCodesLeft`. Two
  steps on purpose; `confirm` requires a code **from that candidate** (a recovery
  code is refused here — it proves nothing about the app). ⚠ **A14 rewrote
  both.** `begin` stored the candidate in `users.totp_secret_ref`, which made
  the split buy nothing, and both took a `userId` from a session a user with no
  enrolment cannot have. See the A14 section above.

**⚠ THE KEY IS THE SUBMITTED ADDRESS, NEVER THE USER ROW — this is the whole
security argument.** A lockout keyed on `users.id` can only ever fire for an
account that exists, so "you are locked out" becomes a confirmed answer to "is
this firm registered here" — the exact oracle A1's uniform `NT-AUTH-003` closes
and `POST /v1/practices` returns a contentless `202` to avoid. Keyed on the
string the caller typed, the counter is created, incremented and locked
identically for a real address and a fictional one, and
`auth.service.test.ts` asserts the two traces are **byte-identical** for all ten
attempts. That is what makes a visible `429` safe here — it reports the caller's
own recent behaviour, not anyone's existence.

The residual cost, stated because it is real: anyone who knows an accountant's
address can lock it for fifteen minutes. That is the standard lockout trade, the
window is deliberately short, and the alternative is the no-ceiling state this
replaced.

**Contrast the portal**, whose lockout returns the SAME `401 NT-OTP-001` as
every other failure. Not an inconsistency — it follows from the key. That
counter is keyed on a **link the caller holds**, whose row exists only for a real
chase, so a distinguishable answer would confirm the link names something.
`openapi.yaml` mandates the uniform 401 there for that reason.

**Login now WRITES, on exactly one branch.** Spending a recovery code removes it
from the envelope, or "single-use" is a word rather than a property. It happens
only after the credentials have verified, through the same privileged unscoped
`users` touch as the read (no RLS on `users`, and no scope context exists before
a session does). Nothing else writes: no session row, no `lastLoginAt`. The
failed-attempt counter is deliberately in memory rather than in a table — both
because `prisma/` is LAW and because a table an anonymous caller can make the
server write to is a different risk from a bounded map.

**`OTP_MODE` is S1's switch, used rather than duplicated.** S1 (#169) extended
the enum to `demo | totp` and added the production refusal of `demo`; A2's only
change to `config/env.ts` is the **comment** above the enum, correcting S1's note
that `totp` was "an enum value before it is an implementation". There is exactly
one gate and A2 did not write a second one beside it.

⚠ **`totp` fails CLOSED for an account with no enrolment.** There is no
"no second factor configured, let them in" branch and there must not be one —
that branch is a second factor an attacker opts out of by being first. **A14
built the door that refusal points at** (`POST /v1/auth/totp-enrolment`); it did
not soften the refusal, and nothing may.

### Practice signup — an accountant can create an account (launch stage A1)

`POST /v1/practices` (`operationId: createPractice`, ID LAW batch, SoT §24.5).
Before it, `demo-credentials.ts` **was** the credential system — a frozen
two-entry table — and only `prisma/seed.ts` could mint a Practice, User or
Membership. Your first customer could not log in.

**The pieces, and where each lives:**

- `practices.controller.ts` — one `POST`, `202`, empty body. It injects NO
  `RequestContext` and must never call `require()`: the contract declares
  `security: []` because the tenant a session would be scoped to is what the
  request creates.
- `practice-signup.service.ts` — the orchestration, and `provisionPractice`,
  **the one legitimately unscoped write in the system**. Read its comment
  before touching it. It is safe because `prisma/sql/rls.sql` does not enable
  RLS on `practices`, `users` or `memberships` at all (Shakib, 14 Aug 2026,
  issue #17) — nothing here disables, forces or escapes a policy, because there
  is no policy on those three tables to escape. One transaction: practice +
  user + practice-WIDE `PRACTICE_ADMIN` membership with `isOwner: true` (D44's
  release authority) + the terms audit row. **There are no further queries in
  the request** — the response is empty. Anything a later stage adds after it
  goes through `scopedDb(ctx)`, and `scopedDb` is not loosened anywhere.
- `password.ts` — the ONE scheme, `scrypt$salt$key`, extracted from
  `demo-credentials.ts` rather than invented beside it. The published fixture
  hashes verify through it, and `password.test.ts` asserts exactly that — which
  is what keeps "no second scheme" true. ⚠ the salt is used as a STRING, not
  decoded; decoding would invalidate every hash in the repo.
- `signup-audit.ts` — the `practice.terms-accepted` row, as `openapi.yaml`
  specifies. ⚠ **a knowing copy of `approvals/audit-writer.ts`**: both write the
  same `business_id IS NULL` chain, approvals has no `index.ts` seam to import
  through, and its `AuditEntry` requires a non-null `proposalId` a signup does
  not have. `practice-signup.integration.test.ts` recomputes the hash with
  **approvals'** canonical-hash to pin the copy against drift. Collapse the two
  the day approvals grows a seam.
- `email-verification.ts` — the stateless verification token. The key is
  DERIVED from `SESSION_SECRET` under a purpose label, not reused, so a session
  cookie and a verification token are not interchangeable inputs to one HMAC
  (tested). No new env var, because `config/env.ts` is not A1's path.
- `signup-mailer.ts` — **S2's seam, standing in for S2.** The notifications
  module has not merged. `RecordingSignupMailer` sends nothing, and the service
  **refuses to sign anyone up under `NODE_ENV=production` while it is what is
  wired** — an account whose verification mail went nowhere is permanently
  unusable. Request-time refusal, not a boot gate, so it cannot crash-loop
  `/healthz`. **When S2 lands, one line changes**: the `SIGNUP_MAILER` factory
  in `auth-tenancy.module.ts`.

**Login became DB-backed and `async`.** `auth.service.ts` now looks the user up
by `users.email` (the same privileged, unscoped exemption as `loadScopeForUser`
— `users` carries no RLS) and verifies `users.password_hash`. (A2 added the one
write it makes — see above.)

**Refusals, and why each is the SAME `NT-AUTH-003`:** unknown address · wrong
password · wrong TOTP · **unverified address** · deactivated user · SYSTEM
actor. "Verify your email first" is friendlier and is a confirmed answer to "is
this firm registered here" — the exact question `POST /v1/practices` returns a
contentless `202` to keep unanswerable. Naming the caller's OWN bad input
(short password, wrong terms version, blank name) is a `400` and reveals
nothing about anyone else.

**`demo-credentials.ts` is now a development FALLBACK, refused in production.**
`verifyDemoPassword` takes `NODE_ENV` as a REQUIRED argument and answers null
under `production` before it reads anything — the refusal is the signature, not
a call-site convention. It also now requires a real, verified, active `users`
row (the seed provides one with `emailVerified: true`), so a fixture login that
would have 401'd on every later request fails at the login instead.

✅ **`emailVerified` can now be flipped through the API** — `POST
/v1/auth/email-verification`, launch stage A14 (issue #195). A1's note here read
*"there is no verify-email operation in `openapi.yaml`… until it exists a
signed-up account is only usable after something outside this module marks the
address proven"*, and that was exactly right: for the whole of A1's life,
`users.email_verified` could only be set by `prisma/seed.ts`, so every account
created through the product's own front door was permanent scenery.
`email-verification.service.ts` is the consumer.

### Demo auth — real sessions, mocked TOTP (METH Stage 1, issue #118)

The product has an authenticated identity. `POST /v1/auth/sessions` (email +
password + TOTP) issues a stateless HMAC-signed `nt_session` cookie (12 h,
HttpOnly, SameSite=Lax); `AUTH_MODE=session` resolves it into the existing
`RequestContext` on every request; `GET /v1/me` serves the §13.3 context header;
`DELETE /v1/auth/sessions/current` clears the cookie. Proven live by curl and by
`auth-session.integration.test.ts` against real Postgres RLS.

**The pieces, and where each lives:**

- `session-cookie.ts` — sign/verify the cookie. The upload-token pattern
  (`base64url(claims).base64url(hmac)`), secret `SESSION_SECRET`, fail-closed on
  an empty secret. Missing/malformed/forged collapse to one `invalid` verdict
  (no oracle); `expired` is distinct so the UI may say "log in again"
  (`NT-AUTH-002`).
- `demo-credentials.ts` — `// DEMO-MOCK: Argon2 + credentials table at S1-real`.
  In-file email → scrypt hash + userId map; passwords are PUBLISHED fixtures
  (METH_MODE §7). Unknown emails burn a dummy scrypt so timing cannot enumerate.
  ⚠ **Stage 5's seed must create users with EXACTLY these ids/emails**
  (`usr_shakib_demo` / `usr_abdullah_demo`) — the coordination note is in the
  file header.
- `session-scope.ts` — verified userId → `ScopeContext`. **The one privileged
  (unscoped) lookup on the request path**, same exemption and same safety
  argument as `resolveSystemActor` (#20): `users`/`memberships` carry no RLS.
  `pickActingMembership` prefers practice-WIDE membership over practice+business
  over business-only, and is shared with `/me` so who-you-are and what-you-see
  cannot disagree.
- `auth.service.ts` — login (near-stateless: since A2 its ONLY write is burning
  a spent recovery code, proven by a test whose Prisma throws on any other
  touch) + `me()` (ONE `scopedDb` transaction; the business list is whatever RLS
  shows, never a hand-written filter). Every credential failure is the same
  `401 NT-AUTH-003`; a throttled address is `429 NT-RATE-001`. The second factor
  is `000000` under `OTP_MODE=demo` and real TOTP under `totp` (A2, above).
- `auth.controller.ts` — one controller, explicit paths (`/me` is not under
  `/auth`). Cookie `secure` only in production (a Secure cookie never sticks on
  plain-http localhost).

**The resolver itself is NOT here.** `common/context/session-context-resolver.ts`
stays in common and receives this module's two functions
(`verifySessionCookieHeader`, `loadScopeForUser`) through `index.ts`, wired in
`context.module.ts`. `RequestContext.require()` became **async** for the
membership lookup — all seven existing call sites now `await` it.

⚠ **`index.ts` must not export `AuthTenancyModule`.** `context.module.ts`
imports the seam, and the Nest module drags `auth.controller.ts` — which imports
`REQUEST_CONTEXT` back out of `context.module.ts` — into a circular evaluation
that kills boot ("Cannot access 'REQUEST_CONTEXT' before initialization").
`app.module.ts` imports the module file directly; composition roots are exempt
from the seam rule.

**Login sits legitimately outside Review → Approve**: contract
`x-nt-side-effect: none` — a stateless cookie changes no product state and no
record exists to propose over. `lastLoginAt` is deliberately not written.

### GET /v1/businesses — the workspaces read surface (built with METH Stage 6)

Contracted in Stage 2 (#120) but assigned to no stage's build list; built here
with Stage 6 because its web slice and context header are Stage 6's, and
because businesses are this module's nouns. `businesses.controller.ts` (thin,
one GET, `x-nt-side-effect: none`) + `businesses.service.ts`: one page of
RLS-visible businesses, alphabetical on the shared cursor helper, plus ONE
`groupBy (businessId, state)` aggregate for the header counts — `toReview`,
`ready`, and `failed` (REJECTED + FAILED together, the contract's own words).
Unrouted documents have no `businessId` and are counted nowhere. No write
exists on the class and none may be added — a business is created by
onboarding (post-demo), through Review → Approve like everything else.
`foldCounts` is exported for its offline test; the RLS/pagination proof lives
in `auth-session.integration.test.ts` (note its two id namespaces: `s1a_doc_*`
is the visibility assertion's exact set, `s1a_cnt_*` is the counts cast).

## Tests

```bash
pnpm --filter @neoting/api vitest run src/modules/auth-tenancy/   # unit, offline
# with docker up + .env: the integration suite runs too (skips without a DB, reds if unreachable)
```

## TODO

- [x] **Contract gap (G7, blocked A1 end-to-end): closed by A14** (#195).
      `POST /v1/auth/email-verification` flips `users.email_verified`, so an
      account created through the front door can become usable by itself.
- [x] Credentials in `users.password_hash` — done in A1 (scrypt, not Argon2:
      A1's brief was "do not introduce a second scheme"). Argon2id remains the
      upgrade, landing as a new scheme prefix beside `scrypt$` so existing
      hashes keep verifying.
- [x] **A2:** real TOTP (otplib), recovery codes, failed-attempt counting and
      lockout on `POST /v1/auth/sessions`, which now returns the `429
      NT-RATE-001` the contract has always declared.
- [x] **Contract gap #1 (G7, blocked `PLAN.md` step 1 "Set up MFA"): closed by
      A14** (#195). `POST /v1/auth/totp-enrolment` and `/confirm` hand the user
      the QR and then write the enrolment. A14 also found and fixed that the
      two-step was not actually two-step — see the A14 section above.
- [ ] **⚠ Contract gap #2 (G7) — STILL OPEN, and A14 makes it the sharpest edge
      left in this module.** `SessionCreateRequest.totp` is
      `pattern: '^[0-9]{6}$'`, so a 19-character RECOVERY code is a `400` at the
      controller and never reaches the verifier that would accept it. The codes
      are minted, hashed, verified and spent correctly, and are shown to the
      user at enrolment as *"the only way back in"* — **which is currently not
      true, because there is no route in.** Combined with `NT-AUTH-007`
      (enrolment refuses an account that already has one, since this release has
      no reset flow), a user who loses their phone has **no self-service route
      back into their own workspace**; the only remedy is an operator clearing
      `users.totp_secret_ref`, which `docs/runbooks/error-codes.md` now spells
      out under `NT-AUTH-007`. The fix is a widened field or a recovery
      operation of its own, and it needs a contract-change issue.
- [ ] **The throttle is IN-PROCESS, and A14 gave it three more callers.**
      Production runs more than one API task, so ten-per-address is really ten
      per task — now across sign-in, both enrolment steps and email
      verification, which all share the one instance.
      `notifications/email-rate-limit.ts` answered the identical problem with a
      Redis implementation behind an `EMAIL_RATE_LIMIT` switch; the same belongs
      here and needs a new variable in `config/env.ts`, which neither A2 nor A14
      owned. `SignInThrottle` is an interface so `RedisSignInThrottle` drops in
      with no call-site change — and it is now worth more than it was, because
      four endpoints inherit the fix.
- [ ] **No per-IP ceiling, deliberately.** `main.ts` never calls
      `app.set('trust proxy', …)`, so behind the ALB `req.ip` is the load
      balancer for *every* request — an IP ceiling would be a single global
      ceiling that takes sign-in down for everyone under load, and trusting
      `X-Forwarded-For` without `trust proxy` is trusting an attacker-supplied
      header. `main.ts` is not this stage's path. Wire the proxy trust first,
      then add the ceiling. ⚠ **#195 asked for per-IP on email verification and
      A14 could not deliver it, for this reason.** What shipped is per-TOKEN,
      which bounds repeated work against one link and does NOT bound a flood
      (an attacker varies the token for free). Stated in
      `email-verification.service.ts` rather than glossed, because the
      difference matters.
- [ ] **TOTP replay suppression is in-process too.** RFC 6238 §5.2 wants the
      last-accepted time step persisted per user; `users` has no column for it
      (`prisma/` is LAW), so `SignInThrottle.claimTimeStep` holds the claim in
      memory and a second API task would not see it.
- [ ] Rate limiting on `POST /v1/practices` (the contract declares `429` there
      too), refresh rotation, device history, revocation list.
- [ ] Durable idempotency store — `PracticeSignupService` uses the shared
      in-memory one, so a replayed key after a restart re-runs the signup. The
      `users.email` unique index makes that safe (a second practice cannot be
      created for the same address), but it is one change with web-upload and
      approvals, not a third copy.
- [ ] Collapse `signup-audit.ts` onto `approvals/audit-writer.ts` when approvals
      grows an `index.ts` seam and `AuditEntry.proposalId` becomes nullable.
- [ ] CSRF protection on state-changing browser requests (the contract's
      `workspaceSession` description promises it; SameSite=Lax is the interim).
- [ ] `DocumentEvent.detail` redaction can now happen — `/me` knows the role,
      but `ScopeContext` still does not carry it (documents module TODO).
- [ ] Update this file on exit — it is how the next session picks up

## ✅ SIGNUP_MAILER is real now (27 Aug 2026)

`auth-tenancy.module.ts` wired `RecordingSignupMailer` — which sends nothing —
from A1 until today. A1 said *"the composition root swaps the implementation when
[notifications] lands"*. S2 landed on 26 Aug and **nobody swapped it**, so
`PracticeSignupService`'s production refusal fired on every signup and staging
(which runs `NODE_ENV=production`) had no working signup at all. A14's
`POST /v1/auth/email-verification` therefore had no mail to consume either.

`notifications-signup-mailer.ts` is the adapter. It translates A1's two messages
into the notifications module's two, and holds the public web origin.

⚠ **A refused verification THROWS; a refused duplicate notice does not.**
`NotificationsService` reports a rate-limit refusal as a value rather than an
exception, which is right for sign-in — that endpoint must answer identically
whether an address is known, unknown or limited. Signup is the opposite case, and
the asymmetry is pinned in `notifications-signup-mailer.test.ts`.

⚠ **`VERIFY_EMAIL_PATH` is `/app/verify-email`, and M9 must serve it.** The path
is declared once, in the mailer, so the mail and the screen that receives the link
cannot drift. M9's landing page reads `token` from the query and posts it to
`POST /v1/auth/email-verification`.

⚠ **The origin is still a constant**, duplicated with
`clients-team-settings/setup-link.ts`'s `DEFAULT_APP_ORIGIN`, because
`config/env.ts` has no `APP_ORIGIN` key. Both sites point at the same missing
key; promoting it is one line in each module.

### ⚠ The verification link pointed at a route that did not exist (28 Aug 2026)

`VERIFY_EMAIL_PATH` was `/app/verify-email`, declared here before M9 merged with
a comment saying M9 must serve it. M9 merged 48 minutes later serving
`/signup/verify`. **Nothing failed.** `apps/web` is a single-page app, so the
wrong path answered **200** with the app shell and the token was dropped — every
verification link in every signup email was inert, the first person through the
flow could not verify, could not enrol and therefore could not sign in, and no
error appeared anywhere.

Two lessons are worth more than the one-word fix:

- **A path agreed in a comment between two stages is not agreement.** Both halves
  were internally consistent and neither referred to the other.
- **An SPA turns a wrong route into a 200.** The failure mode a 404 would have
  caught on the first click instead survived a full deploy.

`notifications-signup-mailer.test.ts` now reads M9’s own source and fails if the
two drift again.
