import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { defineMessages, type MessageDescriptor } from 'react-intl';
import { z } from 'zod';
import {
  approveActionProposal,
  cancelActionProposal,
  createActionProposal,
  listActionProposals,
  reviewActionProposal,
} from '@neoting/contracts/client';
import { getActionProposalResponse, listActionProposalsResponse, reviewActionProposalResponse } from '@neoting/contracts/zod';
import type { ActionProposal, CreateActionProposalRequest, ProposalKind } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The live approval queue (METH Stage 12, issue #140).
 *
 * `GET /action-proposals` is the contract delta this stage added (recorded on
 * the issue): the queue is CREATED + REVIEWED proposals, and everything that
 * changes one goes through the engine's own three doors — review, approval,
 * cancellation. Nothing here renders a summary of its own: [Read review] shows
 * exactly what `POST .../review` returned, because the hash of that render is
 * what approval echoes back (Governance §10.4).
 *
 * This module must stay OFF the bundle floor: it is imported by the lazy view
 * chunks (Approvals, Inboxes) only, never by `AppContext` — the shared floor
 * has no headroom (apps/web/CLAUDE.md, Bundle).
 */

/**
 * What each kind reads as on the queue. Total over the contract enum —
 * `proposals.test.ts` pins the keys against the generated `ProposalKind`, so a
 * kind added to the spec fails there rather than rendering as its raw id.
 */
export const KIND_LABEL: Record<ProposalKind, MessageDescriptor> = defineMessages({
  'document.route': { id: 'proposals.kindLabel.documentRoute', defaultMessage: 'Route a document' },
  'document.update-coding': { id: 'proposals.kindLabel.documentUpdateCoding', defaultMessage: 'Update document coding' },
  'document.move-business': { id: 'proposals.kindLabel.documentMoveBusiness', defaultMessage: 'Move a document between clients' },
  'document.reprocess': { id: 'proposals.kindLabel.documentReprocess', defaultMessage: 'Re-read documents' },
  'document.reject': { id: 'proposals.kindLabel.documentReject', defaultMessage: 'Reject documents' },
  'document.split': { id: 'proposals.kindLabel.documentSplit', defaultMessage: 'Split a document' },
  'document.archive': { id: 'proposals.kindLabel.documentArchive', defaultMessage: 'Archive documents' },
  'chase.send': { id: 'proposals.kindLabel.chaseSend', defaultMessage: 'Send chase email' },
  'publish.batch': { id: 'proposals.kindLabel.publishBatch', defaultMessage: 'Release for export' },
  'bank.confirm-match': { id: 'proposals.kindLabel.bankConfirmMatch', defaultMessage: 'Confirm a bank match' },
  'rule.create': { id: 'proposals.kindLabel.ruleCreate', defaultMessage: 'Create a rule' },
  'document.revoke-link': { id: 'proposals.kindLabel.documentRevokeLink', defaultMessage: 'Revoke document links' },
  'business.offboard': { id: 'proposals.kindLabel.businessOffboard', defaultMessage: 'Remove a client' },
});

/**
 * A per-kind sentence for the queue card, where the kind label alone would
 * undersell what approving does. Partial on purpose: most kinds are fully
 * described by their server-rendered review, and a second sentence here would
 * be a second description that could drift from it. `business.offboard` gets
 * one because the contract itself pins the invariant the sentence states —
 * the executor is soft (`isActive` off), never a delete, and saying less
 * would let "Remove" read as destruction (D12's retention clock forbids it).
 */
export const KIND_NOTE: Partial<Record<ProposalKind, MessageDescriptor>> = defineMessages({
  'business.offboard': {
    id: 'proposals.kindNote.businessOffboard',
    defaultMessage:
      'Once approved, the client leaves the client list and every working surface. Documents, books and the audit trail are retained — nothing is deleted.',
  },
});

/**
 * The reason the accountant gave when queuing an offboard, read back off the
 * proposal's own payload. The contract types `payload` as an open record, so
 * this narrows rather than trusts — a payload with no string reason answers
 * null, never a rendering of something that is not one.
 */
export function offboardReason(proposal: ActionProposal): string | null {
  if (proposal.kind !== 'business.offboard') return null;
  const reason = (proposal.payload as Record<string, unknown> | undefined)?.['reason'];
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null;
}

export interface UsePendingProposalsOptions {
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
}

/**
 * The queue's own key. Hand-rolled rather than the generated
 * `getListActionProposalsQueryKey` ON PURPOSE: `bank.ts` (bundle-floor) already
 * pins the generated action-proposals client module into the shared chunk, so
 * every additional export this lazy module touches from it — the hook, the
 * query-options and queryKey builders — would ship on EVERY route. The plain
 * `listActionProposals` call is the one generated import worth that price
 * (measured: the hook machinery alone was most of a +0.5 kB floor regression,
 * against 0.09 kB of headroom).
 */
const QUEUE_QUERY_KEY = ['action-proposals', 'queue'] as const;

/**
 * The queue: CREATED + REVIEWED, newest first, polled while enabled — a
 * proposal can be created from chat, from another browser, or by a model, and
 * this screen is where it is watched arriving (the documents-slice reasoning).
 * Parsed through the generated Zod schema before anything touches it.
 */
export function usePendingProposals({ enabled }: UsePendingProposalsOptions) {
  const query = useQuery({
    queryKey: QUEUE_QUERY_KEY,
    queryFn: () => listActionProposals({ state: ['CREATED', 'REVIEWED'], limit: 50 }),
    enabled,
    refetchInterval: enabled && 5_000,
  });

  const parsed = useMemo(() => {
    const empty = { proposals: [] as ActionProposal[], invalid: null as string | null };
    if (!query.data) return empty;

    const result = listActionProposalsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) {
      return {
        ...empty,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }

    return { proposals: result.data.data as ActionProposal[], invalid: null };
  }, [query.data]);

  return {
    proposals: parsed.proposals,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The rendered review, narrowed to the shape the card renders.
 *
 * The contract types `renderedSummary.sections` loosely on purpose (the shape
 * belongs to the component grammar), so this narrows it here — and FAILS
 * CLOSED: a section this code cannot render is a review the human has not
 * fully seen, so no `ReviewCard` (and therefore no Approve) comes out of it.
 */
const summarySections = z.array(
  z.object({
    heading: z.string(),
    entries: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
);

export interface ReviewCard {
  proposalId: string;
  title: string;
  sections: z.infer<typeof summarySections>;
  warnings: { code: string; message: string }[];
  /** Echoed back verbatim on approve — never recomputed client-side. */
  renderedSummaryHash: string;
}

/** [Read review] — the POST that records what was rendered, parsed fail-closed. */
export async function openReview(proposalId: string): Promise<ReviewCard> {
  const body = unwrapBody(await reviewActionProposal(proposalId));
  const parsed = reviewActionProposalResponse.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
        .join('; '),
    );
  }
  const sections = summarySections.safeParse(parsed.data.renderedSummary.sections);
  if (!sections.success) throw new Error('the review carried a section this screen cannot render');

  return {
    proposalId,
    title: parsed.data.renderedSummary.title,
    sections: sections.data,
    warnings: (parsed.data.renderedSummary.warnings ?? []).map((w) => ({ code: w.code, message: w.message })),
    renderedSummaryHash: parsed.data.renderedSummaryHash,
  };
}

/** [Approve] — echoes the hash from the review the human actually opened. */
export async function approveReviewed(proposalId: string, renderedSummaryHash: string): Promise<void> {
  await approveActionProposal(proposalId, { renderedSummaryHash });
}

/** [Cancel] — nothing executes, nothing is deleted. */
export async function cancelPending(proposalId: string, reason?: string): Promise<void> {
  await cancelActionProposal(proposalId, reason === undefined ? {} : { reason });
}

/**
 * Create a proposal and return it — the first of the three calls only. The
 * review and approval are the CARD's moves, made by the human, so this stops
 * here rather than bundling the whole ritual the way `confirmMatchProposal`
 * does: a card whose Approve was pressed by its own constructor would be the
 * UI pretending to be the person.
 */
export async function createProposal(request: CreateActionProposalRequest): Promise<ActionProposal> {
  const body = unwrapBody(await createActionProposal(request));
  const parsed = getActionProposalResponse.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data as ActionProposal;
}

/**
 * Queue a bank-statement request (engine (c), Phase 5) — one `chase.send`
 * proposal whose message names a month instead of transactions. The body sent
 * here is a placeholder the ENGINE discards: composition (the month, the
 * signed portal link, the client's PRIMARY contact) is server-side at
 * creation, and Read review shows the real text verbatim. Creation only — the
 * release is the Approvals queue's move (D44).
 */
export async function requestStatementProposal(businessId: string, period: string): Promise<ActionProposal> {
  return createProposal({
    kind: 'chase.send',
    businessId,
    payload: { messages: [{ statementPeriod: period, body: 'Composed at review.' }] },
  } as CreateActionProposalRequest);
}

/** Nudge every queue reader to refetch now rather than on the next poll. */
export async function refreshProposals(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
}
