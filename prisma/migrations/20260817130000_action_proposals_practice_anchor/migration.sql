-- Issue #104: action_proposals rows with NULL business_id were world-readable
-- and world-writable.
--
-- The old policy was
--
--   USING (business_id IS NULL OR app_can_access_business(business_id))
--
-- and ActionProposal had no practice column — so a NULL-business row satisfied
-- both policy halves unconditionally, for every actor on the platform. That is
-- not a corner: a `document.route` proposal is about an UNROUTED document,
-- which by definition has no business, so NULL business is the DEFAULT for the
-- highest-value proposal kind in the set (#81).
--
-- The fix mirrors the documents pattern exactly: a practice anchor column, an
-- at-least-one CHECK, and the same two-branch predicate documents use.
-- Expand order inside one migration: column → backfill → constraint → policy,
-- so the CHECK never sees a row the backfill has not visited.

-- 1. The anchor column. Cascade matches business_id's own delete behaviour on
--    this table: a proposal belongs to its tenant and goes with it.
ALTER TABLE "action_proposals" ADD COLUMN "practice_id" TEXT;

ALTER TABLE "action_proposals"
  ADD CONSTRAINT "action_proposals_practice_id_fkey"
  FOREIGN KEY ("practice_id") REFERENCES "practices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The practice-scoped queue read S1 will make ("proposals awaiting my
-- practice's review"), shipped with the column per Governance §5.1.
CREATE INDEX "action_proposals_practice_id_state_idx"
  ON "action_proposals"("practice_id", "state");

-- 2. Backfill from the business's own practice. A standalone business has a
--    NULL practice — those rows keep their business anchor, which is enough.
--
--    The guard trigger must stand aside for this one statement: it makes an
--    EXECUTED proposal immutable to the application (Governance §10.4 —
--    verified live: the seed's executed proposal refused this backfill), but a
--    schema backfill of a new tenancy column is not a state change, and the
--    migration role is the one actor allowed to say so. Same discipline as
--    the tenancy harness disabling the audit trigger to remove its own probe.
ALTER TABLE "action_proposals" DISABLE TRIGGER action_proposals_guard_trigger;
UPDATE "action_proposals" ap
  SET "practice_id" = b."practice_id"
  FROM "businesses" b
  WHERE ap."business_id" = b."id" AND ap."practice_id" IS NULL;
ALTER TABLE "action_proposals" ENABLE TRIGGER action_proposals_guard_trigger;

-- 3. AT LEAST ONE anchor — an OR, exactly like documents_tenant_anchor and for
--    the same reason (both-set is normal; see PR #103). A row with neither
--    would be owned by nobody and visible to nobody — or, under the old
--    policy, visible to EVERYBODY, which is how this issue exists.
--    If this ALTER fails, the environment holds an unanchored proposal that
--    the backfill could not resolve; that row must be examined by a human, not
--    silently adopted.
ALTER TABLE "action_proposals"
  ADD CONSTRAINT "action_proposals_tenant_anchor"
  CHECK ("practice_id" IS NOT NULL OR "business_id" IS NOT NULL);

-- 4. The policy. `app_can_access_document(business, practice)` is the
--    anchor-pair predicate despite its name: business branch first, else a
--    NULL-business row is visible only to `user`-scope actors of its own
--    practice. Reused rather than restated so the rule keeps living in exactly
--    one place (rls.sql's own discipline).
DROP POLICY IF EXISTS action_proposals_tenant ON action_proposals;
CREATE POLICY action_proposals_tenant ON action_proposals
  USING (app_can_access_document(business_id, practice_id))
  WITH CHECK (app_can_access_document(business_id, practice_id));
