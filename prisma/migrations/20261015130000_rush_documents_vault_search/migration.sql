-- rush/documents: practice Document Vault (SoT §10) fields + full-text search.
--
-- Additive only. No new tables, so no new RLS: `vault_items` and `documents`
-- are already FORCE ROW LEVEL SECURITY with their existing policies, and the
-- search endpoint queries them inside scopedDb, so RLS narrows every match.
--
-- The two `search_vector` columns are GENERATED ALWAYS ... STORED. Prisma sees
-- them as `Unsupported("tsvector")?` and never writes them. Prisma's own diff
-- emits a plain `tsvector` column; the generation expression is hand-written
-- here. Only IMMUTABLE functions are allowed in a generated column, which is
-- why `tags` (array_to_string is STABLE) is not in the vault vector — tags are
-- a filter, not search text.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("supplier_name", '') || ' ' || coalesce("customer_name", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("reference", '') || ' ' || coalesce("original_filename", '')), 'B') ||
  setweight(to_tsvector('english', coalesce("description", '') || ' ' || coalesce("category_code", '') || ' ' || coalesce("project_ref", '')), 'C')
) STORED;

-- AlterTable
ALTER TABLE "vault_items" ADD COLUMN     "ai_state" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "expiry_notice" TEXT,
ADD COLUMN     "extracted_text" TEXT,
ADD COLUMN     "financial_year" TEXT,
ADD COLUMN     "source_document_id" TEXT;

ALTER TABLE "vault_items" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '') || ' ' || coalesce("filename", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("summary", '') || ' ' || coalesce("category", '') || ' ' || coalesce("financial_year", '')), 'B') ||
  setweight(to_tsvector('english', coalesce("extracted_text", '')), 'C')
) STORED;

-- CreateIndex
CREATE INDEX "documents_search_vector_idx" ON "documents" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "vault_items_search_vector_idx" ON "vault_items" USING GIN ("search_vector");
