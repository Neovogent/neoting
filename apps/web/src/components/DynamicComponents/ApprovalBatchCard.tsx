import { CheckCircle } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { ApprovalItem } from '../../lib/types';

/** Parses "under two hundred pounds" / "under £200" out of the utterance. */
function thresholdFrom(text: string): number | null {
  // The digit group is not optional in the pattern, so a match always carries it.
  const digits = text.match(/(?:under|below|less than)\s*£?\s*([\d,]+)/i)?.[1];
  if (digits !== undefined) return Number(digits.replace(/,/g, ''));
  const words: Record<string, number> = {
    'two hundred': 200, 'five hundred': 500, 'one thousand': 1000, 'a thousand': 1000, 'two thousand': 2000,
  };
  // Matching on the entry keeps the amount in hand, rather than looking the
  // matched key back up in a record that types every lookup as a maybe.
  const hit = Object.entries(words).find(([w]) => new RegExp(`under\\s+${w}`, 'i').test(text));
  return hit ? hit[1] : null;
}

/**
 * Approval batch (PRD stage 9). Approvals override every auto-publish path,
 * and item details lock once approved.
 */
export function ApprovalBatchCard({ query, clientIds }: { query: string; clientIds: string[] }) {
  const { approvals, clients, approveItems } = useAppContext();

  const names = clients.filter((c) => clientIds.includes(c.id)).map((c) => c.name);
  const threshold = thresholdFrom(query);

  let batch: ApprovalItem[] = approvals;
  if (names.length) batch = batch.filter((a) => names.includes(a.clientName));
  if (threshold !== null) batch = batch.filter((a) => a.total < threshold);

  if (batch.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        Nothing in the approval queue matches that
        {threshold !== null ? ` (under ${currency(threshold)})` : ''}.
      </div>
    );
  }

  const total = batch.reduce((n, a) => n + a.total, 0);

  return (
    <ReviewGate
      icon={CheckCircle}
      title={`Approve ${batch.length} item${batch.length === 1 ? '' : 's'}`}
      subtitle={`${currency(total)} total${threshold !== null ? ` • filtered under ${currency(threshold)}` : ''}`}
      detail={
        <>
          <ReviewSection title="Items that will be approved">
            <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-56 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {batch.map((a) => (
                <div key={a.id} className="px-4 py-3 flex items-center justify-between gap-3 text-[13px]">
                  <div className="min-w-0">
                    <div className="text-white font-bold truncate">{a.supplier}</div>
                    <div className="text-zinc-500 truncate">
                      {a.clientName} · {a.stage}
                    </div>
                  </div>
                  <span className="text-white font-bold shrink-0">{currency(a.total)}</span>
                </div>
              ))}
            </div>
          </ReviewSection>

          <ReviewSection title="Effect">
            <ReviewRows
              rows={[
                { label: 'Stages passed', value: 'One approval passes each stage' },
                { label: 'After approval', value: 'Item details lock' },
                { label: 'Auto-publish', value: <Pill tone="blue">Approvals override it</Pill> },
                { label: 'Audit', value: 'Who, when and what was shown is recorded' },
              ]}
            />
          </ReviewSection>
        </>
      }
      approveLabel="Approve batch"
      successMessage={`${batch.length} item${batch.length === 1 ? '' : 's'} approved (${currency(total)}) and locked.`}
      auditAction="Approved items"
      auditScope={`${batch.length} items, ${currency(total)}`}
      onApprove={() => approveItems(batch.map((a) => a.id))}
    />
  );
}
