-- rush/admin — per-practice feature-flag overrides. Additive: one new table,
-- writes no data, touches no existing table.

-- CreateTable
CREATE TABLE "feature_flag_overrides" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "flag_key" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_flag_overrides_flag_key_idx" ON "feature_flag_overrides"("flag_key");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_overrides_practice_id_flag_key_key" ON "feature_flag_overrides"("practice_id", "flag_key");

-- RLS: a practice-anchored table with no business — the `teams` shape. The
-- anchor-pair predicate carries the `session_scope = 'user'` guard, so a
-- delegated portal session reads nothing; a practice's own (or its SYSTEM
-- actor's) context reads and writes only its own rows.
ALTER TABLE "feature_flag_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_overrides" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feature_flag_overrides_tenant ON feature_flag_overrides;
CREATE POLICY feature_flag_overrides_tenant ON feature_flag_overrides
  USING (app_can_access_document(NULL::text, practice_id))
  WITH CHECK (app_can_access_document(NULL::text, practice_id));
