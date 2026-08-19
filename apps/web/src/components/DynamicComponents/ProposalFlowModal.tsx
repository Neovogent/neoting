import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import type { ActionProposal, CreateActionProposalRequest } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { createProposal } from '../../api/proposals';
import { LiveProposalCard } from './LiveProposalCard';

const m = defineMessages({
  creating: { id: 'proposals.flowModal.creating', defaultMessage: 'Creating the proposal…' },
  createFailed: { id: 'proposals.flowModal.createFailed', defaultMessage: 'The proposal was refused — {error}' },
  errorWithCode: { id: 'proposals.flowModal.errorWithCode', defaultMessage: '{message} ({code})' },
  closeLabel: { id: 'proposals.flowModal.closeLabel', defaultMessage: 'Close' },
});

/**
 * Create a proposal, then hand it to the live Review → Approve card — the
 * flow behind "route this document" and "publish it again" (METH Stage 12).
 *
 * Closing without deciding leaves the proposal pending, which is not a leak:
 * it appears in the Approvals queue, where deciding it is the whole point.
 *
 * ⚠ `request` must be REFERENTIALLY STABLE (held in the opener's state, not
 * built inline) — it is the effect's dependency, and a fresh object per render
 * would re-create the proposal every paint.
 */
export function ProposalFlowModal({
  request,
  clientName,
  onExecuted,
  onClose,
}: {
  request: CreateActionProposalRequest;
  /** Resolved by the opener when the proposal is business-scoped. */
  clientName?: string | null;
  onExecuted?: () => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const { businesses } = useAppContext();
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    createProposal(request)
      .then((created) => {
        if (mounted) setProposal(created);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setProblem(
          error instanceof NtProblemError
            ? intl.formatMessage(m.errorWithCode, { message: error.detail ?? error.title, code: error.code })
            : error instanceof Error
              ? error.message
              : 'The request failed',
        );
      });
    return () => {
      mounted = false;
    };
  }, [request, intl]);

  const resolvedName =
    clientName ??
    (request.businessId ? (businesses.find((b) => b.id === request.businessId)?.name ?? request.businessId) : null);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl"
      >
        <button
          onClick={onClose}
          aria-label={intl.formatMessage(m.closeLabel)}
          className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
        >
          <X size={18} />
        </button>

        {problem ? (
          <div className="border border-red-500/20 rounded-[32px] bg-card shadow-2xl p-6 flex items-start gap-3 text-[13px] text-red-300">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span className="min-w-0">{intl.formatMessage(m.createFailed, { error: problem })}</span>
          </div>
        ) : proposal ? (
          <LiveProposalCard proposal={proposal} clientName={resolvedName} {...(onExecuted ? { onSettled: onExecuted } : {})} />
        ) : (
          <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl p-6 text-[13px] font-bold text-zinc-500">
            {intl.formatMessage(m.creating)}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
