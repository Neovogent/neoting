-- Practice team-member invitations. Additive throughout: two nullable-or-
-- defaulted columns and one index. No policy changes — `invites_tenant`
-- already admits a practice-level row (`business_id IS NULL AND practice_id =
-- app_practice_id()`), which is exactly the shape a colleague invitation has,
-- so per-client scoping for an invited PRACTICE_STANDARD is enforced by the
-- policies that already exist rather than by anything added here.

-- Carried from the invitation onto the membership acceptance creates
-- (SoT §3.3). NOT NULL with a default, so every existing row answers `false`
-- without a backfill pass.
ALTER TABLE "invites"
  ADD COLUMN "hide_financial_fields" BOOLEAN NOT NULL DEFAULT false;

-- The clients an invited PRACTICE_STANDARD is scoped to, carried from the
-- invitation onto the memberships acceptance creates. An array rather than N
-- invitation rows: one decision, one email, one token — and `token_hash` is
-- UNIQUE, so N rows would need N tokens. Empty means practice-wide.
ALTER TABLE "invites"
  ADD COLUMN "business_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Who sent it, so the acceptance screen can name a person rather than an
-- anonymous "someone". Nullable: rows predating this column have no answer,
-- and inventing one would put a name on a screen nobody typed.
ALTER TABLE "invites"
  ADD COLUMN "invited_by_user_id" TEXT;

-- ON DELETE SET NULL, deliberately, and not CASCADE: an invitation belongs to
-- the practice, not to the colleague who happened to send it. Cascading would
-- silently withdraw every outstanding invitation the moment an admin was
-- removed — invisible to the people holding the links, who would simply find
-- them stop working.
ALTER TABLE "invites"
  ADD CONSTRAINT "invites_invited_by_user_id_fkey"
  FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The practice team list filters on practice_id, and `invites_tenant`'s
-- practice branch compares it on every row it polices. `invites_business_id_idx`
-- covers only the client-invite half.
--
-- ⚠ NOT a UNIQUE index on (practice_id, email). `team.service.ts` documents a
-- create-if-absent pattern that assumes re-inviting an address is legal, and it
-- is: an invitation nobody opened must be re-sendable without an admin first
-- finding and deleting the old row.
CREATE INDEX "invites_practice_id_idx" ON "invites" ("practice_id");
