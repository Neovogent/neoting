/**
 * The public seam of approvals (Boundaries, `apps/api/CLAUDE.md`).
 *
 * **It exposes the AUTHORITY seam and nothing else** — no service, no Nest
 * module, no executor, no audit writer. That narrowness is the design, and each
 * omission has a reason:
 *
 * - **No `ApprovalsModule`.** `auth-tenancy/index.ts` records what happens when
 *   a seam exports a Nest module that drags a controller which imports back out
 *   of the composition root: boot dies with *"Cannot access 'X' before
 *   initialization"*. `app.module.ts` imports the module file directly, as it
 *   already does for every module here; composition roots are exempt from the
 *   seam rule.
 * - **No `ActionProposalsService`.** Creating a proposal from another module
 *   would be a second door onto the Review → Approve spine, which is the one
 *   thing this module exists to prevent (issue #81). The way in is
 *   `POST /v1/action-proposals`.
 * - **`appendAuditEvent` IS a member now (2 Sep 2026), and the TODO that blocked
 *   it is what unblocked it.** Both this file and `auth-tenancy/signup-audit.ts`
 *   recorded the same condition — *"collapse the two the day approvals grows a
 *   seam and `AuditEntry.proposalId` becomes nullable"* — and the second half
 *   landed with the client portal's People screen. A business managing its own
 *   staff must write to the practice's audit log (the accountant has to be able
 *   to see who their client added) and structurally cannot have a proposal to
 *   name: `createActionProposal` carries `workspaceSession` and a portal caller
 *   holds none. The choice was this export or a THIRD hand-rolled copy of
 *   `sha256(prev_hash + canonical_payload)`, and `signup-audit.ts` states what
 *   that costs: a chain whose links were computed two different ways cannot be
 *   verified at all.
 *
 *   ⚠ It is the WRITER only. Nothing about the append-only guarantee moves: the
 *   table has no UPDATE or DELETE policy and a trigger refuses both, so a
 *   consumer of this export can add to a chain and can never edit one.
 *   Collapsing `signup-audit.ts` onto it is still owed — that file writes the
 *   NULL-business chain unscoped, outside any tenant, which this signature
 *   (`ScopedClient`) does not admit.
 *
 * ## Why the seam exists at all
 *
 * `assert-can.ts` was written as *"the one door every irreversible outward act
 * goes through"*, with the argument stated in its header: a role check scattered
 * across the surfaces that OFFER a guarded act is a permission model with no
 * single place to read, and the more permissive of two copies wins on the day it
 * matters. That argument had one consumer inside this module, so it needed no
 * seam. `POST /v1/practice-members` is the second, and it is in
 * `clients-team-settings` — so the choice was a seam or a second opinion about
 * who may do what. This is the seam.
 *
 * ⚠ The consumer imports `mayManageTeam`/`assertCan` and must NOT re-derive a
 * role test beside them.
 */

export {
  type Actor,
  assertCan,
  mayManagePeople,
  mayManageTeam,
  mayRelease,
  type PermittedAction,
  type ProposalResource,
  RELEASE_KINDS,
  requiresReleaseAuthority,
  resolveActor,
} from './assert-can.js';

// The hash-chain append. See the note above for why it is here and what it is
// deliberately not.
export { appendAuditEvent, type AuditEntry } from './audit-writer.js';

// The canonicaliser the chain is computed with. Exported ALONGSIDE the writer
// and never separately: a caller has to hash its own `payloadHash` before
// handing it over, and hashing it a second way would put a digest into a chain
// that no verifier could reproduce. Two functions, one door.
export { canonicalHash, canonicalStringify, sha256Hex } from './canonical-hash.js';
