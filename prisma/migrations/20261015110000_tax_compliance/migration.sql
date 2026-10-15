-- rush/tax-compliance — VAT number checks, the obligation (deadline) calendar,
-- and the per-practice capitalisation threshold.
--
-- ADDITIVE ONLY: two nullable columns, two new tables, three new enums. No data
-- written, nothing dropped or renamed.
--
-- Both new tables carry a NOT NULL business_id, so they take the direct_tables
-- policy shape (app_can_access_business(business_id)), written out at the
-- bottom — the same statements prisma/sql/rls.sql now carries for them.

-- CreateEnum
CREATE TYPE "ObligationKind" AS ENUM ('VAT_RETURN', 'PAYE', 'SA_PAYMENT', 'SA_REGISTRATION', 'CT_PAYMENT', 'CT600', 'CH_ACCOUNTS', 'CH_CONFIRMATION', 'MANUAL');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('UPCOMING', 'DUE', 'OVERDUE', 'DONE');

-- CreateEnum
CREATE TYPE "ObligationSource" AS ENUM ('COMPUTED', 'MANUAL');

-- AlterTable
ALTER TABLE "practices" ADD COLUMN     "capitalisation_threshold_pence" INTEGER;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "supplier_vat_check" JSONB;

-- CreateTable
CREATE TABLE "tax_profiles" (
    "business_id" TEXT NOT NULL,
    "incorporated_on" DATE,
    "has_employees" BOOLEAN,
    "accounts_next_due" DATE,
    "confirmation_statement_next_due" DATE,
    "sic_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "company_status" TEXT,
    "vat_number_check" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_profiles_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "obligations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "practice_id" TEXT,
    "kind" "ObligationKind" NOT NULL,
    "source" "ObligationSource" NOT NULL,
    "title" TEXT NOT NULL,
    "compute_key" TEXT,
    "period_start" DATE,
    "period_end" DATE,
    "due_date" DATE NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'UPCOMING',
    "notes" TEXT,
    "done_at" TIMESTAMP(3),
    "done_by_user_id" TEXT,
    "notified_due_soon_at" TIMESTAMP(3),
    "notified_overdue_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "obligations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "obligations_business_id_due_date_idx" ON "obligations"("business_id", "due_date");

-- CreateIndex
CREATE INDEX "obligations_practice_id_due_date_idx" ON "obligations"("practice_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "obligations_business_id_compute_key_key" ON "obligations"("business_id", "compute_key");

-- AddForeignKey
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (Governance §5.2) ------------------------------------------------------
ALTER TABLE "tax_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tax_profiles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tax_profiles_tenant ON tax_profiles;
CREATE POLICY tax_profiles_tenant ON tax_profiles
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));

ALTER TABLE "obligations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "obligations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS obligations_tenant ON obligations;
CREATE POLICY obligations_tenant ON obligations
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));
