import { useState } from 'react';
import { AlertTriangle, Check, ChevronRight, FileText, HelpCircle } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useSupplierStatements, type LiveSupplierStatement, type LiveSupplierStatementLine } from '../api/supplierStatements';
import { DataSourceBadge, SliceLoadError } from '../components/DataSourceBadge';
import { Pill } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import type { Client } from '../lib/types';

/**
 * The client's Supplier Statements tab, LIVE (issue #318): every statement the
 * server holds for this client, reconciled server-side against the documents
 * on file, with the server's own verdict on every line.
 *
 * Until this component the live tab was `ClientSupplierStatements` — the
 * synthetic screen, whose "on file / no document" marks were computed in the
 * browser out of whatever documents happened to be loaded, plus one invented
 * missing line. A reconciliation nobody did, presented as one that was.
 *
 * Three rules, none of them this file's invention:
 *
 * - **Nothing here decides whether a line is matched.** The outcome comes off
 *   the wire (`MATCHED` / `MISSING` / `UNREADABLE`), computed by the product's
 *   one matching rule — the chase lane's `chaseMatchesDocument`. This screen
 *   renders the verdict and never re-derives it.
 * - **No control whose write the next poll reverts** (the S12/S14 rule).
 *   Nothing in the API creates, removes or chases from a supplier statement
 *   yet, so there is no Upload, no Remove and no Chase button here — not
 *   disabled-with-tooltip, ABSENT, because none of the three has a server path
 *   a tooltip could point at. The empty state says so in as many words.
 * - **A failed read says so and offers a retry** — `SliceLoadError`, never an
 *   empty list dressed as "fully reconciled".
 *
 * Its own lazy chunk, deliberately: it carries `api/supplierStatements.ts` and
 * the generated banking client, and the ClientDetailView route is within a few
 * kilobytes of its budget. Synthetic mode never mounts this — the seeded
 * `ClientSupplierStatements` screen stays byte-for-byte.
 */

const m = defineMessages({
  intro: {
    id: 'clients.clientSupplierStatementsLive.intro',
    defaultMessage:
      'What each supplier says they invoiced, checked against the documents we hold. Every line is answered by a document.',
  },
  introGaps: {
    id: 'clients.clientSupplierStatementsLive.introGaps',
    defaultMessage:
      'What each supplier says they invoiced, checked against the documents we hold. {count, plural, one {# line} other {# lines}} have no document — those are the invoices to chase.',
  },
  sliceLabel: { id: 'clients.clientSupplierStatementsLive.sliceLabel', defaultMessage: 'supplier statements' },
  loadFailed: {
    id: 'clients.clientSupplierStatementsLive.loadFailed',
    defaultMessage: 'The supplier statements could not be read — nothing below is known.',
  },
  loading: { id: 'clients.clientSupplierStatementsLive.loading', defaultMessage: 'Reading the supplier statements…' },
  empty: {
    id: 'clients.clientSupplierStatementsLive.empty',
    defaultMessage:
      'No supplier statements on file for {client}. Supplier statements cannot be uploaded from this screen yet.',
  },
  statusReconciled: { id: 'clients.clientSupplierStatementsLive.statusReconciled', defaultMessage: 'Fully reconciled' },
  statusMissing: {
    id: 'clients.clientSupplierStatementsLive.statusMissing',
    defaultMessage: '{count, plural, one {# missing invoice} other {# missing invoices}}',
  },
  statusUnreadable: {
    id: 'clients.clientSupplierStatementsLive.statusUnreadable',
    defaultMessage: '{count, plural, one {# line} other {# lines}} could not be read',
  },
  statusNoLines: { id: 'clients.clientSupplierStatementsLive.statusNoLines', defaultMessage: 'No lines read' },
  statementMeta: {
    id: 'clients.clientSupplierStatementsLive.statementMeta',
    defaultMessage: 'Statement to {endDate} · {fileName} · added {uploadedAt}',
  },
  statementTotal: { id: 'clients.clientSupplierStatementsLive.statementTotal', defaultMessage: 'Statement total' },
  matchedCount: {
    id: 'clients.clientSupplierStatementsLive.matchedCount',
    defaultMessage: '{matched} of {total} matched · {missing} missing',
  },
  outstanding: {
    id: 'clients.clientSupplierStatementsLive.outstanding',
    defaultMessage: 'Supplier says {amount} outstanding',
  },
  hideLines: { id: 'clients.clientSupplierStatementsLive.hideLines', defaultMessage: 'Hide lines' },
  showLines: { id: 'clients.clientSupplierStatementsLive.showLines', defaultMessage: 'Show every line here' },
  noLines: {
    id: 'clients.clientSupplierStatementsLive.noLines',
    defaultMessage: 'No lines were read from this statement.',
  },
  lineOnFile: { id: 'clients.clientSupplierStatementsLive.lineOnFile', defaultMessage: 'On file' },
  lineNoDocument: { id: 'clients.clientSupplierStatementsLive.lineNoDocument', defaultMessage: 'No document' },
  lineUnreadable: { id: 'clients.clientSupplierStatementsLive.lineUnreadable', defaultMessage: 'Amount not read' },
  lineAmountUnknown: { id: 'clients.clientSupplierStatementsLive.lineAmountUnknown', defaultMessage: 'Amount unknown' },
});

export default function ClientSupplierStatementsLive({ client }: { client: Client }) {
  const intl = useIntl();
  const { statements, status, refetch } = useSupplierStatements({ businessId: client.id, enabled: true });
  const [open, setOpen] = useState<string | null>(null);

  const gapCount = statements.reduce((n, st) => n + st.totals.missingCount, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[13px] text-zinc-500 leading-relaxed max-w-2xl">
          {intl.formatMessage(gapCount > 0 ? m.introGaps : m.intro, { count: gapCount })}
        </p>
        <DataSourceBadge slice={intl.formatMessage(m.sliceLabel)} status={status} onRetry={refetch} />
      </div>

      {status.source === 'error' ? (
        <SliceLoadError heading={intl.formatMessage(m.loadFailed)} error={status.error} onRetry={refetch} />
      ) : status.loading ? (
        <p role="status" className="text-[13px] text-zinc-500">
          {intl.formatMessage(m.loading)}
        </p>
      ) : statements.length === 0 ? (
        <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center shadow-2xl">
          <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
            {intl.formatMessage(m.empty, { client: client.name })}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {statements.map((st) => (
            <StatementCard key={st.id} statement={st} isOpen={open === st.id} onToggle={() => setOpen(open === st.id ? null : st.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatementCard({
  statement: st,
  isOpen,
  onToggle,
}: {
  statement: LiveSupplierStatement;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const { totals } = st;

  return (
    <div className="border border-white/5 rounded-[28px] bg-card shadow-2xl overflow-hidden">
      <div className="p-5 flex items-center gap-4 flex-wrap">
        <div className="w-10 h-11 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0">
          <FileText size={16} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-[15px] font-bold text-white">{st.supplier}</span>
            {totals.lineCount === 0 && <Pill>{intl.formatMessage(m.statusNoLines)}</Pill>}
            {totals.lineCount > 0 && totals.missingCount === 0 && totals.unreadableCount === 0 && (
              <Pill tone="green">{intl.formatMessage(m.statusReconciled)}</Pill>
            )}
            {totals.missingCount > 0 && (
              <Pill tone="red">{intl.formatMessage(m.statusMissing, { count: totals.missingCount })}</Pill>
            )}
            {totals.unreadableCount > 0 && (
              <Pill tone="amber">{intl.formatMessage(m.statusUnreadable, { count: totals.unreadableCount })}</Pill>
            )}
          </div>
          <div className="text-[12px] text-zinc-500 mt-1">
            {intl.formatMessage(m.statementMeta, {
              endDate: st.statementEndDate,
              fileName: st.fileName ?? '—',
              uploadedAt: st.uploadedAt,
            })}
          </div>
          {st.outstandingBalance !== null && (
            <div className="text-[12px] text-zinc-500 mt-0.5">
              {intl.formatMessage(m.outstanding, { amount: currency(st.outstandingBalance) })}
            </div>
          )}
        </div>

        <div className="text-right shrink-0">
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{intl.formatMessage(m.statementTotal)}</div>
          <div className="text-lg font-bold text-white tabular-nums">{currency(totals.statementTotal)}</div>
          <div className="text-[11px] text-zinc-600">
            {intl.formatMessage(m.matchedCount, {
              matched: totals.matchedCount,
              total: totals.lineCount,
              missing: currency(totals.missingTotal),
            })}
          </div>
        </div>

        <button
          onClick={onToggle}
          className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors shrink-0"
          title={intl.formatMessage(isOpen ? m.hideLines : m.showLines)}
          aria-label={intl.formatMessage(isOpen ? m.hideLines : m.showLines)}
          aria-expanded={isOpen}
        >
          <ChevronRight size={15} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>
      </div>

      {isOpen && (
        <div className="border-t border-white/5 p-5 flex flex-col gap-2">
          {st.lines.length === 0 && <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.noLines)}</p>}
          {st.lines.map((line) => (
            <LineRow key={line.id} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

function LineRow({ line }: { line: LiveSupplierStatementLine }) {
  const intl = useIntl();
  const icon =
    line.outcome === 'MATCHED'
      ? 'bg-brand/10 text-brand border border-brand/25'
      : line.outcome === 'MISSING'
        ? 'bg-red-500/10 text-red-400 border border-red-400/25'
        : 'bg-amber-500/10 text-amber-400 border border-amber-400/25';

  return (
    <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5 flex-wrap">
      <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${icon}`}>
        {line.outcome === 'MATCHED' ? (
          <Check size={13} strokeWidth={3} />
        ) : line.outcome === 'MISSING' ? (
          <AlertTriangle size={13} />
        ) : (
          <HelpCircle size={13} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-white">{line.reference}</div>
        <div className="text-[12px] text-zinc-500">{line.date}</div>
      </div>
      <span className="text-[13px] font-bold text-white tabular-nums shrink-0">
        {line.amount === null ? intl.formatMessage(m.lineAmountUnknown) : currency(line.amount)}
      </span>
      <span className="shrink-0 sm:w-32 text-right basis-full sm:basis-auto pl-10 sm:pl-0 flex sm:block">
        {line.outcome === 'MATCHED' ? (
          <Pill tone="green">{intl.formatMessage(m.lineOnFile)}</Pill>
        ) : line.outcome === 'MISSING' ? (
          <Pill tone="red">{intl.formatMessage(m.lineNoDocument)}</Pill>
        ) : (
          <Pill tone="amber">{intl.formatMessage(m.lineUnreadable)}</Pill>
        )}
      </span>
    </div>
  );
}
