# common/context — the request → `ScopeContext` seam

**Source of Truth:** Governance §5.2 · **Added by:** issue #75 · **Session resolver filled by:** METH Stage 1 (issue #118)

## What this is

`scopedDb(prisma, ctx, fn)` needs a `ScopeContext` for every query. This
directory is the socket that produces one per request. Since #118 both modes are
real: `fixture` builds it from dev headers, `session` from the signed
`nt_session` cookie plus a membership lookup.

## The rule

A controller injects `REQUEST_CONTEXT` and awaits it — no casting, no header
parsing at the call site:

```ts
constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}

async list() {
  return this.service.list(await this.ctx.require(), parsed);
}
```

**`require()` is async** (since #118 — session resolution loads memberships from
the database). It resolves to the `ScopeContext` or rejects **401
`NT-AUTH-001`** (`NT-AUTH-002` for an expired session), RFC 7807 via the
existing `ProblemFilter`.

## How it fits together

- **`request-context.ts`** — the `RequestContext` interface, the
  `ContextResolver` seam (sync or async `resolve`), and `AlsRequestContext`,
  backed by AsyncLocalStorage. `ContextMiddleware` opens the store per request
  with a header reader; **resolution is lazy** — on `require()`, inside Nest's
  pipeline where `ProblemFilter` can turn a bad context into a 401. The result
  is memoized as a promise, so many `require()` calls in one request cost ONE
  membership lookup.
- **`selectContextResolver(mode, sessionDeps)`** — config-selected on
  `AUTH_MODE`. The session deps are required by signature, so forgetting to wire
  them is a compile error, not a request-time 500.
- **`FixtureContextResolver`** (`AUTH_MODE=fixture`, the default) — DEV ONLY.
  Builds a context from `X-NT-Actor` / `X-NT-Practice` / `X-NT-Business`.
- **`SessionContextResolver`** (`AUTH_MODE=session`) — real since #118: verify
  cookie → load memberships → `ScopeContext`. Its two collaborators are
  **injected functions**, not imports — the cookie format and the membership
  lookup belong to `modules/auth-tenancy`, and `common/` must not depend on a
  module. `context.module.ts` is where they meet (assembly), importing ONLY the
  module's public seam.

⚠ **Do not export the Nest `AuthTenancyModule` through that seam.**
`context.module.ts` → seam → module → `auth.controller` → `REQUEST_CONTEXT`
(defined in `context.module.ts`) is a circular evaluation that kills boot. Found
live; recorded in both CLAUDE.mds and guarded by a comment in the seam.

## The one guarantee that carries this

`AUTH_MODE=fixture` trusts request headers for identity — the shape of an auth
bypass. It is safe **only** because `env.ts` refuses `fixture` under
`NODE_ENV=production` at boot (a `superRefine`, so the process never starts).

The session mode's own fail-closed story: an empty `SESSION_SECRET` refuses to
sign or verify (a loud 500 naming the variable), and deliberately does NOT
refuse boot — staging already runs `AUTH_MODE=session` without the variable, and
a boot gate would take `/healthz` (and the deploy) down with it. See the comment
in `env.ts`.

## Do NOT

Build tokens, passwords or TOTP here — that is `modules/auth-tenancy`. This
directory owns the seam and the resolver shell only.
