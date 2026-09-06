import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import type { ActionProposal } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import { usePracticeTeam } from '../api/team';
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
  const { businesses, session } = useAppContext();
  /**
   * Item 26(3) — *"keep track for each approval request sent by the team
   * member"*. The queue rendered `createdByUserId` raw, so six cards read
   * *"proposed by CMTNDDE8P00337710E1OQD4J…"*.
   *
   * ⚠ The read is `GET /v1/practice-members`, which every practice-wide member
   * may call (`docs/Access_and_Approval_Matrix.md`, Part 1a) — this is not a
   * privileged lookup, and it is the SAME list the Team screen shows, so the
   * two cannot name one colleague differently. It lands on this lazy view's
   * chunk, never the floor (`api/team.ts`'s own header, the `proposals.ts`
   * rule).
   *
   * A member who is not on the list — a deactivated colleague, or a proposal
   * older than their removal — resolves to nothing, and `LiveProposalCard`'s
   * own ladder answers "you" or "a colleague". It never falls back to the id.
   */
  const { team } = usePracticeTeam({ enabled: session.status === 'authenticated' });
  const proposerFor = (userId: string | null | undefined) => {
    if (userId == null) return null;
    const member = team.members.find((m) => m.userId === userId);
    if (member === undefined) return null;
    const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
    // The email is a worse name than a name and a far better one than a CUID:
    // a colleague who accepted an invitation but never filled in their details
    // is still recognisable by the address the invitation went to.
    return name !== '' ? name : (member.email ?? null);
  };
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
          proposerName={proposerFor(proposal.createdByUserId)}
          onSettled={() => {
            setDecided((prev) => (prev.some((p) => p.id === proposal.id) ? prev : [...prev, proposal]));
            onSettled();
          }}
        />
      ))}
    </div>
  );
}
