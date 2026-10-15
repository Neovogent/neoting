-- rush/matching (15 Oct 2026) — SoT §4 Stage 7 matching extensions.
-- Additive only: two nullable columns, one nullable column, one new tenant
-- table with its RLS policy. Writes no data.

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "match_date_window_days" INTEGER,
ADD COLUMN     "match_lookback_days" INTEGER;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "allocated_pence" INTEGER;

-- CreateTable
CREATE TABLE "period_locks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_user_id" TEXT,
    "action_proposal_id" TEXT,

    CONSTRAINT "period_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "period_locks_business_id_period_start_key" ON "period_locks"("business_id", "period_start");

-- AddForeignKey
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: a single non-null business_id, so the direct_tables predicate is exact
-- (prisma/sql/rls.sql carries the same entry in both loops).
ALTER TABLE "period_locks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "period_locks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS period_locks_tenant ON period_locks;
CREATE POLICY period_locks_tenant ON period_locks
  USING (app_can_access_business(business_id))
  WITH CHECK (app_can_access_business(business_id));
