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
— `users` carries no RLS) and verifies `users.password_hash`. It still writes
nothing: no session row, no `lastLoginAt`. Failed-login counting and lockout are
A2's, and they are a write.

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

⚠ **`emailVerified` cannot be flipped through the API.** There is no
verify-email operation in `openapi.yaml` — no `POST /practices/…/verify`, no
`GET /verify/{token}`. Minting is done; the endpoint that consumes the token is
a contract change (G7), and until it exists a signed-up account is only usable
after S2 sends the mail and something outside this module marks the address
proven. Raised in the A1 report.

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
- `auth.service.ts` — login (stateless: writes NOTHING, proven by a test whose
  Prisma throws on any touch) + `me()` (ONE `scopedDb` transaction; the business
  list is whatever RLS shows, never a hand-written filter). Every credential
  failure is the same `401 NT-AUTH-003`. TOTP checks literal `000000` under
  `OTP_MODE=demo` (`// DEMO-MOCK: Twilio Verify`).
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

- [ ] **Contract gap (G7, blocks A1 end-to-end):** there is no verify-email
      operation in `openapi.yaml`, so nothing can flip `users.email_verified`
      through the API and a signed-up account cannot become usable by itself.
      The token is minted and tested (`email-verification.ts`); it needs a
      contract-change issue and then a controller.
- [x] Credentials in `users.password_hash` — done in A1 (scrypt, not Argon2:
      A1's brief was "do not introduce a second scheme"). Argon2id remains the
      upgrade, landing as a new scheme prefix beside `scrypt$` so existing
      hashes keep verifying.
- [ ] **A2:** real TOTP, failed-login counting and lockout, rate limiting on
      `POST /v1/practices` and `POST /v1/auth/sessions` (the contract declares
      `429` on both and nothing implements it), refresh rotation, device
      history, revocation list.
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
