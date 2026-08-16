# common/context — the request → `ScopeContext` seam

**Source of Truth:** Governance §5.2 · **Added by:** issue #75

## What this is

`scopedDb(prisma, ctx, fn)` needs a `ScopeContext` for every query. The thing that *produces* one for an HTTP request is auth/tenancy — that is **S1, Shakib's track**, and it is not landing before the endpoints that need it. This directory is the socket S1 plugs into, so those endpoints can be built now and nothing moves when auth arrives.

## The rule

A controller injects `REQUEST_CONTEXT` and passes the result straight to `scopedDb` — no casting, no header parsing at the call site:

```ts
constructor(@Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext) {}

async list() {
  return scopedDb(this.prisma, this.ctx.require(), (db) => db.document.findMany(...));
}
```

`require()` returns the `ScopeContext` or throws **401 `NT-AUTH-001`** (RFC 7807, via the existing `ProblemFilter`).

## How it fits together

- **`request-context.ts`** — the `RequestContext` interface, the `ContextResolver` seam, and `AlsRequestContext`, backed by AsyncLocalStorage (the same house pattern as `common/trace`). `ContextMiddleware` opens the store per request with a header reader; **resolution is lazy** — it happens on `require()`, inside Nest's pipeline where `ProblemFilter` can turn a bad context into a 401. An error thrown from Express middleware would sidestep that filter, which is why the middleware only captures headers.
- **`selectContextResolver(mode)`** — config-selected on `AUTH_MODE`, the same shape as `INGEST_QUEUE` / `OBJECT_STORE` / `DOCUMENT_GUARD`.
- **`FixtureContextResolver`** (`AUTH_MODE=fixture`, the default) — DEV ONLY. Builds a context from `X-NT-Actor` / `X-NT-Practice` / `X-NT-Business` headers.
- **`SessionContextResolver`** (`AUTH_MODE=session`) — the placeholder S1 replaces; throws "not implemented" today.

## The one guarantee that carries this

`AUTH_MODE=fixture` trusts request headers for identity — the shape of an auth bypass. It is safe **only** because `env.ts` refuses `fixture` under `NODE_ENV=production` at boot (a `superRefine`, so the process never starts), not at request time. When S1 lands it implements `SessionContextResolver` and flips the default; nothing else in any module changes.

## Do NOT

Build tokens, passwords, sessions or TOTP here — that is S1. This directory is only the seam.
