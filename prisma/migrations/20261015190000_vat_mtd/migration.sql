-- CreateTable
CREATE TABLE "vat_settings" (
    "business_id" TEXT NOT NULL,
    "vrn" TEXT,
    "scheme" TEXT NOT NULL DEFAULT 'STANDARD',
    "frequency" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "period_end_month" INTEGER NOT NULL DEFAULT 3,
    "flat_rate_basis_points" INTEGER,
    "hmrc_token_ref" TEXT,
    "hmrc_token_expires_at" TIMESTAMP(3),
    "hmrc_connected_at" TIMESTAMP(3),
    "hmrc_connected_by" TEXT,
    "hmrc_last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vat_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "vat_submissions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "vrn" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "boxes" JSONB NOT NULL,
    "processing_date" TIMESTAMP(3) NOT NULL,
    "form_bundle_number" TEXT NOT NULL,
    "charge_ref_number" TEXT,
    "payment_indicator" TEXT,
    "receipt" JSONB NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_adjustments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "box" INTEGER NOT NULL,
    "amount_pence" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vat_submissions_business_id_created_at_idx" ON "vat_submissions"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vat_submissions_business_id_period_key_key" ON "vat_submissions"("business_id", "period_key");

-- CreateIndex
CREATE INDEX "vat_adjustments_business_id_period_start_period_end_idx" ON "vat_adjustments"("business_id", "period_start", "period_end");

-- AddForeignKey
ALTER TABLE "vat_settings" ADD CONSTRAINT "vat_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_submissions" ADD CONSTRAINT "vat_submissions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_adjustments" ADD CONSTRAINT "vat_adjustments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── RLS (mirrors prisma/sql/rls.sql) ──────────────────────────────────────
ALTER TABLE "vat_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vat_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vat_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vat_adjustments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vat_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vat_submissions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vat_settings_tenant ON vat_settings;
CREATE POLICY vat_settings_tenant ON vat_settings
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));

DROP POLICY IF EXISTS vat_adjustments_tenant ON vat_adjustments;
CREATE POLICY vat_adjustments_tenant ON vat_adjustments
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));

-- Submitted returns are statutory records: read and insert only. No UPDATE or
-- DELETE policy exists, so both are denied; the trigger is belt and braces.
DROP POLICY IF EXISTS vat_submissions_read ON vat_submissions;
CREATE POLICY vat_submissions_read ON vat_submissions
  FOR SELECT USING (app_can_access_business(business_id));
DROP POLICY IF EXISTS vat_submissions_insert ON vat_submissions;
CREATE POLICY vat_submissions_insert ON vat_submissions
  FOR INSERT WITH CHECK (app_can_access_business(business_id));

CREATE OR REPLACE FUNCTION vat_submissions_immutable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'vat_submissions is immutable: an HMRC receipt is never edited';
END $$;

DROP TRIGGER IF EXISTS vat_submissions_no_update ON vat_submissions;
CREATE TRIGGER vat_submissions_no_update
  BEFORE UPDATE ON vat_submissions
  FOR EACH ROW EXECUTE FUNCTION vat_submissions_immutable();
