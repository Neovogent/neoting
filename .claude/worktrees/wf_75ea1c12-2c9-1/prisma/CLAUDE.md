# prisma/ — **LAW** (Sprint-0 contract, G7/D15)

Schema, RLS policies and migrations. Owned by Shakib; changes go through the contract-change process.

## The tenancy guarantee

Every tenant-owned row carries `practice_id` (nullable for standalone businesses) and `business_id`. RLS is enforced **below the application layer**:

- Each request-scoped unit of work opens a transaction that first runs `SET LOCAL` for the five GUCs the policies actually read: `app.actor_id`, `app.practice_id`, `app.business_id`, `app.session_scope`, `app.granted_item_ids`. (An earlier draft listed `app.actor_role`; no policy reads it — roles are checked at call sites, never in SQL.)
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

## Documents are practice-anchored until they are business-anchored

Issue #17. `documents.business_id` is **nullable** and `documents.practice_id` was added, because `inbox` defaults to `UNROUTED` — a document from a sender we do not recognise has no business until routing says so, and a NOT NULL `business_id` made that state unwritable.

- **At least one** of the two is guaranteed by the CHECK constraint `documents_tenant_anchor` (`practice_id IS NOT NULL OR business_id IS NOT NULL` — an OR, not exactly-one; both-set is the normal routed case, since web upload anchors on the business and its practice together). A row with neither would be owned by nobody and visible to nobody — lost in plain sight, with nothing reporting it. This bullet said "exactly one" until #81's review caught it: the constraint cannot serve as an exactly-one test oracle, because practice-only, business-only and both-set all pass it.
- `practice_id` is nullable too, because a standalone business has no practice above it. Such a business receives at its own address, so `business_id` is known from the first byte.
- `documents` is **not** in the `direct_tables` loop; it has an explicit two-branch policy via `app_can_access_document()`.
- **The five child tables changed with it** — `extractions`, `document_events`, `suggestions`, `item_threads`, `approvals` reach their tenant through `documents`, and a predicate of the form `app_can_access_business(d.business_id)` returns NULL, not true, for an unrouted parent. Missing one hides that document's children from the only people who can route it.
- `documents_delegated_upload` gained `AND business_id IS NOT NULL`. That changed nothing previously possible — before this, every document had a business — but without it a delegated OTP session could read an unrouted document that reached its grant.

## Machine writes need an actor

`UserKind.SYSTEM`: one seeded user per practice with a practice-level membership. Workers run as that actor, so machine writes go through the *same* predicate as human ones — no third session scope, no privileged connection, and `audit_events.actor_id` names a real row. `rls.sql` did not change for this.

SYSTEM users have no email, password or sessions. Exclude them from team lists, seat counts and invites.

## Current state

**Draft for review — not yet frozen.**

- `schema.prisma` — all 8 entity groups from SoT §15, ~35 models. `prisma validate` passes.
- `sql/rls.sql` — helper functions, the single `app_can_access_business()` predicate, policies for every tenant table, delegated-OTP scoping, the append-only audit trigger, and the ActionProposal guard trigger.

- `migrations/*_init` — generated, applied, and **verified against a live database**.
- `sql/tenancy-check.sql` — assertions all passing. Run it with `pnpm db:tenancy-check` after any policy change; it is the miniature of the CI suite that Governance §15.4 requires.

## ActionProposal is anchored like Document (issue #104)

`action_proposals.practice_id` exists because the original policy read
`business_id IS NULL OR app_can_access_business(business_id)` — which made a
NULL-business proposal **world-readable and world-writable**, and NULL business
is the *default* for `document.route`, whose subject is an unrouted document.
The migration `20260817130000_action_proposals_practice_anchor` added the
column, backfilled it from each business's own practice, added the
`action_proposals_tenant_anchor` CHECK (**at least one** anchor — an OR, same
shape and same not-exactly-one semantics as `documents_tenant_anchor`), and
rewrote the policy onto `app_can_access_document(business_id, practice_id)`,
which despite its name is the anchor-pair predicate. Section 9 of
`tenancy-check.sql` is the regression: it fails against the old policy.

### Regenerating from scratch

The RLS must be appended **before** the migration is applied — otherwise the tables exist without policies and the first seed writes unprotected rows.

```bash
docker compose up -d
pnpm --filter @neoting/api exec prisma migrate reset --force --skip-seed
pnpm --filter @neoting/api exec prisma migrate dev --create-only --name init
cat prisma/sql/rls.sql >> prisma/migrations/*_init/migration.sql
pnpm --filter @neoting/api exec prisma migrate deploy   # deploy, not dev — dev prompts
pnpm db:tenancy-check
```

### ✅ Provisioning runs under these policies — settled 14 Aug 2026

An earlier draft of this file warned that provisioning could not run as `nt_app` and would need a `SECURITY DEFINER` function or a privileged connection. **That was wrong**, and it was wrong in the expensive direction: it proposed a bypass for a problem that does not exist.

`users`, `practices`, `memberships` and `sessions` appear in none of the RLS table lists — they carry no policies. So the ordering resolves itself:

1. `practices` insert — unpoliced
2. `users` insert — unpoliced
3. `memberships` insert — unpoliced, **and this is the row the predicate needs**
4. `businesses` insert — policed, and now passes on its own merits, because `businesses`' `WITH CHECK` accepts a practice-level membership

Verified against the live database as `nt_app`, in one transaction, with no bypass of any kind. Reproduce it with the transcript in issue #17.

No `SECURITY DEFINER` function, no second connection, no loosened policy. If a future change makes `memberships` tenant-owned, this reasoning collapses and the question reopens — so that change must revisit this section.

### Open questions for the freeze

1. **Money width.** Every monetary column is `Int` pence, ceiling £21,474,836.47 per column. Comfortable for SME documents; confirm no pilot client needs more before this is law.
2. **Extraction fields as `Json`.** Per-field value + confidence + provenance in one column. Flexible and matches the "fields jsonb" of §15 — but it cannot be indexed per field, so any future "find every document where the VAT number came from a low-confidence read" query needs a GIN index or promoted columns. Fine for v1; worth knowing.
3. **`documents` carries denormalised header fields** (supplier, total, date) alongside `extractions`. Deliberate: inbox lists and search would otherwise reach into JSON on every row. The accepted extraction is the source of truth and these are a projection — they must be written by one code path only.
4. **`audit_events.seq`** is `BigInt` per business for the hash chain. Allocation needs a per-business sequence or advisory lock; decide before the audit service is written.

## `seed.ts` — the METH Stage 5 demo cast (§7)

Additive-only, no schema change. `prac_ledgerline`'s display name is
"Neovogent Accounting" (id unchanged). Two demo login users
(`usr_shakib_demo` / `shakib@neoting.test` → PRACTICE_ADMIN,
`usr_abdullah_demo` / `abdullah@neoting.test` → PRACTICE_STANDARD, both
practice-wide on `prac_ledgerline`) — **ids/emails are pinned by
`apps/api/src/modules/auth-tenancy/demo-credentials.ts`; a mismatch 401s every
request.** `con_owner_burger` (owner@americanburger.test / +447700900001) is the
routing identity for American Burger's email/WhatsApp beats. Chase targets on
`biz_burger` carry ABSOLUTE dates (`bookedAtAbs`): Currys −129900p / 9 Aug 2026,
Google −60000p / 5 Aug 2026 (Google was moved here from Cosmo). `refsync_burger_coa`
seeds the Xero chart-of-accounts categories the Stage 4 profiles use. **No Bidfood
rule is seeded** — Stage 13 creates it live. `txn_NNN` ids are position-derived,
so the chase/proposal references (`txn_003`, `txn_017`, `txn_023`, `txn_026`) were
re-verified after the row-order change.

**The two seeded proposals follow the contract since METH S12** (issue #140):
`prop_chase_dental` is `chase.send` with a real `ChaseSendPayload` (its
pre-contract `chase-send`/`{chases:[…]}` shape made `POST …/review` refuse it
with `NT-PRP-001` — a landmine on the live approval queue, not history), and
`prop_publish_burger` is `publish.batch`. Their hashes are real SHA-256 hex via
the in-file `fixtureHash` helper, because the contract patterns every hash
`^[a-f0-9]{64}$` and a `sha256:` prefix fails the generated parse of the queue.
