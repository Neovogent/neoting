-- Two offboarding stamps on `businesses` — review item 67, owner-ruled 7 Sep 2026.
--
-- Removing a client already worked and was already soft: `business.offboard`
-- flips `is_active` off and nothing is destroyed (D12 holds the books for six
-- years). What it could not do was say anything about the moment, or about what
-- the practice intends to happen to the data afterwards, and both are now
-- product-visible:
--
--   * the **Removed clients** panel offers one-click Restore for a stated
--     window, and a window has to be counted from something;
--   * the **mark-for-erasure** offboard scope records that the practice wants
--     this client's data erased once the statutory duty lapses.
--
-- ⚠ `erasure_requested_at` IS A FLAG, NOT A TIMER, AND NOTHING READS IT ON A
-- SCHEDULE. The owner ruled *erasure on request, no automatic date* (7 Sep
-- 2026): any fixed window shorter than D12's six years would be this product
-- deleting a UK practice's statutory records out from under their legal duty,
-- on a timer nobody watched. The column exists so a later, deliberate, audited
-- erasure surface can find the clients that asked; the copy on screen says
-- "marked", never "scheduled". Do not add a sweep over this column without a
-- fresh ruling — `docs/Retention_and_Deletion_Policy.md` is where that ruling
-- would have to be written down first.
--
-- Why a timestamp and not a boolean, for both: "when" is the question every
-- reader of these columns actually has (how long has this client been gone;
-- when did the practice ask for erasure), a boolean answers neither, and a
-- NULL/NOT NULL predicate reads identically to the boolean one it replaces.
-- `documents.deleted_at` is the same shape one table over, for the same reason.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY AGAINST EXISTING ROWS — this migration writes NO data.
--
-- Two nullable columns and nothing else. Every existing row keeps NULL: a live
-- workspace has no offboarding moment and has asked for no erasure, and an
-- ALREADY-offboarded workspace (there may be some, `business.offboard` has
-- shipped) keeps NULL too, which the Removed clients panel reads as "removal
-- date unknown" and renders as a restore offer with no countdown — the honest
-- answer, and better than back-dating a moment nobody recorded. There is no
-- UPDATE, no DELETE, no NOT NULL, no DEFAULT that would rewrite the table, no
-- column dropped or renamed. Safe against the local database holding real
-- client data pulled from staging, and against staging.
--
-- Expand-contract (Governance §5.3): this is the EXPAND step and no contract
-- step is owed, because nothing is being replaced. Reversing it is two
-- `ALTER TABLE ... DROP COLUMN` and costs only the countdown on the panel.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No RLS change and no new index. `businesses` is already in the policed set
-- with FORCE ROW LEVEL SECURITY, and a policy is written over the ROW rather
-- than over its columns, so `businesses_tenant` decides visibility for these
-- two exactly as it does for every other. The Removed clients listing is
-- `WHERE practice_id = $1 AND is_active = false`, which the existing
-- `businesses_practice_id_is_active_idx` already serves — the new columns are
-- projected, never filtered on.
--
-- `TIMESTAMP(3)` and not `TIMESTAMPTZ`: every timestamp in this schema is
-- `TIMESTAMP(3)` (Prisma's mapping for `DateTime`), storage is UTC with
-- Europe/London applied only at render, and a lone `TIMESTAMPTZ` would be
-- permanent drift — `prisma migrate diff` would report it as an altered column
-- in every later migration in this repository. The same argument is recorded on
-- `documents.deleted_at`.
ALTER TABLE "businesses"
  ADD COLUMN "offboarded_at" TIMESTAMP(3),
  ADD COLUMN "erasure_requested_at" TIMESTAMP(3);

COMMENT ON COLUMN "businesses"."offboarded_at" IS
  'When business.offboard deactivated this workspace. NULL for a live one, and business.reactivate clears it back to NULL so a client removed twice counts from the second removal. The Removed clients panel counts its one-click restore window from here; nothing is erased when that window lapses, the client simply stops being offered for restore.';

COMMENT ON COLUMN "businesses"."erasure_requested_at" IS
  'When the practice asked, via the mark-for-erasure offboard scope, that this client data be erased once the statutory retention duty lapses. A FLAG, NOT A TIMER: no sweep reads this column and no erasure happens on a schedule (owner ruling, 7 Sep 2026 — erasure on request, no automatic date, because any window shorter than D12 six years would breach the practice statutory duty). Cleared by business.reactivate.';
