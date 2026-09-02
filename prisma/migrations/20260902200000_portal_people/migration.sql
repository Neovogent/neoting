-- The business's own people (D45, 2 Sep 2026)
--
-- A client business manages its own staff from its own portal. Four additive
-- columns on `contacts` and one index. NO policy change: `contacts_tenant`
-- already admits its own tenant, and the portal reads under the practice SYSTEM
-- context with an explicit `business_id` — the same shape `GET /portal/documents`
-- already uses.
--
-- ⚠ THIS MIGRATION WRITES NO DATA, and that is the safety argument in full.
-- `portal_role` is nullable with no default and no backfill: the effective
-- authority is derived as `portal_role ?? (is_primary ? BUSINESS_ADMIN :
-- BUSINESS_STANDARD)` in one place in the application, so every workspace that
-- already exists gets exactly one owner (the primary contact intake wrote) with
-- no UPDATE touching a database that holds real client records. A
-- `DEFAULT 'BUSINESS_STANDARD'` would have been the opposite — every existing
-- business with nobody able to manage anyone.
--
-- The two boolean defaults are `true` because both permissions are what every
-- existing contact already has: any contact of a business may sign in and upload
-- today (D45), and nothing hides totals from one. A column that silently removed
-- a permission on deploy would be a regression wearing a migration. New
-- invitations choose both explicitly.
--
-- Reversible in four `DROP COLUMN`s and one `DROP INDEX`; nothing is renamed and
-- nothing is dropped.

ALTER TABLE "contacts" ADD COLUMN "portal_role" "WorkspaceRole";
ALTER TABLE "contacts" ADD COLUMN "can_send_documents" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "contacts" ADD COLUMN "can_see_totals" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "contacts" ADD COLUMN "deactivated_at" TIMESTAMP(3);

-- The People list and the ingest sender map both ask for "this business's LIVE
-- contacts", so the index ships with the query pattern that needs it
-- (Governance §5.3, expand-contract).
CREATE INDEX "contacts_business_id_deactivated_at_idx" ON "contacts"("business_id", "deactivated_at");
