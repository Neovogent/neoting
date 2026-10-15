-- rush/reports — manual journals and opening balances (15 Oct 2026).
-- Additive: one new table, writes no data. Written only by the approved
-- `journal.post` proposal executor.

-- CreateTable
CREATE TABLE "manual_journals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "journal_date" TIMESTAMP(3) NOT NULL,
    "journal_kind" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "action_proposal_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_journals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manual_journals_action_proposal_id_key" ON "manual_journals"("action_proposal_id");

-- CreateIndex
CREATE INDEX "manual_journals_business_id_journal_date_idx" ON "manual_journals"("business_id", "journal_date");

-- RLS: a single NOT NULL business_id, so the `direct_tables` predicate from
-- prisma/sql/rls.sql applies verbatim (the table is also added to that list).
ALTER TABLE "manual_journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_journals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS manual_journals_tenant ON manual_journals;
CREATE POLICY manual_journals_tenant ON manual_journals
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));
