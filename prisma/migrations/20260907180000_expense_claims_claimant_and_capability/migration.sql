-- Expense claims — the claimant, the capability and the creditor account
-- (review item 50, 7 Sep 2026; design: docs/Expense_Claims_Design.md).
--
-- ADDITIVE ONLY: three columns and one foreign key. No existing column is
-- altered, no row is written, and nothing is dropped. Reversible by dropping
-- the constraint and the three columns.
--
-- ⚠ THE TWO DEFAULTS POINT IN OPPOSITE DIRECTIONS, AND THAT IS THE POINT.
-- `can_send_documents` and `can_see_totals` both default TRUE because they
-- describe what every contact could already do, so a migration that defaulted
-- them false would remove a permission on deploy. `can_submit_expense_claims`
-- defaults **FALSE** because it grants a power nobody has today — the power to
-- oblige the company to pay somebody — and handing that to every contact row
-- in the database on deploy would be the same mistake pointing the other way.
--
-- ⚠ `claimant_contact_id` is ON DELETE RESTRICT, not SET NULL. Nulling it
-- would silently erase the fact that the company owes a named person for a
-- receipt, at the moment somebody is removed. Portal people are only ever
-- SOFT-deleted (`deactivated_at`), so this costs nothing today and makes any
-- future hard-delete path fail loudly instead of quietly destroying a creditor.

-- AlterTable: the client's own roster
ALTER TABLE "contacts"
  ADD COLUMN "can_submit_expense_claims" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "expense_creditor_account" TEXT;

-- AlterTable: who paid for this out of their own pocket. NULL is the ordinary
-- case and means "the company paid" — it is not "unknown".
ALTER TABLE "documents"
  ADD COLUMN "claimant_contact_id" TEXT;

-- Index before the constraint: the claims list selects on it per business, and
-- an unindexed FK also makes the RESTRICT check a sequential scan on delete.
CREATE INDEX "documents_claimant_contact_id_idx" ON "documents"("claimant_contact_id");

-- AddForeignKey
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_claimant_contact_id_fkey"
  FOREIGN KEY ("claimant_contact_id") REFERENCES "contacts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
