import { useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import type { ActionProposal, CreateActionProposalRequest } from '@neoting/contracts/model';
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
});

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
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const stage = async () => {
    if (creating) return;
    setProblem(null);
    setCreating(true);
    try {
      setProposal(await createProposal(buildRequest()));
    } catch (error) {
      setProblem(
        error instanceof NtProblemError
          ? intl.formatMessage(m.errorWithCode, { message: error.detail ?? error.title, code: error.code })
          : error instanceof Error
            ? error.message
            : 'The request failed',
      );
    } finally {
      setCreating(false);
    }
  };

  if (proposal) {
    return <LiveProposalCard proposal={proposal} clientName={clientName} {...(onExecuted ? { onSettled: onExecuted } : {})} />;
  }

  return (
    <div className="flex flex-col gap-3">
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
