import type { ActionProposal, ProposalKind, ProposalState } from '@neoting/contracts/model';
import type { ActionProposal as ActionProposalRow } from '@prisma/client';

/**
 * Prisma row → contract `ActionProposal`. One projection, used by every
 * operation's response, so the create path and the read path cannot drift
 * apart about what a proposal looks like (the `document-response.ts` lesson).
 */
export function toActionProposal(row: ActionProposalRow): ActionProposal {
  return {
    id: row.id,
    businessId: row.businessId,
    // `kind` is TEXT in the schema (see check-contract.mjs on why ProposalKind
    // is not a mirrored Prisma enum); every writer is this module, which only
    // accepts registry kinds — the narrowing is recording that, not hoping.
    kind: row.kind as ProposalKind,
    state: row.state as ProposalState,
    payload: isJsonObject(row.payload) ? row.payload : {},
    payloadHash: row.payloadHash,
    renderedSummaryHash: row.renderedSummaryHash,
    createdByUserId: row.createdByUserId,
    createdByModel: row.createdByModel,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    executedAt: row.executedAt === null ? null : row.executedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    policyProposalId: row.policyProposalId,
    outcome: isJsonObject(row.outcome) ? row.outcome : null,
    traceId: row.traceId,
  };
}

function isJsonObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
