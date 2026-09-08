import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { defineMessages, type MessageDescriptor } from 'react-intl';
import { z } from 'zod';
import {
  approveActionProposal,
  cancelActionProposal,
  createActionProposal,
  denyActionProposal,
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
  'bank.remove-statement': { id: 'proposals.kindLabel.bankRemoveStatement', defaultMessage: 'Remove bank statements' },
  'rule.create': { id: 'proposals.kindLabel.ruleCreate', defaultMessage: 'Create a rule' },
  'document.revoke-link': { id: 'proposals.kindLabel.documentRevokeLink', defaultMessage: 'Revoke document links' },
  'business.offboard': { id: 'proposals.kindLabel.businessOffboard', defaultMessage: 'Remove a client' },
  'business.reactivate': { id: 'proposals.kindLabel.businessReactivate', defaultMessage: 'Restore a removed client' },
  'document.purge': { id: 'proposals.kindLabel.documentPurge', defaultMessage: 'Delete documents permanently' },
  'document.resolve-duplicate': {
    id: 'proposals.kindLabel.documentResolveDuplicate',
    defaultMessage: 'Resolve a suspected duplicate',
  },
  'policy.activate': {
    id: 'proposals.kindLabel.policyActivate',
    defaultMessage: 'Turn an approval workflow on or off',
  },
});

/**
 * Which kinds only the firm's super admin may approve — tier 1 in
 * `docs/Access_and_Approval_Matrix.md` Part 2.
 *
 * ⚠ **A MIRROR of `RELEASE_KINDS` in `approvals/assert-can.ts`, and the two
 * must move together** — the `lib/correctionChecks.ts` arrangement, for the
 * same reason: the server is the rule and this is only what the screen says
 * before the click. Total over `ProposalKind`, so a new kind fails to compile
 * here and somebody has to answer "does the firm's principal sign for this?"
 * rather than defaulting into the permissive half.
 *
 * ⚠ It gates PRESENTATION and nothing else. `POST …/approval` refuses with
 * `NT-PRM-001` regardless, and a `/me` thirty seconds stale is exactly how that
 * refusal still arrives — which every surface here already handles.
 *
 * Why it exists: on 8 Sep 2026 a `PRACTICE_STANDARD` colleague was shown a
 * fully enabled, primary-styled **Approve** on his own correction, pressed it,
 * and got a 403. The publish dialog has been role-aware since item 24; the
 * queue card was not, so the one surface whose entire job is deciding was also
 * the one offering an action it knew would fail.
 */
export const NEEDS_RELEASE_AUTHORITY: Readonly<Record<ProposalKind, boolean>> = {
  // ⚠ FALSE since 8 Sep 2026 — the owner took the chase out of the release
  // tier (item 3). Mirrors `RELEASE_KINDS['chase.send']`, which carries the
  // reasoning; the two must move together.
  'chase.send': false,
  'publish.batch': true,
  'document.update-coding': true,
  'bank.remove-statement': true,
  'rule.create': true,
  'business.offboard': true,
  'business.reactivate': true,
  'document.purge': true,
  'policy.activate': true,
  'document.route': false,
  'document.archive': false,
  'document.move-business': false,
  'document.reprocess': false,
  'document.reject': false,
  'document.split': false,
  'bank.confirm-match': false,
  'document.revoke-link': false,
  'document.resolve-duplicate': false,
};

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
  /**
   * The mirror image of the one above, and it earns its sentence for the same
   * reason: the contract pins the invariant it states. `document.purge` really
   * does destroy the row and cascade to its extractions, its processing log and
   * its duplicate pairs — and the audit trail really does survive, because
   * `audit_events` is append-only with no delete path. A card that said only
   * "Delete documents permanently" would leave a reader guessing which of those
   * two halves was true.
   */
  /**
   * Removal destroys the DERIVED rows only — the uploaded file survives and
   * re-uploading re-imports it under the D41 gates. Without the sentence,
   * "Remove bank statements" reads as destroying a client's bank data, and the
   * mirror-image mistake (assuming the transactions survive) is worse.
   */
  'bank.remove-statement': {
    id: 'proposals.kindNote.bankRemoveStatement',
    defaultMessage:
      'Once approved, the imported transactions are removed with the statement. The uploaded file is kept — re-uploading it imports the lines again, with completeness re-proven.',
  },
  'document.purge': {
    id: 'proposals.kindNote.documentPurge',
    defaultMessage:
      'Once approved, the documents and everything read from them are destroyed and cannot be restored. The audit record of who deleted what, and when, is kept.',
  },
  /**
   * Offboard's mirror (review item 67), and it earns its sentence for the one
   * thing a reader would otherwise assume: that documents come back with the
   * client. They do not — `reactivate-business.ts` records why the executor
   * cannot tell an offboard's trashing from a person's own deliberate one — so
   * the card names the Trash as the way to bring them back.
   */
  'business.reactivate': {
    id: 'proposals.kindNote.businessReactivate',
    defaultMessage:
      'Once approved, the client returns to the client list and every working surface. Documents already in Trash stay there — their Trash is reachable again with them, and restoring puts each one back in the state it left.',
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

/**
 * **[Deny]** — the reviewer's refusal, with a required reason (review item 27).
 *
 * ⚠ **Not [Cancel] with a message.** Cancel is the PROPOSER withdrawing their
 * own work and its reason is optional; this is somebody else refusing theirs,
 * the reason is required, and the server emails it to them and puts it on the
 * documents they staged. The two answer different questions and land in
 * different states (`CANCELLED` vs `DENIED`), which is why there are two calls
 * here rather than one with a flag.
 */
export async function denyReviewed(proposalId: string, reason: string): Promise<void> {
  await denyActionProposal(proposalId, { reason });
}

/**
 * The reason a decided proposal carries, from its own `outcome` — a denial's
 * or a cancellation's.
 *
 * The contract types `outcome` as an open record, so this NARROWS rather than
 * trusts: a payload with no string reason answers null, never a rendering of
 * something that is not one. Same discipline as {@link offboardReason}.
 */
export function decisionReason(proposal: ActionProposal): { reason: string; deniedBy: string | null } | null {
  const outcome = proposal.outcome as Record<string, unknown> | null | undefined;
  if (outcome == null) return null;
  const reason = outcome['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  const deniedBy = outcome['deniedByName'];
  return { reason, deniedBy: typeof deniedBy === 'string' && deniedBy !== '' ? deniedBy : null };
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
/**
 * Queue a receipts chase for named bank lines (5 Sep 2026, review item 15 —
 * selecting transactions on the Bank tab now arms a real Chase). The body is
 * a placeholder the compose seam DISCARDS: the message text, the signed portal
 * link and the recipient are all stamped server-side at proposal creation
 * (`ChaseSendPayload`'s own words — "never free-typed by a caller"), and the
 * engine refuses ids that are matched or suppressed with its own sentence.
 * Creation only; the release is the Approvals queue's move (D44).
 */
export async function requestChaseProposal(businessId: string, transactionIds: readonly string[]): Promise<ActionProposal> {
  return createProposal({
    kind: 'chase.send',
    businessId,
    payload: { messages: [{ transactionIds: [...transactionIds], body: 'Composed at review.' }] },
  } as CreateActionProposalRequest);
}

/**
 * **Stage a chase and finish it, in the one order the server permits** (item 3,
 * 8 Sep 2026).
 *
 * > *"Only publishing an entry will require approval by default; a normal
 * > email chase is going under approval [and should not]."*
 *
 * `chase.send` is TIER 2 since that ruling (`NEEDS_RELEASE_AUTHORITY`), so the
 * person who staged it is the person who may approve it — and leaving it in a
 * queue for themselves is the ceremony the owner asked us to remove. This is
 * `updateCodingProposal`'s shape exactly: create → open the review → approve
 * echoing the review's own hash, three calls behind one click.
 *
 * ⚠ **Nothing about the constitutional path is skipped.** The proposal is
 * minted, `POST …/review` is what produces the hash (so Read review really was
 * opened, server-side, which is what Governance §10 requires), the hash is
 * echoed rather than recomputed here, and the audit row is written. What is
 * gone is the WAIT, not the record.
 *
 * ⚠ **The refusals still land at CREATION** — an id that is matched,
 * suppressed or unreachable, a client with no contact — so a caller meets
 * every one of them with the server's own sentence, before anything is sent.
 */
export async function sendChaseNow(businessId: string, transactionIds: readonly string[]): Promise<void> {
  const created = await requestChaseProposal(businessId, transactionIds);
  const review = await openReview(created.id);
  await approveReviewed(created.id, review.renderedSummaryHash);
}

/** The statement-request twin of {@link sendChaseNow}. Same three calls, same reasoning. */
export async function sendStatementRequestNow(businessId: string, period: string): Promise<void> {
  const created = await requestStatementProposal(businessId, period);
  const review = await openReview(created.id);
  await approveReviewed(created.id, review.renderedSummaryHash);
}

export async function requestStatementProposal(businessId: string, period: string): Promise<ActionProposal> {
  return createProposal({
    kind: 'chase.send',
    businessId,
    payload: { messages: [{ statementPeriod: period, body: 'Composed at review.' }] },
  } as CreateActionProposalRequest);
}

/**
 * Queue the removal of uploaded statements (4 Sep 2026) — one
 * `bank.remove-statement` proposal. The preview sent here is a placeholder the
 * ENGINE discards: the blast radius Read review renders (per-statement
 * transaction counts, file names) is computed server-side at creation over the
 * provenance-stamped rows, and everything refusable — a confirmed match, an
 * open chase, unprovable provenance — refuses at creation with the server's
 * own sentence. Creation only; the release is the Approvals queue's move.
 */
export async function requestRemoveStatementsProposal(statementIds: readonly string[]): Promise<ActionProposal> {
  return createProposal({
    kind: 'bank.remove-statement',
    payload: {
      statementIds: [...statementIds],
      preview: {
        statements: statementIds.map((statementId) => ({
          statementId,
          documentId: 'computed-at-creation',
          fileName: null,
          periodStart: null,
          periodEnd: null,
          transactionCount: 0,
          matchedCount: 0,
          openChaseCount: 0,
        })),
        totalTransactions: 0,
      },
    },
  } as CreateActionProposalRequest);
}

/** Nudge every queue reader to refetch now rather than on the next poll. */
export async function refreshProposals(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
}
