import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import type { ActionProposal } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import { LiveProposalCard } from '../components/DynamicComponents/LiveProposalCard';

const m = defineMessages({
  intro: {
    id: 'approvals.liveQueue.intro',
    defaultMessage:
      'Every pending proposal in the practice — created in chat, on a document, or by the AI. Read review is recorded server-side; Approve executes exactly once.',
  },
  empty: {
    id: 'approvals.liveQueue.empty',
    defaultMessage:
      'Nothing awaiting approval. Anything that proposes a state change — a chase, a publish, a correction — lands here until someone reads its review and decides.',
  },
});

/**
 * The live approval queue (METH Stage 12): pending `action-proposals` from
 * `GET /action-proposals`, each driven through the real engine by its own
 * card. The workflow BUILDER stays a fixture (the Workflows tab); this is the
 * queue only.
 */
export function ApprovalsLiveQueue({
  proposals,
  loading,
  onSettled,
}: {
  proposals: ActionProposal[];
  loading: boolean;
  /** Fired when a card approves or cancels — refetch the queue. */
  onSettled: () => void;
}) {
  const intl = useIntl();
  const { businesses } = useAppContext();
  /**
   * Cards decided THIS visit stay mounted showing their outcome banner. The
   * settle refetch removes a decided proposal from `proposals`, and without
   * this the card unmounted at that instant — an approval whose confirmation
   * nobody can read (caught by the S12 browser smoke, not by unit tests).
   */
  const [decided, setDecided] = useState<ActionProposal[]>([]);
  const nameFor = (businessId: string | null | undefined) =>
    businessId ? (businesses.find((b) => b.id === businessId)?.name ?? businessId) : null;

  const decidedIds = new Set(decided.map((p) => p.id));
  const cards = [...proposals.filter((p) => !decidedIds.has(p.id)), ...decided];

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.intro)}</p>

      {loading && (
        <div className="flex flex-col gap-3" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="h-24 rounded-[32px] bg-card border border-white/5 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && cards.length === 0 && (
        <div className="border border-dashed border-white/10 rounded-[32px] p-4 md:p-10 text-center">
          <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.empty)}</p>
        </div>
      )}

      {cards.map((proposal) => (
        <LiveProposalCard
          key={proposal.id}
          proposal={proposal}
          clientName={nameFor(proposal.businessId)}
          onSettled={() => {
            setDecided((prev) => (prev.some((p) => p.id === proposal.id) ? prev : [...prev, proposal]));
            onSettled();
          }}
        />
      ))}
    </div>
  );
}
