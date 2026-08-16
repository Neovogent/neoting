import { CheckCircle } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { ApprovalItem } from '../../lib/types';

const m = defineMessages({
  empty: { id: 'shell.approvalBatchCard.empty', defaultMessage: 'Nothing in the approval queue matches that.' },
  emptyUnder: {
    id: 'shell.approvalBatchCard.emptyUnder',
    defaultMessage: 'Nothing in the approval queue matches that (under {threshold}).',
  },
  title: {
    id: 'shell.approvalBatchCard.title',
    defaultMessage: '{count, plural, one {Approve # item} other {Approve # items}}',
  },
  subtitle: { id: 'shell.approvalBatchCard.subtitle', defaultMessage: '{total} total' },
  subtitleFiltered: {
    id: 'shell.approvalBatchCard.subtitleFiltered',
    defaultMessage: '{total} total • filtered under {threshold}',
  },
  itemsHeading: { id: 'shell.approvalBatchCard.itemsHeading', defaultMessage: 'Items that will be approved' },
  effectHeading: { id: 'shell.approvalBatchCard.effectHeading', defaultMessage: 'Effect' },
  stagesLabel: { id: 'shell.approvalBatchCard.stagesLabel', defaultMessage: 'Stages passed' },
  stagesValue: { id: 'shell.approvalBatchCard.stagesValue', defaultMessage: 'One approval passes each stage' },
  afterLabel: { id: 'shell.approvalBatchCard.afterLabel', defaultMessage: 'After approval' },
  afterValue: { id: 'shell.approvalBatchCard.afterValue', defaultMessage: 'Item details lock' },
  autoPublishLabel: { id: 'shell.approvalBatchCard.autoPublishLabel', defaultMessage: 'Auto-publish' },
  autoPublishValue: { id: 'shell.approvalBatchCard.autoPublishValue', defaultMessage: 'Approvals override it' },
  auditLabel: { id: 'shell.approvalBatchCard.auditLabel', defaultMessage: 'Audit' },
  auditValue: {
    id: 'shell.approvalBatchCard.auditValue',
    defaultMessage: 'Who, when and what was shown is recorded',
  },
  approveAction: { id: 'shell.approvalBatchCard.approveAction', defaultMessage: 'Approve batch' },
  success: {
    id: 'shell.approvalBatchCard.success',
    defaultMessage: '{count, plural, one {# item} other {# items}} approved ({total}) and locked.',
  },
  auditAction: { id: 'shell.approvalBatchCard.auditAction', defaultMessage: 'Approved items' },
  auditScope: { id: 'shell.approvalBatchCard.auditScope', defaultMessage: '{count} items, {total}' },
});

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
  const intl = useIntl();

  const names = clients.filter((c) => clientIds.includes(c.id)).map((c) => c.name);
  const threshold = thresholdFrom(query);

  let batch: ApprovalItem[] = approvals;
  if (names.length) batch = batch.filter((a) => names.includes(a.clientName));
  if (threshold !== null) batch = batch.filter((a) => a.total < threshold);

  if (batch.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        {threshold === null
          ? intl.formatMessage(m.empty)
          : intl.formatMessage(m.emptyUnder, { threshold: currency(threshold) })}
      </div>
    );
  }

  const total = batch.reduce((n, a) => n + a.total, 0);

  return (
    <ReviewGate
      icon={CheckCircle}
      title={intl.formatMessage(m.title, { count: batch.length })}
      subtitle={
        threshold === null
          ? intl.formatMessage(m.subtitle, { total: currency(total) })
          : intl.formatMessage(m.subtitleFiltered, { total: currency(total), threshold: currency(threshold) })
      }
      detail={
        <>
          <ReviewSection title={intl.formatMessage(m.itemsHeading)}>
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

          <ReviewSection title={intl.formatMessage(m.effectHeading)}>
            <ReviewRows
              rows={[
                { label: intl.formatMessage(m.stagesLabel), value: intl.formatMessage(m.stagesValue) },
                { label: intl.formatMessage(m.afterLabel), value: intl.formatMessage(m.afterValue) },
                { label: intl.formatMessage(m.autoPublishLabel), value: <Pill tone="blue">{intl.formatMessage(m.autoPublishValue)}</Pill> },
                { label: intl.formatMessage(m.auditLabel), value: intl.formatMessage(m.auditValue) },
              ]}
            />
          </ReviewSection>
        </>
      }
      approveLabel={intl.formatMessage(m.approveAction)}
      successMessage={intl.formatMessage(m.success, { count: batch.length, total: currency(total) })}
      auditAction={intl.formatMessage(m.auditAction)}
      auditScope={intl.formatMessage(m.auditScope, { count: batch.length, total: currency(total) })}
      onApprove={() => approveItems(batch.map((a) => a.id))}
    />
  );
}
