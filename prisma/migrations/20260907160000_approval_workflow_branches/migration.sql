-- Approval workflows become a real, persisted surface (review package H,
-- items 51/52/53). The table has existed since the init migration with NO
-- operations and no service behind it: the Workflows tab composed, saved and
-- toggled policies entirely in browser state, so every workflow an accountant
-- wrote died on reload.
--
-- Three changes, all additive except the default flip, which is explained
-- below.

-- 1. Conditional branches get their own column. They were browser-only —
--    "+ Add branch" pushed a hardcoded object into React state and there was
--    nowhere for a branch to be stored even in principle (item 53).
ALTER TABLE "approval_workflows" ADD COLUMN "branches" JSONB;

-- 2. Self-approval was a toggle in the editor with no column under it.
ALTER TABLE "approval_workflows" ADD COLUMN "self_approval" BOOLEAN NOT NULL DEFAULT false;

-- 3. ⚠ `is_active` now defaults to FALSE.
--
--    A saved workflow is a DRAFT. Arming one decides what pauses for other
--    people's approvals, which is a state change on the approval spine itself,
--    so it goes through the `policy.activate` proposal → Review → Approve
--    (Governance §10, D44). A default of TRUE meant a row armed itself the
--    moment it was written, with nobody having approved the gate.
--
--    Safe to change here: no application code has ever written this table —
--    only `prisma/seed.ts`, which sets the flag explicitly from this commit on.
ALTER TABLE "approval_workflows" ALTER COLUMN "is_active" SET DEFAULT false;
