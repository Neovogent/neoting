-- Soft delete for documents — the Trash the Documents tab has never had.
--
-- ⚠ WHY A TIMESTAMP AND NOT A `DocumentState` MEMBER.
--
-- "Deleted" looks like a ninth state and is not one. `DocumentState` is a TOTAL
-- domain in three places that would break silently rather than loudly:
--
--   * `apps/api/src/modules/portal/portal-document-status.ts` maps every member
--     onto one of the five words a CLIENT is shown. It is deliberately total —
--     the file says so — so a new member is a compile error there and, once
--     someone silences it, a new word in the client-facing vocabulary. A client
--     must never be told their receipt is "deleted"; a deleted document is
--     simply not theirs to see any more.
--   * `validation-dedupe/document-state.ts` holds `LEGAL_TRANSITIONS` as a total
--     record over the 8x8 matrix. A ninth member means 17 new edges to decide,
--     none of which is a real pipeline transition.
--   * `packages/contracts/openapi.yaml`'s `DocumentState` enum is checked
--     against THIS file verbatim by `check-contract.mjs`, so the member would
--     also become part of the public API's state vocabulary.
--
-- Deleting is orthogonal to where a document is in the pipeline: a READY
-- document that is deleted and restored is READY again, and the state column is
-- what remembers that. A state member would have had to destroy the answer in
-- order to record the question. `archived_at` already sits beside `state` for a
-- related-but-different reason, so the shape has a precedent in this table.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY AGAINST EXISTING ROWS — this migration writes NO data.
--
-- One nullable column and one plain index. Every existing row keeps NULL, which
-- is exactly "not deleted", so the default listing predicate
-- (`deleted_at IS NULL`) admits every row that is visible today and the
-- behaviour of the product is unchanged the moment this lands. There is no
-- UPDATE, no DELETE, no NOT NULL, no DEFAULT that would rewrite the table, and
-- no column is dropped or renamed. It is therefore safe to run against the local
-- database holding real client data pulled from staging, and against staging.
--
-- Expand-contract (Governance §5.3): this is the EXPAND step and there is no
-- contract step owed, because nothing is being replaced. Reversing it is one
-- `ALTER TABLE ... DROP COLUMN`, and reversing it after rows have been deleted
-- would restore those documents to their queues rather than lose anything.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No RLS change. `documents` is already in the policed set with FORCE ROW LEVEL
-- SECURITY, and a policy is written over the ROW, not over its columns — the
-- existing `documents_tenant` / `documents_delegated_upload` policies decide
-- visibility for this column exactly as they do for every other. Deletion is a
-- product predicate applied on top of what RLS already narrowed to, never a
-- tenancy boundary; `apps/api/src/common/documents/deleted-documents.ts` is the
-- one place it is spelled.

-- `TIMESTAMP(3)` and not `TIMESTAMPTZ`, deliberately, and it is not a weaker
-- choice here: every timestamp in this schema is `TIMESTAMP(3)` (Prisma's
-- mapping for `DateTime`), the repository rule is UTC in storage with
-- Europe/London applied only at render, and `archived_at` — the column this one
-- is modelled on, two lines above it — is `TIMESTAMP(3)`. A lone `TIMESTAMPTZ`
-- would ALSO be permanent drift: `prisma migrate diff` reports it as an altered
-- column on every future run, so every later migration in this repository would
-- open with a spurious ALTER nobody asked for.
ALTER TABLE "documents"
  ADD COLUMN "deleted_at" TIMESTAMP(3);

COMMENT ON COLUMN "documents"."deleted_at" IS
  'When a person moved this document to Trash. NULL means not deleted, which is the default listing predicate everywhere. Reversible: POST /v1/documents/{id}/restoration clears it. Permanent removal is a document.purge ActionProposal, which refuses a PUBLISHED document or one that appears in any export (D43).';

-- Ships in the same migration as the query pattern that needs it (Governance,
-- expand-contract): `GET /v1/documents?deleted=true` is
-- `WHERE business_id = $1 AND deleted_at IS NOT NULL`, and none of the five
-- existing indexes on this table can serve it — every one of them leads with
-- `business_id` followed by a pipeline column, so a Trash listing would fall
-- back to scanning everything the business owns.
--
-- NOT a partial index `WHERE deleted_at IS NOT NULL`, even though Trash is the
-- only query that reads the column and a partial index would be a fraction of
-- the size: Prisma's `@@index` cannot express a predicate, so a hand-written
-- partial index drifts out of `schema.prisma` and the next `migrate diff`
-- proposes dropping it. The same reasoning is recorded on
-- `bank_transactions_account_id_import_fingerprint_key`.
CREATE INDEX "documents_business_id_deleted_at_idx"
  ON "documents" ("business_id", "deleted_at");
