-- rush/chase-scheduler — the practice's chasing schedule (SoT §4 Stage 8
-- item 6). One additive table, writes no data. Written only by an approved
-- `policy.activate` proposal carrying `chasePolicy`; read by the worker's
-- reminder job. Practice-anchored with no business: the `teams` RLS shape.

-- CreateTable
CREATE TABLE "chase_policies" (
    "practice_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "first_reminder_days" INTEGER NOT NULL,
    "second_reminder_days" INTEGER NOT NULL,
    "escalate_after_days" INTEGER NOT NULL,
    "max_reminders" INTEGER NOT NULL,
    "quiet_hours_start" INTEGER NOT NULL,
    "quiet_hours_end" INTEGER NOT NULL,
    "action_proposal_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chase_policies_pkey" PRIMARY KEY ("practice_id")
);

-- RLS — mirrored in prisma/sql/rls.sql.
ALTER TABLE chase_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE chase_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chase_policies_tenant ON chase_policies;
CREATE POLICY chase_policies_tenant ON chase_policies
  USING (app_can_access_document(NULL::text, practice_id))
  WITH CHECK (app_can_access_document(NULL::text, practice_id));

-- `app-role.sql`'s default privileges cover tables created after it ran; this
-- covers an environment where nt_app already exists and the defaults were set
-- by a different owner. Guarded: `db:reset` creates nt_app AFTER migrating.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nt_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON chase_policies TO nt_app;
  END IF;
END $$;
