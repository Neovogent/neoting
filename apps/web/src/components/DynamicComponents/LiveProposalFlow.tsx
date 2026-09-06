import { useState } from 'react';
import { AlertTriangle, ArrowRight, ShieldCheck } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import type { ActionProposal, CreateActionProposalRequest } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { createProposal } from '../../api/proposals';
import { LiveProposalCard } from './LiveProposalCard';

const m = defineMessages({
  creating: { id: 'proposals.liveFlow.creating', defaultMessage: 'Creating the proposal…' },
  createFailed: { id: 'proposals.liveFlow.createFailed', defaultMessage: 'The proposal was refused — {error}' },
  errorWithCode: { id: 'proposals.liveFlow.errorWithCode', defaultMessage: '{message} ({code})' },
  enforcement: {
    id: 'proposals.liveFlow.enforcement',
    defaultMessage: 'Nothing changes until you read the review and approve it — enforced server-side, not by this screen.',
  },
  /**
   * `NT-PRP-007` (review item 26). Not an error the person caused — they
   * pressed a button twice, which the product invited. It says the act is not
   * lost and gives the one move that resolves it.
   */
  duplicate: {
    id: 'proposals.liveFlow.duplicate',
    defaultMessage: 'Already awaiting review — {detail}',
  },
  openApprovals: { id: 'proposals.liveFlow.openApprovals', defaultMessage: 'Open Approvals' },
});

/** The server's code for "an identical proposal is already awaiting review". */
const ALREADY_AWAITING_REVIEW = 'NT-PRP-007';

/**
 * The chat cards' create-then-card flow (METH Stage 13): an EXPLICIT click
 * stages the proposal, then the live Review → Approve card takes over.
 *
 * Deliberately not `ProposalFlowModal`'s create-on-mount: a chat message
 * remounts every time its conversation is reopened, and an effect that creates
 * on mount would stage a fresh proposal per visit. The click is also honest —
 * the assistant DRAFTS, the human stages, reviews and approves (SoT §8.2).
 * A card remounted after staging simply shows its draft again; the staged
 * proposal is not lost — it is pending in the Approvals queue, which is the
 * point of having one.
 */
export function LiveProposalFlow({
  buildRequest,
  clientName,
  stageLabel,
  disabled = false,
  onExecuted,
}: {
  /** Called once, on the click — never during render. */
  buildRequest: () => CreateActionProposalRequest;
  clientName: string | null;
  /** Already formatted by the caller (each card names its own action). */
  stageLabel: string;
  disabled?: boolean;
  onExecuted?: () => void;
}) {
  const intl = useIntl();
  const { session, setActiveTab } = useAppContext();
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The server said this act is already pending — see `m.duplicate`. */
  const [duplicate, setDuplicate] = useState<string | null>(null);

  /**
   * **The fast path's condition** (review item 26, matrix gate ⚖6).
   *
   * `Me.isOwner` is the fact package F put on the session, and with `role` it
   * is the whole of D44's release rule — the same conjunction
   * `assert-can.ts` applies. So this is not a guess about what the server will
   * allow; it is the same two facts, read one layer out.
   *
   * ⚠ It is still PRESENTATION. If it is somehow wrong — a `/me` thirty
   * seconds stale, a membership deactivated mid-session — the worst outcome is
   * a review that opened itself for somebody who then meets `NT-PRM-001` on
   * Approve, which is the refusal they would have met anyway. Nothing here
   * gates anything.
   */
  const canRelease = session.status === 'authenticated' && session.me.role === 'PRACTICE_ADMIN' && session.me.isOwner;

  const stage = async () => {
    if (creating) return;
    setProblem(null);
    setDuplicate(null);
    setCreating(true);
    try {
      setProposal(await createProposal(buildRequest()));
    } catch (error) {
      // The duplicate refusal is not a failure — it is the server telling the
      // person their act is already in the queue. It gets its own state and
      // its own way out, rather than the red problem banner every other
      // refusal wears.
      if (error instanceof NtProblemError && error.code === ALREADY_AWAITING_REVIEW) {
        setDuplicate(error.detail ?? error.title);
      } else {
        setProblem(
          error instanceof NtProblemError
            ? intl.formatMessage(m.errorWithCode, { message: error.detail ?? error.title, code: error.code })
            : error instanceof Error
              ? error.message
              : 'The request failed',
        );
      }
    } finally {
      setCreating(false);
    }
  };

  if (proposal) {
    return (
      <LiveProposalCard
        proposal={proposal}
        clientName={clientName}
        autoOpenReview={canRelease}
        {...(onExecuted ? { onSettled: onExecuted } : {})}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {duplicate && (
        <div className="flex flex-col gap-3 text-[13px] text-amber-300 bg-amber-400/10 border border-amber-400/25 rounded-2xl px-4 py-3">
          <p role="alert" className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span className="min-w-0">{intl.formatMessage(m.duplicate, { detail: duplicate })}</span>
          </p>
          <div>
            <button
              onClick={() => setActiveTab('Approvals')}
              className="flex items-center gap-2 px-4 py-2 text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover rounded-full transition-colors"
            >
              {intl.formatMessage(m.openApprovals)}
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}
      {problem && (
        <div className="flex items-start gap-2.5 text-[13px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-2xl px-4 py-3">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span className="min-w-0">{intl.formatMessage(m.createFailed, { error: problem })}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[12px] text-zinc-500 leading-relaxed flex items-center gap-2 min-w-0">
          <ShieldCheck size={14} className="shrink-0" />
          {intl.formatMessage(m.enforcement)}
        </p>
        <button
          onClick={() => void stage()}
          disabled={disabled || creating}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-soft disabled:opacity-50 disabled:shadow-none shrink-0"
        >
          {creating ? intl.formatMessage(m.creating) : stageLabel}
        </button>
      </div>
    </div>
  );
}
