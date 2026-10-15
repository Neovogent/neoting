-- rush/chase-detection — persisted detection findings + per-client chase
-- suppression (SoT §4 Stages 7 and 8). ADDITIVE ONLY: two new tables and one
-- enum, no existing table touched, no data written. Reversible in two DROP
-- TABLEs and one DROP TYPE.

-- CreateEnum
CREATE TYPE "MissingEvidenceState" AS ENUM ('OPEN', 'RESOLVED', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "missing_evidence" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "engine" "ChaseDetectionEngine" NOT NULL,
    "ref_key" TEXT NOT NULL,
    "transaction_id" TEXT,
    "supplier_statement_line_id" TEXT,
    "external_ref" TEXT,
    "supplier_name" TEXT,
    "amount_pence" INTEGER,
    "occurred_at" TIMESTAMP(3),
    "period" TEXT,
    "description" TEXT,
    "state" "MissingEvidenceState" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "resolved_reason" TEXT,
    "resolved_by_document_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missing_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chase_suppression_settings" (
    "business_id" TEXT NOT NULL,
    "keywords" TEXT[],
    "no_receipt_suppliers" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chase_suppression_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateIndex
CREATE INDEX "missing_evidence_business_id_state_idx" ON "missing_evidence"("business_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "missing_evidence_business_id_engine_ref_key_key" ON "missing_evidence"("business_id", "engine", "ref_key");

-- AddForeignKey
ALTER TABLE "missing_evidence" ADD CONSTRAINT "missing_evidence_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chase_suppression_settings" ADD CONSTRAINT "chase_suppression_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security. Both tables carry a NOT NULL `business_id`, so the
-- `direct_tables` predicate in prisma/sql/rls.sql is exactly right (they are
-- added to that file's lists too, so a full replay keeps them).
ALTER TABLE "missing_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "missing_evidence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS missing_evidence_tenant ON missing_evidence;
CREATE POLICY missing_evidence_tenant ON missing_evidence
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));

ALTER TABLE "chase_suppression_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chase_suppression_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chase_suppression_settings_tenant ON chase_suppression_settings;
CREATE POLICY chase_suppression_settings_tenant ON chase_suppression_settings
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));
