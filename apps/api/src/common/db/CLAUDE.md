# common/db — `scopedDb`, the only sanctioned database accessor

**Source of Truth:** Governance §5.2 (RLS), R6 · **Added by:** issue #17 (S1)

## The rule

```ts
const documents = await scopedDb(prisma, ctx, (db) =>
  db.document.findMany({ where: { inbox: 'UNROUTED' } }),
);
```

Every query goes through this. Not most, not the ones touching tenant tables — every one.

## Why it is a lint error rather than a review convention

An unscoped query does not throw and does not look wrong. It runs with no request context, and then one of two things happens:

- as `nt_app`, every policy branch fails and the query returns **nothing** — indistinguishable from an empty workspace;
- as the owner or a superuser, RLS is bypassed and it returns **everything**, across every practice.

Both are silent. A reviewer would have to notice an absence to catch the first and would see nothing at all wrong with the second. So `no-restricted-imports` blocks `PrismaClient` outside this directory (`apps/api/eslint.config.js`), and the exemption is scoped by path so it cannot spread.

## Three details that carry the guarantee

1. **`SET LOCAL`, never `SET`.** Local settings die with the transaction. On a pooled connection a plain `SET` leaks one user's context to whoever gets that connection next — a cross-tenant read with nothing wrong at the call site.
2. **`set_config($1, $2, true)`, never interpolation.** `SET LOCAL x = ${value}` cannot be parameterised by Postgres, so building it as a string makes every context value an injection point — including `actorId`, which on the portal path derives from a link a stranger may hold.
3. **All five GUCs are written on every entry**, even when absent, so the context is a function of this transaction alone and not of whatever ran on the connection before it.

## Context

`ScopeContextSchema` parses at the boundary and refuses two shapes outright: a context with neither practice nor business (every policy branch fails, and the caller debugs an empty screen), and a `delegated_upload` with an empty grant (reads as "unrestricted" to a human, denies everything in SQL). Item ids containing a comma are rejected rather than escaped — they are joined into one GUC, and every id in this system is a cuid.

`systemContext(practiceId, systemUserId)` is what workers use. It deliberately takes **no** businessId: a worker processing an inbound document does not know whose it is, and one that guessed would file a client's receipt into another client's workspace.

## Tests

`scoped-db.integration.test.ts` runs against a real database, because every assertion is about what *Postgres* does with the GUCs — a mock would simply agree with whatever we told it.

```bash
docker compose up -d && pnpm db:app-role && pnpm db:migrate && pnpm db:seed
pnpm --filter @neoting/api test
pnpm db:tenancy-check      # the SQL-level suite, 24 assertions
```

The suite reports as **skipped** when no database is configured, and **fails** when one is configured but unreachable. It never passes without running: a tenancy suite that quietly reports green is worse than none, because it is trusted.

## The SYSTEM actor (issue #20)

A worker has no logged-in user, but every write still needs an actor for the
audit trail and the GUCs. `resolveSystemActor(prisma, practiceId)` finds the
practice's `UserKind.SYSTEM` membership and returns its userId, which then feeds
`systemContext(practiceId, systemUserId)`.

That lookup is the **one** legitimately unscoped query in the codebase — it runs
`prisma.membership.findFirst` directly, not through `scopedDb`, because it is the
bootstrap that *produces* the context every other query needs, and there is no
actor to scope by yet. It is safe only because `users` and `memberships` carry no
RLS (verified empirically). It **fails loudly** (throws) when a practice has no
SYSTEM actor, rather than writing a document with a dangling actor — a missing
system user is a seed bug, not a runtime branch to paper over.

Every worker consumer resolves its actor this way: the `PrismaDocumentSink` (#20)
and the `PrismaDuplicateDetector` (#40) both call it before opening their
`scopedDb` transaction. The detector *writes a business-owned row* (`duplicates`)
from a practice-only context — which works only because `app_can_access_business`
has a practice-membership branch (see the ingestion-routing CLAUDE.md finding).

## TODO

- [ ] Request-scoped context from the session, once auth lands — today every caller builds its own.
- [x] #20: `scopedDb` wired into the ingest worker via `queue/PrismaDocumentSink`
      — documents + their first `DocumentEvent` persist in one transaction under
      the practice's `systemContext`. Proven by `queue/document-sink.integration.test.ts`
      against a real database (unrouted doc visible to its own practice, invisible
      to another).
- [x] #20: SYSTEM user looked up per practice (`resolveSystemActor`) rather than
      passing its id in.
