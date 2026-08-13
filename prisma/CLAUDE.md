# prisma/ — **LAW** (Sprint-0 contract, G7/D15)

Schema, RLS policies and migrations. Owned by Shakib; changes go through the contract-change process.

## The tenancy guarantee

Every tenant-owned row carries `practice_id` (nullable for standalone businesses) and `business_id`. RLS is enforced **below the application layer**:

- Each request-scoped unit of work opens a transaction that first runs `SET LOCAL app.actor_id / app.practice_id / app.business_id / app.actor_role / app.session_scope`; policies read them via `current_setting()`.
- **The only sanctioned accessor is `scopedDb(ctx)`.** An unscoped query is a code-review reject and a CI-grep failure.
- Delegated OTP sessions set `app.session_scope = 'delegated_upload'` plus granted item IDs, and can touch exactly those items and nothing else.

## ⚠ The role split that makes RLS real

**Postgres bypasses RLS for the table owner.** The migration role owns the schema; the application connects as a separate, non-owning role, and tenant tables are `FORCE ROW LEVEL SECURITY`. Without this, every policy in this directory is decorative and the tenancy story is fiction.

```sql
CREATE ROLE nt_app LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO nt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nt_app;
ALTER TABLE <each tenant table> FORCE ROW LEVEL SECURITY;
```

The CI tenancy suite (Governance §15.4) must assert that `nt_app` cannot bypass RLS, with real tokens, and that cross-practice, cross-client and delegated-session-overreach attempts **all fail**.

## Migrations — expand-contract only

1. **Expand** — add the nullable field/table plus its RLS policy
2. **Dual-write** — application writes both
3. **Backfill** — batched, resumable, idempotent
4. **Contract** — drop the old field only after a full release cycle, in its own migration

Never drop or rename a column in one step. Indexes ship in the **same migration** as the query pattern that needs them. `prisma migrate dev` is local-only; `migrate deploy` is the only migration command that runs anywhere else.

## Current state

**Draft for review — not yet frozen.**

- `schema.prisma` — all 8 entity groups from SoT §15, ~35 models. `prisma validate` passes.
- `sql/rls.sql` — helper functions, the single `app_can_access_business()` predicate, policies for every tenant table, delegated-OTP scoping, the append-only audit trigger, and the ActionProposal guard trigger.

**No migration has been generated yet** — that needs a running database:

```bash
docker compose up -d
pnpm --filter @neoting/api exec prisma migrate dev --create-only --name init
cat prisma/sql/rls.sql >> prisma/migrations/*_init/migration.sql
pnpm --filter @neoting/api exec prisma migrate dev
```

### Open questions for the freeze

1. **Money width.** Every monetary column is `Int` pence, ceiling £21,474,836.47 per column. Comfortable for SME documents; confirm no pilot client needs more before this is law.
2. **Extraction fields as `Json`.** Per-field value + confidence + provenance in one column. Flexible and matches the "fields jsonb" of §15 — but it cannot be indexed per field, so any future "find every document where the VAT number came from a low-confidence read" query needs a GIN index or promoted columns. Fine for v1; worth knowing.
3. **`documents` carries denormalised header fields** (supplier, total, date) alongside `extractions`. Deliberate: inbox lists and search would otherwise reach into JSON on every row. The accepted extraction is the source of truth and these are a projection — they must be written by one code path only.
4. **`audit_events.seq`** is `BigInt` per business for the hash chain. Allocation needs a per-business sequence or advisory lock; decide before the audit service is written.
