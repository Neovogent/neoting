import type { TransferOwnershipPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `practice.transfer-ownership` (rush/admin, 15 Oct 2026) — hand D44's owner
 * flag to another practice-wide human colleague.
 *
 * Tier 1 at the engine (`assert-can.ts`), and this executor narrows it once
 * more: the APPROVER must be the practice's current owner. A second
 * `PRACTICE_ADMIN` without the flag cannot give away what they do not hold.
 *
 * The target must be ACTIVE, HUMAN and practice-WIDE (a scoped colleague's
 * memberships carry `practice_id` NULL by design — an owner confined to two
 * clients is the D44 outage the team service refuses). They become
 * `PRACTICE_ADMIN` + `is_owner`; the previous owner keeps `PRACTICE_ADMIN`
 * without the flag. Exactly one owner remains, asserted before commit.
 *
 * ⚠ `memberships` carries no RLS, so `practiceId` from the APPROVER'S context
 * is the boundary on every query here — never a payload field.
 */
export const transferOwnershipExecutor: ProposalExecutor<'practice.transfer-ownership', TransferOwnershipPayload> = {
  kind: 'practice.transfer-ownership',

  async execute(db: ScopedClient, input: ExecutionInput<TransferOwnershipPayload>): Promise<ExecutionResult> {
    const practiceId = input.ctx.practiceId;
    if (practiceId === undefined) {
      throw new ProposalExecutionRefused('practice.transfer-ownership', 'ownership belongs to a practice, and this session acts for none');
    }
    const refuse = (why: string): never => {
      throw new ProposalExecutionRefused('practice.transfer-ownership', why);
    };

    const practiceWide = { practiceId, businessId: null } as const;
    const approver = await db.membership.findFirst({
      where: { userId: input.ctx.actorId, ...practiceWide },
      select: { id: true, isOwner: true },
    });

    const target = await db.membership.findFirst({
      where: { userId: input.payload.toUserId, ...practiceWide, user: { kind: 'HUMAN', deactivatedAt: null } },
      select: { id: true, userId: true, isOwner: true },
    });
    if (target === null) refuse('the new owner must be an active colleague with practice-wide access');

    // Replay: the hand-over already happened (the approver may no longer be
    // the owner precisely because THIS proposal ran).
    if (target!.isOwner) {
      return { changed: [{ entity: 'membership', id: target!.id }], alreadyApplied: true, followUps: [], detail: { toUserId: target!.userId } };
    }
    if (approver === null || !approver.isOwner) refuse("only the practice's current owner can hand over ownership");

    await db.membership.updateMany({ where: { ...practiceWide, isOwner: true }, data: { isOwner: false } });
    await db.membership.update({ where: { id: target!.id }, data: { role: 'PRACTICE_ADMIN', isOwner: true } });

    const owners = await db.membership.count({ where: { practiceId, isOwner: true } });
    if (owners !== 1) refuse(`a transfer must leave exactly one owner, and would leave ${owners}`);

    return {
      changed: [
        { entity: 'membership', id: approver!.id },
        { entity: 'membership', id: target!.id },
      ],
      alreadyApplied: false,
      followUps: [],
      detail: { fromUserId: input.ctx.actorId, toUserId: target!.userId },
    };
  },
};
