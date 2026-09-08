import { useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { useChases, type LiveChase } from '../api/chases';
import { sendChaseNow } from '../api/proposals';
import { errorLabel } from '../api/slices';
import { DataTable, Pill } from '../components/DynamicComponents/DataTable';
import { commonLabels } from '../i18n/common';
import { isUnexplained } from '../lib/matching';
import { currency } from '../lib/resolver';
import type { BankTransaction, Client } from '../lib/types';

/**
 * The client's Chases tab, live (review item 63): it LEADS with the missing
 * documents — every unexplained bank line from the statement analysis — and
 * reconciles them with the chases already sent.
 *
 * Three rules, none of them this file's invention:
 *
 * - **The missing list is `isUnexplained`, the one predicate** (#255): the
 *   same set the server counts, the Bank header totals, and the chase engine
 *   chases. This tab must not mint a seventh definition of "missing".
 * - **Selection stages the REAL chase** — item 15's server-composed
 *   `chase.send` seam (`requestChaseProposal`), the same action the Bank tab's
 *   bulk bar stages; this is the second door onto it, never a second engine.
 *   The message is composed at review and released from Approvals (D44).
 * - **A line inside an OPEN chase is marked, not re-offered** — "chased
 *   {date}, awaiting reply". Detection's own over-ask gate suppresses re-chase
 *   server-side; the screen says so instead of offering a button the engine
 *   would ignore.
 *
 * Its own lazy chunk, deliberately: `api/chases.ts` and the generated chases
 * client belong to the surfaces that read them (the ChasesView placement
 * rule), and the ClientDetailView route is within ~1.5 kB of its budget.
 * Synthetic mode never mounts this — the seeded MissingItem table in
 * ClientDetailView stays byte-for-byte.
 */

const m = defineMessages({
  missingHeading: { id: 'clients.clientChases.missingHeading', defaultMessage: 'Missing documents' },
  missingIntro: {
    id: 'clients.clientChases.missingIntro',
    defaultMessage:
      'Every bank line with no evidence and nothing suppressing it — the same set the statement analysis counts. Select lines to ask {client} for the paperwork; the message is composed server-side and sends straight away, recorded in Approvals with your name on it.',
  },
  missingEmpty: {
    id: 'clients.clientChases.missingEmpty',
    defaultMessage: 'Nothing is missing — every bank line has its evidence, or needs none.',
  },
  bankUnread: {
    id: 'clients.clientChases.bankUnread',
    defaultMessage:
      'The bank data could not be read, so the missing list cannot be shown — a list over unread data would name the wrong lines. Try again in a moment.',
  },
  bankLoading: { id: 'clients.clientChases.bankLoading', defaultMessage: 'Reading the bank data…' },
  colDaysMissing: { id: 'clients.clientChases.colDaysMissing', defaultMessage: 'Days missing' },
  daysMissing: { id: 'clients.clientChases.daysMissing', defaultMessage: '{days}d' },
  chaseAction: { id: 'clients.clientChases.chaseAction', defaultMessage: 'Chase' },
  chaseSelected: { id: 'clients.clientChases.chaseSelected', defaultMessage: 'Chase selected' },
  chasedAwaiting: {
    id: 'clients.clientChases.chasedAwaiting',
    defaultMessage: 'Chased {date}, awaiting reply',
  },
  chaseQueued: {
    id: 'clients.clientChases.chaseQueued',
    defaultMessage:
      'Chase sent for {count, plural, one {# transaction} other {# transactions}} — the client has been emailed their secure upload link. It is recorded in Approvals with your name on it.',
  },
  chaseQueueFailed: {
    id: 'clients.clientChases.chaseQueueFailed',
    defaultMessage: 'The chase could not be sent. Nothing has gone to the client — try again.',
  },
  allAlreadyChased: {
    id: 'clients.clientChases.allAlreadyChased',
    defaultMessage: 'Every selected line is already inside an open chase — asking twice is the engine\'s to decide, not a second send.',
  },

  sentHeading: { id: 'clients.clientChases.sentHeading', defaultMessage: 'Chases sent' },
  sentEmpty: { id: 'clients.clientChases.sentEmpty', defaultMessage: 'No chases have been sent to this client yet.' },
  sentError: {
    id: 'clients.clientChases.sentError',
    defaultMessage: 'The sent chases could not be read — {label}',
  },
  sentLoading: { id: 'clients.clientChases.sentLoading', defaultMessage: 'Reading the sent chases…' },
  sentMeta: {
    id: 'clients.clientChases.sentMeta',
    defaultMessage: '{count, plural, one {# item} other {# items}} · sent {date}',
  },
  sentMetaUnsent: {
    id: 'clients.clientChases.sentMetaUnsent',
    defaultMessage: '{count, plural, one {# item} other {# items}} · created {date}',
  },
  stateAwaiting: { id: 'clients.clientChases.stateAwaiting', defaultMessage: 'Awaiting reply' },
  stateReceived: { id: 'clients.clientChases.stateReceived', defaultMessage: 'Received' },
  stateClosed: { id: 'clients.clientChases.stateClosed', defaultMessage: 'Closed' },
});

const MONTH_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole days since a display date ("06 Aug 2026"), or null when unreadable. */
function daysSince(display: string, nowMs: number): number | null {
  const parts = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(display.trim());
  if (!parts) return null;
  const month = MONTH_ORDER.indexOf(parts[2] ?? '');
  if (month < 0) return null;
  const then = Date.UTC(Number(parts[3]), month, Number(parts[1]));
  return Math.max(0, Math.floor((nowMs - then) / 86_400_000));
}

export default function ClientChases({ client }: { client: Client }) {
  const { transactions, slices, isSameClient } = useAppContext();
  const intl = useIntl();
  const bankSlice = slices.bankTransactions;

  // The auto-close beat happens outside this browser (a portal upload closes
  // the chase server-side); the hook polls, which is why the "awaiting reply"
  // marks clear themselves when the paperwork arrives.
  const { chases, isLoading: chasesLoading, error: chasesError } = useChases({ enabled: true });

  const [outcome, setOutcome] = useState<
    { kind: 'queued'; count: number } | { kind: 'failed'; label: string } | null
  >(null);

  // The one predicate (#255) over the client's own lines — never a re-derivation.
  const missing = useMemo(
    () => transactions.filter((t) => isSameClient(t.clientId, client.id) && isUnexplained(t)),
    [transactions, client.id, isSameClient],
  );

  const clientChases = useMemo(
    () => chases.filter((c) => isSameClient(c.businessId, client.id)),
    [chases, client.id, isSameClient],
  );

  /** Which OPEN chase covers a transaction — the marked-not-re-offered rule. */
  const openChaseByTxn = useMemo(() => {
    const map = new Map<string, LiveChase>();
    for (const chase of clientChases) {
      if (!chase.open) continue;
      for (const item of chase.items) map.set(item.transactionId, chase);
    }
    return map;
  }, [clientChases]);

  const stage = async (rows: readonly BankTransaction[]) => {
    const chaseable = rows.filter((r) => !openChaseByTxn.has(r.id));
    if (chaseable.length === 0) {
      setOutcome({ kind: 'failed', label: intl.formatMessage(m.allAlreadyChased) });
      return;
    }
    setOutcome(null);
    try {
      // One client, one business, one grouped message — the row's own server
      // id, which is the fact the compose seam re-derives and checks anyway.
      await sendChaseNow(chaseable[0]!.clientId, chaseable.map((r) => r.id));
      setOutcome({ kind: 'queued', count: chaseable.length });
    } catch (error) {
      setOutcome({ kind: 'failed', label: errorLabel(error) ?? intl.formatMessage(m.chaseQueueFailed) });
    }
  };

  const nowMs = Date.now();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-[15px] font-bold text-white mb-1">{intl.formatMessage(m.missingHeading)}</h3>
        <p className="text-[13px] text-zinc-500 leading-relaxed mb-4 max-w-2xl">
          {intl.formatMessage(m.missingIntro, { client: client.name })}
        </p>

        {outcome !== null && (
          <p
            role={outcome.kind === 'failed' ? 'alert' : 'status'}
            className={`text-[12px] font-semibold mb-3 ${outcome.kind === 'failed' ? 'text-amber-400' : 'text-brand'}`}
          >
            {outcome.kind === 'queued' ? intl.formatMessage(m.chaseQueued, { count: outcome.count }) : outcome.label}
          </p>
        )}

        {bankSlice.source === 'error' ? (
          // A failed read says so — a "nothing missing" over unread data is
          // the item-25 all-clear, one surface over.
          <p role="alert" className="text-[13px] text-amber-400">{intl.formatMessage(m.bankUnread)}</p>
        ) : bankSlice.loading ? (
          <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.bankLoading)}</p>
        ) : (
          <DataTable<BankTransaction>
            className="max-w-none"
            columns={[
              {
                key: 'description',
                label: intl.formatMessage(commonLabels.supplier),
                sortValue: (t) => t.description,
                render: (t) => <span className="text-white font-semibold">{t.description}</span>,
              },
              { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (t) => t.date },
              {
                key: 'days',
                label: intl.formatMessage(m.colDaysMissing),
                align: 'right',
                sortValue: (t) => daysSince(t.date, nowMs) ?? 0,
                render: (t) => {
                  const days = daysSince(t.date, nowMs);
                  return days === null ? (
                    <span className="text-zinc-500">—</span>
                  ) : (
                    <Pill tone={days >= 30 ? 'red' : days >= 14 ? 'amber' : 'neutral'}>
                      {intl.formatMessage(m.daysMissing, { days })}
                    </Pill>
                  );
                },
              },
              {
                key: 'amount',
                label: intl.formatMessage(commonLabels.amount),
                align: 'right',
                sortValue: (t) => Math.abs(t.amount),
                render: (t) => <span className="text-white font-bold tabular-nums">{currency(Math.abs(t.amount))}</span>,
              },
              {
                // The verb on the row — or the honest mark when an open chase
                // already covers it (asking twice is the engine's decision).
                key: 'actions',
                label: '',
                align: 'right',
                render: (t) => {
                  const open = openChaseByTxn.get(t.id);
                  if (open !== undefined) {
                    return (
                      <span className="text-[12px] text-zinc-500 whitespace-nowrap">
                        {intl.formatMessage(m.chasedAwaiting, { date: open.lastSentAt ?? open.createdAt })}
                      </span>
                    );
                  }
                  return (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void stage([t]);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-brand bg-brand/10 border border-brand/25 hover:bg-brand/20 transition-colors whitespace-nowrap"
                    >
                      <Send size={12} strokeWidth={2.5} />
                      {intl.formatMessage(m.chaseAction)}
                    </button>
                  );
                },
              },
            ]}
            rows={missing}
            rowId={(t) => t.id}
            selectable
            actionsOnTop
            emptyMessage={intl.formatMessage(m.missingEmpty)}
            bulkActions={[
              {
                label: intl.formatMessage(m.chaseSelected),
                icon: Send,
                primary: true,
                onClick: (sel: BankTransaction[]) => void stage(sel),
              },
            ]}
          />
        )}
      </section>

      <section>
        <h3 className="text-[15px] font-bold text-white mb-4">{intl.formatMessage(m.sentHeading)}</h3>
        {chasesError ? (
          <p role="alert" className="text-[13px] text-amber-400">
            {intl.formatMessage(m.sentError, { label: errorLabel(chasesError) ?? String(chasesError) })}
          </p>
        ) : chasesLoading ? (
          <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.sentLoading)}</p>
        ) : clientChases.length === 0 ? (
          <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.sentEmpty)}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {clientChases.map((chase) => (
              <div key={chase.id} className="flex items-center gap-3 p-4 rounded-2xl bg-ground/60 border border-white/5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-white truncate">
                    {chase.items.map((i) => i.supplier).join(' · ') || chase.id}
                  </div>
                  <div className="text-[12px] text-zinc-500">
                    {chase.lastSentAt !== null
                      ? intl.formatMessage(m.sentMeta, { count: chase.items.length, date: chase.lastSentAt })
                      : intl.formatMessage(m.sentMetaUnsent, { count: chase.items.length, date: chase.createdAt })}
                    {chase.closedReason !== null ? ` · ${chase.closedReason}` : ''}
                  </div>
                </div>
                {chase.open ? (
                  <Pill tone="amber">{intl.formatMessage(m.stateAwaiting)}</Pill>
                ) : chase.state === 'CLOSED_RECEIVED' ? (
                  <Pill tone="green">{intl.formatMessage(m.stateReceived)}</Pill>
                ) : (
                  <Pill>{intl.formatMessage(m.stateClosed)}</Pill>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
