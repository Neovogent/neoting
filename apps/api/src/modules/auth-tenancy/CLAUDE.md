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

## Tests

```bash
pnpm --filter @neoting/api vitest run src/modules/auth-tenancy/   # unit, offline
# with docker up + .env: the integration suite runs too (skips without a DB, reds if unreachable)
```

## TODO

- [ ] **S1-real (post-demo):** Argon2 credentials in `users.password_hash`, real
      TOTP, refresh rotation, device history, rate limiting, revocation list —
      all named out of scope by METH Stage 1.
- [ ] CSRF protection on state-changing browser requests (the contract's
      `workspaceSession` description promises it; SameSite=Lax is the interim).
- [ ] `DocumentEvent.detail` redaction can now happen — `/me` knows the role,
      but `ScopeContext` still does not carry it (documents module TODO).
- [ ] Update this file on exit — it is how the next session picks up
