-- A real unique identity for a bank line that came out of an UPLOADED file.
--
-- ⚠ WHY: a real client held 2,288 `bank_transactions` that were 1,144 rows
-- imported TWICE — identical booked_at, amount_pence, description_raw and
-- account_id — from two `statements` rows covering the same
-- 2025-08-01 → 2026-07-31 period, created nine seconds apart. Half of that
-- client's ledger was a duplicate and nothing in the product noticed.
--
-- `bank_transactions_account_id_provider_transaction_id_key` did not stop it
-- and could not: D40 makes manual statement upload the ONLY bank input, so
-- there IS no provider and every statement-derived row carries
-- provider_transaction_id IS NULL. Postgres treats NULLs as DISTINCT in a
-- plain unique index, so that constraint is not weak for this lane — it is
-- entirely inert, and admits unlimited copies of the same line.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY AGAINST EXISTING ROWS — this migration writes NO data.
--
-- It adds a nullable column and one unique index. Every existing row keeps
-- NULL, and a plain unique index treats NULLs as distinct, so the index cannot
-- collide with anything already stored however duplicated that data is. There
-- is no UPDATE, no DELETE, no NOT NULL, no rewrite of an existing value, and no
-- default that would rewrite the table. It is therefore safe to run against the
-- local database holding real client data and against staging.
--
-- Backfilling the identities of rows that predate this is a SEPARATE, idempotent
-- and reversible pass — `apps/api/src/db/backfill-import-fingerprints.ts` — run
-- deliberately, not by the schema. Doing it in SQL would require re-implementing
-- the normalisation and the hash of
-- `banking-matching/statement-ingest/row-identity.ts` in a second language, and
-- the two would eventually disagree about what a line's identity is, which is
-- the one thing that must never happen.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No RLS change: `bank_transactions` is already in the policed set and a policy
-- is written over the row, not over its columns.

ALTER TABLE "bank_transactions"
  ADD COLUMN "import_fingerprint" TEXT;

COMMENT ON COLUMN "bank_transactions"."import_fingerprint" IS
  'Content-derived identity of a line imported from an uploaded file (D40): sha256 over account + booked date + currency + signed pence + normalised description + the occurrence ordinal of that tuple WITHIN its own source file. The ordinal is what keeps two genuinely identical purchases as two rows while making the same line, imported twice, collide. NULL for a feed row, which carries a real provider_transaction_id instead.';

-- Scoped to the account, exactly like the provider one — and unlike the
-- provider one, actually populated for the lane that needs it.
--
-- NOT a partial index `WHERE import_fingerprint IS NOT NULL`: a plain unique
-- index already leaves NULL rows unconstrained (NULLs are distinct), Prisma's
-- `@@unique` cannot express a predicate, and a hand-written partial index would
-- drift out of `schema.prisma` on the next `migrate diff`.
CREATE UNIQUE INDEX "bank_transactions_account_id_import_fingerprint_key"
  ON "bank_transactions" ("account_id", "import_fingerprint");
