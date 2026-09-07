/**
 * The retention window — **one number, stated once, for the whole of package L**
 * (review items 61 + 67; owner-ruled in session, 7 Sep 2026).
 *
 * ## Why it lives in the contract package and not in `apps/api`
 *
 * Three things have to agree about this figure or the product lies to somebody:
 *
 * 1. the sweep that actually purges (`scripts/purge-expired-trash.ts`);
 * 2. the confirmation an accountant reads *before* deleting anything, and the
 *    Trash view they read it in again afterwards (`apps/web`);
 * 3. the Removed clients panel's restore countdown (`apps/web`).
 *
 * (1) is server-side and (2)/(3) are browser-side, so there is no module either
 * could import from the other. Two constants that must be equal and cannot see
 * each other is precisely the failure `common/documents/deleted-documents.ts`
 * exists to argue against one table over — *"a list filter and a count that
 * encode the same exclusion in two places will eventually disagree, and the more
 * permissive of the two wins on the day it matters"*. Here the disagreement is
 * worse than permissive: the screen would promise thirty days while the sweep
 * took seven, and nobody would find out until a document an accountant expected
 * to still be there was gone.
 *
 * `@neoting/contracts` is the one package both sides already depend on, and the
 * barrel's own rule is that it carries what both sides share with no React and
 * no MSW dependency. A plain integer qualifies. It is NOT a generated artefact —
 * do not look for it in `openapi.yaml`; no endpoint returns it, because nothing
 * asks the server what its own policy is.
 *
 * ## The number, and what it does and does not promise
 *
 * **Thirty days**, ruled by the owner on 7 Sep 2026 over 7 and 90: it is the
 * window an accountant already recognises from every operating system, Google
 * Drive and Dropbox, so it needs no explaining, and it is long enough that a
 * mistaken bulk delete is still recoverable at the next month-end pass.
 *
 * It governs **two** things, deliberately the same figure for both (the owner
 * chose one number for package L rather than two that would drift):
 *
 * - a **document** in Trash is purged for good this many days after it was
 *   deleted — **unless it is protected**, and then it is held for good. D43's
 *   refusal (`NT-DOC-002`) is unchanged and unchangeable by any window: a
 *   document that has been released for export, that carries a capability link,
 *   or that a bank or supplier statement names, is never purged by anything —
 *   not the sweep, not a super admin. So the honest sentence is always two
 *   clauses, and every surface says both.
 * - a **removed client** stops being offered for one-click Restore this many
 *   days after `business.offboard` executed. ⚠ **Nothing is erased when that
 *   lapses.** The books stay under D12's six-year clock and the workspace stays
 *   reachable by id; only the Restore affordance goes. Do not let any surface
 *   describe this half as a deletion.
 *
 * ## ⚠ It is not a licence to erase
 *
 * The third offboard scope is `mark-for-erasure`, and it has **no window at
 * all** — the owner ruled *erasure on request, no automatic date*, because any
 * fixed period shorter than D12's six years would be this product deleting a UK
 * practice's statutory records out from under their legal duty, on a timer
 * nobody watched. Nothing in this codebase may read
 * `businesses.erasure_requested_at` and act on it on a schedule.
 *
 * The full policy, with the rulings recorded and dated, is
 * `docs/Retention_and_Deletion_Policy.md`. Change the number there and here in
 * the same commit, or the document is fiction.
 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * What an automated purge records itself as having run under.
 *
 * Governance §10.5 permits a standing automation to execute without a
 * per-item proposal *"only under a policy that was itself approved through this
 * contract"*, and requires that **"automated executions record the policy ID
 * they ran under"**. This is that id.
 *
 * The policy is a **platform term, not a per-practice toggle** — no practice
 * turns it on, off, or to a different number — which is what makes a constant
 * the right shape for it rather than a row somebody approves. Its approval is
 * the owner's recorded ruling, its text is the policy document, and its
 * consent is that every accountant is told the window in the confirmation
 * dialog *before* a document is deleted and again in the Trash view. The
 * version suffix moves when the window or the exemptions move, so an audit row
 * written a year ago still names the policy that was actually in force when it
 * ran.
 */
export const TRASH_RETENTION_POLICY_ID = 'retention/trash@2026-09-07';
