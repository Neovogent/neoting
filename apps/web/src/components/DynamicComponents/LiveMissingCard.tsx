import { ArrowRight, Landmark } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { API_ENABLED } from '../../api/config';
import { useChases } from '../../api/chases';
import { isUnexplained } from '../../lib/matching';
import { currency } from '../../lib/resolver';
import { commonLabels } from '../../i18n/common';
import { DataTable, Pill } from './DataTable';
import type { BankTransaction } from '../../lib/types';

const m = defineMessages({
  title: { id: 'shell.liveMissingCard.title', defaultMessage: 'Missing paperwork — live bank feed' },
  colBankLine: { id: 'shell.liveMissingCard.colBankLine', defaultMessage: 'Bank line' },
  subtitle: {
    id: 'shell.liveMissingCard.subtitle',
    defaultMessage: '{scope} · unmatched transactions with no document evidence. Suppressed bank lines are excluded — nobody is chased for a receipt that cannot exist.',
  },
  allClients: { id: 'shell.liveMissingCard.allClients', defaultMessage: 'All clients' },
  empty: { id: 'shell.liveMissingCard.empty', defaultMessage: 'Nothing is missing — every transaction in scope has its paperwork.' },
  chasesHeading: { id: 'shell.liveMissingCard.chasesHeading', defaultMessage: 'Chases already out' },
  chasesNone: { id: 'shell.liveMissingCard.chasesNone', defaultMessage: 'No open chases in this scope.' },
  chaseItems: { id: 'shell.liveMissingCard.chaseItems', defaultMessage: '{items} · last sent {lastSentAt}' },
  openChases: { id: 'shell.liveMissingCard.openChases', defaultMessage: 'Open the Chases board' },
  chasesLoading: { id: 'shell.liveMissingCard.chasesLoading', defaultMessage: 'Reading open chases…' },
});

/**
 * "Show missing paperwork for American Burger" (METH Stage 13, utterance 1) —
 * a read-only answer over REAL data: the unmatched, non-suppressed
 * transactions from the live bank slice (the same set server-side chase
 * detection reads), and the open chases from `GET /chases`. Read-only intents
 * render instantly with no review step (SoT §8.2).
 */
export function LiveMissingCard({ businessId, businessName }: { businessId?: string | undefined; businessName?: string | undefined }) {
  const { transactions, session, setActiveTab } = useAppContext();
  const intl = useIntl();
  const live = API_ENABLED && session.status === 'authenticated';
  const { chases, isLoading: chasesLoading } = useChases({ enabled: live });

  // `isUnexplained`, which is the server's own chase-detection predicate.
  //
  // This was `!isMatched(t) && !t.chaseSuppressed`, which had the suppression
  // half right and the other half wrong: it also offered SUGGESTED and
  // EXCLUDED lines as missing paperwork. Nothing will ever chase those, so the
  // card was naming work the product had already decided not to do.
  const unmatched = transactions.filter(
    (t) => (businessId ? t.clientId === businessId : true) && isUnexplained(t),
  );
  const openChases = chases.filter((c) => c.open && (businessId ? c.businessId === businessId : true));
  const scope = businessName ?? intl.formatMessage(m.allClients);

  return (
    <div className="w-full flex flex-col gap-4">
      <DataTable<BankTransaction>
        title={intl.formatMessage(m.title)}
        subtitle={intl.formatMessage(m.subtitle, { scope })}
        rows={unmatched}
        rowId={(t) => t.id}
        emptyMessage={intl.formatMessage(m.empty)}
        columns={[
          {
            key: 'description',
            label: intl.formatMessage(m.colBankLine),
            sortValue: (t) => t.description,
            render: (t) => <span className="text-white font-semibold">{t.description}</span>,
          },
          { key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (t) => t.clientName },
          { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (t) => t.date },
          {
            key: 'amount',
            label: intl.formatMessage(commonLabels.amount),
            align: 'right',
            sortValue: (t) => t.amount,
            render: (t) => <span className="text-white font-bold tabular-nums">{currency(t.amount)}</span>,
          },
        ]}
      />

      <div className="w-full border border-white/5 rounded-[24px] bg-card overflow-hidden">
        <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 border-b border-white/5">
          <h4 className="text-[13px] font-bold text-white flex items-center gap-2">
            <Landmark size={14} />
            {intl.formatMessage(m.chasesHeading)}
          </h4>
          <button
            onClick={() => setActiveTab('Chases')}
            className="flex items-center gap-1.5 text-[12px] font-bold text-brand hover:text-brand-hover transition-colors"
          >
            {intl.formatMessage(m.openChases)}
            <ArrowRight size={13} />
          </button>
        </div>
        {chasesLoading ? (
          <div className="px-5 py-4 text-[13px] text-zinc-500">{intl.formatMessage(m.chasesLoading)}</div>
        ) : openChases.length === 0 ? (
          <div className="px-5 py-4 text-[13px] text-zinc-500">{intl.formatMessage(m.chasesNone)}</div>
        ) : (
          <div className="divide-y divide-white/5">
            {openChases.map((chase) => (
              <button
                key={chase.id}
                onClick={() => setActiveTab('Chases')}
                className="w-full px-5 py-3 flex items-center justify-between gap-3 text-left hover:bg-white/5 transition-colors"
              >
                <span className="text-[13px] text-zinc-300 truncate min-w-0">
                  {intl.formatMessage(m.chaseItems, {
                    items: chase.items.map((i) => `${i.supplier} ${currency(i.amount)}`).join(' · ') || chase.id,
                    lastSentAt: chase.lastSentAt ?? '—',
                  })}
                </span>
                <Pill tone="amber">{chase.state}</Pill>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
