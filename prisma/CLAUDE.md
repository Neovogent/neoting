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

## `Practice.whatsappPhoneNumberId` (1 Sep 2026, migration 20260901180000)

The #79 promised column, additive and nullable: the Meta `phone_number_id` of
the WhatsApp Business number that RECEIVES a practice's client messages —
derived from the receiving number, never the sender. UNIQUE (one Meta number
delivers to one practice). Unset practices keep resolving through the
`WHATSAPP_PRACTICE_MAP` env override; the worker's
`PrismaWhatsAppPracticeResolver` reads this column as the fallback, each
practice's SYSTEM context asked for its own row (RLS answers — no new policy
needed, `practices` already admits its own tenant). Landed under the owner's
1 Sep 2026 ruling that retired the G7 issue ceremony; recorded in
`packages/contracts/CLAUDE.md`.

## `Document.deletedAt` — `20260902220000_document_soft_delete` (2 Sep 2026)

One nullable column and one index. **Writes no data**: every existing row keeps
NULL, which is exactly "not deleted", so the new default listing predicate
(`deleted_at IS NULL`) admits every row visible today and product behaviour is
unchanged the moment it lands. No UPDATE, no DELETE, no NOT NULL, no DEFAULT
that would rewrite the table, nothing dropped or renamed — safe against the
local database holding real client data pulled from staging.

Expand-contract: this is the EXPAND step and **no contract step is owed**,
because nothing is being replaced. Reversing it is one `DROP COLUMN`, and
reversing it after deletions would restore those documents to their queues
rather than lose anything.

| Column / index | Why |
|---|---|
| `deleted_at TIMESTAMP(3) NULL` | Trash. NULL means not deleted. `TIMESTAMP(3)` and not `TIMESTAMPTZ` — every timestamp in this schema is `TIMESTAMP(3)` (Prisma's `DateTime` mapping), the repo rule is UTC in storage with London applied at render, and `archived_at` two lines above it is `TIMESTAMP(3)`. ⚠ A lone `TIMESTAMPTZ` is ALSO permanent drift: `migrate diff` reports it as an altered column forever, so every later migration would open with a spurious ALTER. This was written `TIMESTAMPTZ` first and the drift check caught it. |
| `documents_business_id_deleted_at_idx` | `GET /v1/documents?deleted=true` is `WHERE business_id = ? AND deleted_at IS NOT NULL`, and every one of the five existing indexes leads with `business_id` followed by a PIPELINE column, so none can serve it. Ships with the query pattern that needs it. NOT partial (`WHERE deleted_at IS NOT NULL`) despite Trash being the only reader: Prisma's `@@index` cannot express a predicate, so a hand-written partial index drifts out of `schema.prisma` — the same reasoning recorded on `bank_transactions_account_id_import_fingerprint_key`. |

⚠ **NOT a ninth `DocumentState` member, and the enum was the obvious wrong
choice.** `DocumentState` is a TOTAL domain in three places that would have
broken quietly rather than loudly: `portal-document-status.ts` maps every member
onto one of five words a CLIENT is shown (and "deleted" must never be one of
them), `LEGAL_TRANSITIONS` is a total 8×8 matrix, and `check-contract.mjs`
mirrors the enum into `openapi.yaml` verbatim, so the value would have entered
the public API's state vocabulary too.

The deeper reason is that deletion is **orthogonal to pipeline state**: a READY
document deleted and restored is READY again, and `state` is what remembers
that. A state member would have had to destroy the answer in order to record the
question. `archived_at` sits beside `state` for the same reason, so the shape
has a precedent in this very table.

**No RLS change.** `documents` is already in the policed set with FORCE ROW
LEVEL SECURITY, and a policy is written over the ROW, not its columns. Deletion
is a product predicate applied on top of what RLS already narrowed to —
`apps/api/src/common/documents/deleted-documents.ts` is the one place it is
spelled — never a tenancy boundary.

⚠ **Two `document_id` columns in this schema still have NO foreign key**:
`statements.document_id` and `supplier_statements.document_id`. `document.purge`
therefore checks them explicitly before destroying anything, because Postgres
would happily leave them dangling. Adding those FKs is a real follow-up.

## Practice invitations — `20260902120000_practice_invites` (2 Sep 2026)

Additive throughout, no policy change, and the last part is the point:
`invites_tenant` already admits a practice-level row (`business_id IS NULL AND
practice_id = app_practice_id()`), which is exactly the shape a colleague
invitation has — so **per-client scoping for an invited `PRACTICE_STANDARD` is
enforced by policies that already existed.**

| Column / index | Why |
|---|---|
| `hide_financial_fields BOOLEAN NOT NULL DEFAULT false` | SoT §3.3, carried onto the membership acceptance creates. ⚠ **Written and read by nothing** when a document is served — `POST /businesses/{id}/members` accepted it and silently DISCARDED it, which is worse. Storing the intent is the honest half; the redaction is owed, and no screen may present it as a protection in force |
| `business_ids TEXT[] NOT NULL DEFAULT '{}'` | The clients a scoped colleague is assigned. An array rather than N invitation rows: one decision, one email, one token — and `token_hash` is UNIQUE, so N rows would need N tokens. **Empty means practice-wide.** No FK: Postgres has none on an array element, and the ids are re-checked against RLS at acceptance anyway |
| `invited_by_user_id TEXT` → `users(id)` **ON DELETE SET NULL** | So the acceptance screen can name a person. `SET NULL` and not `CASCADE`, deliberately: an invitation belongs to the practice, not to the colleague who sent it — cascading would silently withdraw every outstanding invitation the moment an admin was removed, invisible to the people holding the links |
| `invites_practice_id_idx` | The practice team list filters it and `invites_tenant`'s practice branch compares it on every row. `invites_business_id_idx` covers only the client half |

⚠ **NOT `@@unique([practiceId, email])`.** `team.service.ts` documents a
create-if-absent pattern that assumes re-inviting an address is legal, and it is:
an invitation nobody opened must be re-sendable without an admin first finding
and deleting the old row.

⚠ **A scoped colleague's memberships carry `practice_id = NULL`**, and that null
is the whole mechanism rather than an omission. `app_can_access_business()`'s
third branch grants a user access to EVERY business of any practice they hold a
`practice_id` on — so a scoped colleague whose rows also carried one would see
exactly the clients the scope exists to withhold.
`clients-team-settings/practice-invite.integration.test.ts` proves the confinement
against real Postgres, and it would pass for the wrong reason if the shape
changed.

**`seed.ts` changed with it**: `mem_shakib_demo` now carries `isOwner: true`.
It is the only login-able demo admin, D44's release rule is `canRelease(role) &&
isOwner`, and without the flag nobody on a seeded machine could release — so the
one behaviour the release gate exists to protect could be tested by nobody.

## `BankTransaction.importFingerprint` — `20260902160000` (2 Sep 2026)

**The NULL-is-distinct trap, in the one table where it cost a client half a
ledger.** `bank_transactions_account_id_provider_transaction_id_key` looked like
a dedupe guarantee and was inert: D40 makes manual statement upload the ONLY
bank input, so every row's `provider_transaction_id` is NULL, and Postgres
treats NULLs as **distinct** in a plain unique index. A real client held 2,288
transactions that were 1,144 rows imported twice, from two statements covering
the identical period nine seconds apart, and nothing in the schema objected.

| Change | Why |
|---|---|
| `import_fingerprint TEXT` (nullable) | Content-derived identity for a line from an uploaded file: sha256 over account + booked date + currency + signed pence + normalised description + **the occurrence ordinal of that tuple within its own source file**. The ordinal is what keeps two genuinely identical purchases as two rows while making the same line, imported twice, collide. NULL for a feed row, which carries a real `provider_transaction_id` |
| `@@unique([accountId, importFingerprint])` | The one that actually holds. NOT partial — a plain unique index already leaves NULL rows unconstrained, Prisma's `@@unique` cannot express a predicate, and a hand-written partial index would drift out of `schema.prisma` on the next `migrate diff` |

⚠ **This migration writes NO data**, and that is the safety argument in full: an
`ADD COLUMN` with no default and a unique index over a column that is NULL on
every existing row. No UPDATE, no DELETE, no NOT NULL, no table rewrite — so it
is safe against a database holding real, and already duplicated, client rows.

**Keying the rows that predate it is deliberately NOT in the migration.**
`apps/api/src/db/backfill-import-fingerprints.ts` does it — idempotent (`WHERE
import_fingerprint IS NULL`), reversible in one statement (`UPDATE
bank_transactions SET import_fingerprint = NULL`), and it **deletes nothing**.
Doing it in SQL would mean re-implementing the normalisation and the hash of
`banking-matching/statement-ingest/row-identity.ts` in a second language, and
the two would eventually disagree about what a line's identity is — which is the
one thing that must never happen.

⚠ **It runs per practice through `scopedDb`, and the first draft did not.**
`bank_transactions` is in the `direct_tables` RLS loop with FORCE ROW LEVEL
SECURITY, so a query with no GUCs set matches **no rows and does not error** —
the backfill reported "nothing to do" against six un-keyed rows. That is the
same class of silence as the `otp_sessions` note below: a policy answering
nothing looks exactly like there being nothing. `backfill-system-actors.ts` gets
away with a root-client read only because `practices`, `users` and `memberships`
carry no policies at all.

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

- `schema.prisma` — all 8 entity groups from SoT §15, ~37 models. `prisma validate` passes.
- `sql/rls.sql` — helper functions, the single `app_can_access_business()` predicate, the anchor-pair `app_can_access_document()`, policies for every tenant table, delegated-OTP scoping, the D43 capability-link resolver, the append-only audit trigger, and the ActionProposal guard trigger.

- `migrations/*_init` — generated, applied, and **verified against a live database**.
- `migrations/20260826120000_id_law_batch` — applied, and verified **twice**: incrementally against the running local database, and from scratch against a throwaway one (`migrate deploy` over the whole chain, then `migrate diff` returning an empty migration, 38 policies installed, `tenancy-check.sql` green). A migration that only works forward from today's database is a migration a fresh clone cannot run.
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

## The ID LAW batch — `20260826120000_id_law_batch` (launch stage S0, issue #164)

One migration for the whole of Initial Delivery's schema need, because three
people block on this directory and four approvals would have cost four blocks.
Additive throughout: every new column is nullable or defaulted, one NOT NULL is
**dropped**, nothing renamed or removed.

| Change | Why it is not optional |
|---|---|
| `IntegrationKind` += `VT`, `MANUAL` | **The blocker.** `publish-batch.ts` resolves an Integration before admitting a document, `resolveIntegration` is the only door, and the enum held only the four ledger vendors D42 removed from this release — while D47 forbids intake from asking for a connection. Nothing could ever reach Published, so the export had nothing to export and SoT §24.7 could not run. |
| `businesses` += `stripe_customer_id` (UNIQUE), `subscription_status`, `plan`, `subscription_current_period_end` | D48. Four columns, not a `subscriptions` table: one flat plan per business, so a child table buys a join for nothing. **The UNIQUE is load-bearing** — the Stripe webhook has no session and cannot lean on RLS, so it resolves the tenant from the customer id and must assert exactly one match. |
| `exports` += `target`, `period_start`, `period_end`, `row_count` | The `Export` model already existed and is EXTENDED. A second model would have been a second door onto one resource with one policy. |
| `otp_sessions.business_id` nullable + `practice_id` + `otp_sessions_tenant_anchor` | `OtpSessionScope.ONBOARDING` was declared and unusable: a pre-client session had nowhere to live. See the RLS note below — this one had a trap in it. |
| `document_links` (new) | The D43 capability URL. See below. |
| `practices.document_link_ttl_days` | D43's "expiry configurable per practice". |
| `ExportTarget`, `SubscriptionStatus` (new enums) | Both mirrored into `check-contract.mjs`, so drift fails the build. |

### ⚠ A nullable anchor under a policy written for a NOT NULL one — twice now

`otp_sessions` was in the `direct_tables` loop, whose predicate is
`app_can_access_business(business_id)`. That function returns **FALSE** for a
NULL argument, so the moment `business_id` became nullable an ONBOARDING row
would have been **invisible and unwritable to everyone, forever, with nothing
reporting it**.

This is the #104 bug in reverse. There, a NULL-business `action_proposal` was
world-readable and world-writable; here a NULL-business session would have been
nobody-readable. **Same mistake, opposite direction:** a nullable tenant anchor
left under a policy written for a NOT NULL column. If a third table's anchor
ever becomes nullable, it leaves `direct_tables` in the same commit or the same
class of bug ships again.

The fix is the shape `documents` and `action_proposals` already use:
`app_can_access_document(business_id, practice_id)` — the anchor-pair predicate,
preferred over the `invites`/`guidance` spelling because it carries the
`session_scope = 'user'` guard those two only get inside their business branch.
Section 10 of `tenancy-check.sql` is the regression, and it was **negative
tested**: restored against the old single-column policy, the ONBOARDING row
reads 0 rows instead of 1.

### `document_links`, and the one sanctioned RLS bypass

`GET /d/{code}` is unauthenticated **by design** — an accountant reads the code
out of a column inside VT Transaction+, where no session of ours can exist. That
creates a real ordering problem: to resolve a code we need the row, to read the
row under RLS we need a practice-scoped actor, and the practice is what the row
would have told us.

The table is therefore **policed like any other business-anchored table**, and
one narrow `SECURITY DEFINER` function — `app_resolve_document_link(code)` —
takes a code and returns at most one row of four ids plus two state booleans.
It reads no financial data and cannot return more than one row (`code` is
UNIQUE). Everything after it goes back through
`scopedDb(systemContext(practiceId, systemUserId))` like any worker.

The two rejected alternatives are written into `rls.sql` above the function
rather than left to be re-litigated: an unpoliced table (makes a whole tenant
table readable by any path that forgets to think, to spare one caller), and a
third `capability_link` session scope (attractive — no bypass at all — but
`ScopeContext` requires an actorId AND a practice-or-business, and a capability
read has none of the three; relaxing those refinements weakens a shared guard
for every caller to serve one route).

**`code` is stored in plain text, and that is deliberate** — the only token in
this schema that is. Every other one is hashed because nothing needs to read it
back; this one must re-emit identically next month, or the accountant's saved VT
conversion table stops matching and every import goes manual again (§24.3.1
calls that byte-stability the highest-leverage detail in the export). A hash
cannot be re-emitted. Its safety is being unguessable and rate-limited, not
being secret at rest.

**Not `@@unique([documentId])`**, deliberately: revocation must actually break
the links already sitting in someone's ledger, so revoking mints nothing and a
replacement is a new row with a new code.

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
