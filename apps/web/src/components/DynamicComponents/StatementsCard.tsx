import { ArrowRight, Landmark } from 'lucide-react';
import { useCallback } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { useStatements } from '../../api/statements';
import { navigate, path } from '../../lib/router';
import { commonLabels } from '../../i18n/common';
import { DataTable, Pill } from './DataTable';
import type { Statement } from '../../lib/types';

const m = defineMessages({
  title: { id: 'shell.statementsCard.title', defaultMessage: 'Bank statements' },
  subtitle: {
    id: 'shell.statementsCard.subtitle',
    defaultMessage:
      '{scope} · uploaded statements and what the completeness gate could prove about each. Statements are uploaded on the Bank tab — this is where every bank transaction in the workspace came from.',
  },
  allClients: { id: 'shell.statementsCard.allClients', defaultMessage: 'All clients' },
  empty: {
    id: 'shell.statementsCard.empty',
    defaultMessage: 'No statements uploaded for this client yet. Upload one on the Bank tab to bring their bank transactions in.',
  },
  loading: { id: 'shell.statementsCard.loading', defaultMessage: 'Reading this client’s statements…' },
  failed: { id: 'shell.statementsCard.failed', defaultMessage: 'Statements could not be loaded: {error}' },
  columnPeriod: { id: 'shell.statementsCard.columnPeriod', defaultMessage: 'Period' },
  columnFile: { id: 'shell.statementsCard.columnFile', defaultMessage: 'File' },
  columnRows: { id: 'shell.statementsCard.columnRows', defaultMessage: 'Transactions' },
  columnAssurance: { id: 'shell.statementsCard.columnAssurance', defaultMessage: 'Completeness' },
  // The same three sentences the Bank tab uses, deliberately: D41's verdict must
  // read identically wherever it is shown, or the two screens become two claims.
  assuranceComplete: { id: 'shell.statementsCard.assuranceComplete', defaultMessage: 'Every line accounted for' },
  assuranceReduced: { id: 'shell.statementsCard.assuranceReduced', defaultMessage: 'Cannot be checked' },
  assuranceIncomplete: { id: 'shell.statementsCard.assuranceIncomplete', defaultMessage: 'Lines missing' },
  openBank: { id: 'shell.statementsCard.openBank', defaultMessage: 'Open the Statements tab' },
});

/**
 * `SHOW_STATEMENTS` — "show me the bank statements for this client" (#233).
 *
 * ## Why this card exists at all
 *
 * The chat used to answer a statement question with a **capability lie**: that
 * this workspace handles receipts and invoices "not bank statements", and the
 * accountant should pull those from their banking or accounting platform. D40
 * makes manual statement upload the ONLY bank input in this release — the rows
 * were sitting in our own `statements` table the whole time.
 *
 * ## It renders the same rows the Bank tab does, from the same query
 *
 * `useStatements` is the Bank tab's own hook against `GET /v1/statements`, so
 * there is one live source and no second opinion. Nothing here is derived from
 * anything the model said: the model chose an INTENT, and every period, count
 * and verdict below was read from the server after the fact. That is the same
 * division `SHOW_INBOX` and its table already keep.
 *
 * ⚠ **`assurance` is rendered as its own column and never folded into a status.**
 * "We read every line and proved none is missing" and "we could not check
 * whether any line is missing" are opposite claims. Collapsing them into one
 * green tick is precisely what D41 forbids, and on a statement it is the single
 * distinction an accountant is acting on.
 */
export function StatementsCard({
  businessId,
  businessName,
}: {
  businessId?: string | undefined;
  businessName?: string | undefined;
}) {
  const { clients, isSameClient } = useAppContext();
  const intl = useIntl();

  const nameForBusiness = useCallback(
    (id: string) => clients.find((c) => isSameClient(id, c.id))?.name ?? id,
    [clients, isSameClient],
  );
  const live = useStatements(nameForBusiness);

  const rows = live.statements.filter((s) => (businessId === undefined ? true : isSameClient(s.clientId, businessId)));
  const scope = businessName ?? intl.formatMessage(m.allClients);

  return (
    <div className="w-full flex flex-col gap-3">
      <DataTable<Statement>
        title={intl.formatMessage(m.title)}
        subtitle={intl.formatMessage(m.subtitle, { scope })}
        rows={rows}
        rowId={(s) => s.id}
        emptyMessage={
          live.source === 'error'
            ? intl.formatMessage(m.failed, { error: live.error ?? '' })
            : intl.formatMessage(m.empty)
        }
        columns={[
          {
            key: 'period',
            label: intl.formatMessage(m.columnPeriod),
            sortValue: (s) => s.period,
            render: (s) => <span className="text-white font-semibold">{s.period}</span>,
          },
          { key: 'fileName', label: intl.formatMessage(m.columnFile), sortValue: (s) => s.fileName },
          { key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (s) => s.clientName },
          {
            key: 'rows',
            label: intl.formatMessage(m.columnRows),
            align: 'right',
            sortValue: (s) => s.rows,
            render: (s) => <span className="tabular-nums text-zinc-400">{s.rows || '—'}</span>,
          },
          {
            key: 'assurance',
            label: intl.formatMessage(m.columnAssurance),
            sortValue: (s) => s.assurance ?? '',
            render: (s) => {
              // Undefined on a seeded statement, which predates the gate. A dash
              // is the honest rendering — never a green tick by default.
              if (s.assurance === undefined) return <span className="text-zinc-600">{'—'}</span>;
              const label =
                s.assurance === 'complete'
                  ? m.assuranceComplete
                  : s.assurance === 'reduced'
                    ? m.assuranceReduced
                    : m.assuranceIncomplete;
              const tone = s.assurance === 'complete' ? 'green' : s.assurance === 'reduced' ? 'amber' : 'red';
              const findings = s.findings ?? [];
              return (
                <span className="flex flex-col items-start gap-0.5">
                  <Pill tone={tone}>{intl.formatMessage(label)}</Pill>
                  {findings[0] !== undefined && (
                    <span className="text-[11px] text-zinc-500" title={findings.map((f) => f.detail).join('\n')}>
                      {findings[0].detail}
                    </span>
                  )}
                </span>
              );
            },
          },
        ]}
      />

      {/* The card answers the question; the Bank tab is where a statement is
          uploaded, opened and downloaded. One link rather than a second copy
          of those controls. */}
      {businessId !== undefined && (
        <button
          onClick={() => navigate(path('clients', businessId, 'bank', 'statements'))}
          className="self-start flex items-center gap-1.5 text-[12px] font-bold text-brand hover:text-brand-hover transition-colors"
        >
          {intl.formatMessage(m.openBank)}
          <ArrowRight size={13} />
        </button>
      )}
      {live.source === 'error' && (
        <p role="alert" className="flex items-center gap-2 text-[12px] font-semibold text-red-400">
          <Landmark size={13} />
          {intl.formatMessage(m.failed, { error: live.error ?? '' })}
        </p>
      )}
    </div>
  );
}
