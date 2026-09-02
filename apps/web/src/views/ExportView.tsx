import { useMemo, useState } from 'react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import {
  AlertTriangle,
  Archive,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  History,
  Loader2,
} from 'lucide-react';

import { NtProblemError } from '@neoting/contracts';

import { API_ENABLED } from '../api/config';
import {
  EXPORT_BATCH_CAP,
  previousCalendarMonth,
  requestExport,
  useExportHistory,
  type Export,
  type ExportTarget,
} from '../api/exports';
import { errorLabel, sliceStatus } from '../api/slices';
import { DataSourceBadge, SliceLoadError } from '../components/DataSourceBadge';
import { useAppContext } from '../context/AppContext';

/**
 * **Export for VT** — launch stage A9, and the visible endpoint of the journey
 * (D42/D43, SoT §24.3).
 *
 * ## ⚠ Every word on this screen is D42 compliance, not style
 *
 * There is no ledger integration in Initial Delivery and nothing is transmitted
 * anywhere. *Published* is an INTERNAL state meaning **approved and released for
 * export**. So the vocabulary here is fixed:
 *
 * - **"Export for VT"** and **"Download VT import file"** — the two sanctioned
 *   phrasings.
 * - Never *"send to VT"*, *"publish to VT"*, *"sync"*, *"posted"* or anything
 *   that could be read as this screen having written to an accounting package.
 *   Telling an accountant their books are in a state they are not is the worst
 *   lie this product can tell, and it would be told right here.
 * - The screen says out loud, once, what pressing the button did and did not do:
 *   it produced a file, and the human imports it themselves.
 *
 * ## The lifecycle is deliberately fake, and the cap is what pays for it
 *
 * Generation is synchronous in the request — no queue, no worker, no progress
 * polling, no `QUEUED` state to watch. That is affordable only because the batch
 * is capped, so the cap is stated on the form **before** anyone hits it, and the
 * server's own `NT-EXP-003` (which names the number) is shown verbatim when they
 * do, with the one action that resolves it: narrow the period.
 *
 * ## Colour comes from tokens, and nothing lints that
 *
 * `scripts/check-colors.mjs` fails the build on raw alpha colour functions and
 * the ESLint rule catches literal strings, but **nothing catches a hex literal in a
 * className** — and a hex silently breaks the light theme, which is a
 * redefinition of the same variables. Every colour below is a palette token
 * (`bg-ground`, `bg-card`, `bg-raised`, `bg-brand`, `text-brand`) or a Tailwind
 * ramp already established in this app for a meaning (amber = degraded, red =
 * failure, emerald = settled). No `#` appears in any class string in this file.
 */

const m = defineMessages({
  // The surface is named for the JOURNEY, not the format: more targets are
  // coming, and the Format dropdown below is where the format is named.
  heading: { id: 'export.exportView.heading', defaultMessage: 'Export' },
  subheading: {
    id: 'export.exportView.subheading',
    defaultMessage: 'Published documents, as an import file for your bookkeeping software',
  },
  // ⚠ D42. This paragraph is the one that has to be exactly right: it states
  // what Published means and that nothing left the product.
  d42Note: {
    id: 'export.exportView.d42Note',
    defaultMessage:
      'Published is an internal state meaning approved and released for export. Nothing leaves Neo Accounting on its own — this builds a file, you download it, and you import it into VT yourself.',
  },

  clientLabel: { id: 'export.exportView.clientLabel', defaultMessage: 'Client' },
  clientPlaceholder: { id: 'export.exportView.clientPlaceholder', defaultMessage: 'Choose a client' },
  fromLabel: { id: 'export.exportView.fromLabel', defaultMessage: 'From' },
  toLabel: { id: 'export.exportView.toLabel', defaultMessage: 'To' },
  formatLabel: { id: 'export.exportView.formatLabel', defaultMessage: 'Import file format' },
  periodHint: {
    id: 'export.exportView.periodHint',
    defaultMessage: 'Both dates are included. Only documents that reached Published are exported.',
  },
  // ⚠ The batch cap, said before it is hit.
  capHint: {
    id: 'export.exportView.capHint',
    defaultMessage:
      'Up to {cap, number} documents per export. The file is built while you wait, so a longer period has to be split.',
  },
  capHit: {
    id: 'export.exportView.capHit',
    defaultMessage:
      'That period holds more than {cap, number} Published documents, so no file was written — a short export that looked complete would be worse. Export it a month at a time.',
  },

  /**
   * ⚠ The dead end this closes, reported from the live app: a client with one
   * Published document dated **12 May 2025**, this screen defaulting to last
   * month, and a refusal that said only "nothing". The accountant read it as
   * *published, but it will not export* and concluded the feature was broken.
   *
   * Every fact below comes off the server's own `NT-EXP-001`
   * (`Problem.publishedOutsidePeriod`) — the count and the dates are from the
   * SAME scoped read the exporter runs. This screen must never compute them: a
   * second query here could disagree with the predicate the export actually
   * uses, and would be a second read of a client's records written by someone
   * not looking at the exporter.
   */
  outsidePeriodOne: {
    id: 'export.exportView.outsidePeriodOne',
    defaultMessage:
      'This client has 1 Published document, dated {earliest}. The period picks documents by their own date, not by when they were released — so a document released today but dated last year belongs to last year’s export.',
  },
  outsidePeriodMany: {
    id: 'export.exportView.outsidePeriodMany',
    defaultMessage:
      'This client has {count, number} Published documents dated between {earliest} and {latest}. The period picks documents by their own date, not by when they were released — so a document released today but dated last year belongs to last year’s export.',
  },
  widenAction: {
    id: 'export.exportView.widenAction',
    defaultMessage: 'Use {earliest} – {latest} instead',
  },

  submitVt: { id: 'export.exportView.submitVt', defaultMessage: 'Export for VT' },
  submitCsv: { id: 'export.exportView.submitCsv', defaultMessage: 'Export as CSV' },
  submitting: { id: 'export.exportView.submitting', defaultMessage: 'Building the file…' },

  targetVt: { id: 'export.exportView.targetVt', defaultMessage: 'VT Transaction+ (Universal Input Sheet)' },
  targetCsv: { id: 'export.exportView.targetCsv', defaultMessage: 'Generic CSV' },

  readyHeading: { id: 'export.exportView.readyHeading', defaultMessage: 'Your export is ready' },
  readyCounts: {
    id: 'export.exportView.readyCounts',
    defaultMessage:
      '{rows, plural, one {# row} other {# rows}} in the import file, {documents, plural, one {# source document} other {# source documents}} in the bundle.',
  },
  reconcileNote: {
    id: 'export.exportView.reconcileNote',
    defaultMessage:
      'Check that row count against what VT shows on the Universal Input Sheet before you press Post.',
  },
  downloadFile: { id: 'export.exportView.downloadFile', defaultMessage: 'Download VT import file' },
  downloadFileCsv: { id: 'export.exportView.downloadFileCsv', defaultMessage: 'Download CSV import file' },
  downloadBundle: { id: 'export.exportView.downloadBundle', defaultMessage: 'Download source documents (ZIP)' },
  bundleNote: {
    id: 'export.exportView.bundleNote',
    defaultMessage:
      'Each file in the ZIP is named by the link code that appears in the Entry details column, and manifest.csv is the index.',
  },
  linksExpire: {
    id: 'export.exportView.linksExpire',
    defaultMessage: 'These download links expire in a few minutes. Export again to get fresh ones.',
  },
  importSteps: {
    id: 'export.exportView.importSteps',
    defaultMessage: 'In VT: Transactions → Universal Input Sheet → Import from CSV File.',
  },

  warningsHeading: {
    id: 'export.exportView.warningsHeading',
    defaultMessage: '{count, plural, one {# thing did not travel} other {# things did not travel}}',
  },
  warningsNote: {
    id: 'export.exportView.warningsNote',
    defaultMessage: 'Everything below is in the file or deliberately out of it. Nothing was dropped silently.',
  },

  failureHeading: { id: 'export.exportView.failureHeading', defaultMessage: 'Nothing was exported' },

  historyHeading: { id: 'export.exportView.historyHeading', defaultMessage: 'Export history' },
  historyNote: {
    id: 'export.exportView.historyNote',
    defaultMessage: 'What has already been exported, so a month is not imported twice.',
  },
  historyEmpty: {
    id: 'export.exportView.historyEmpty',
    defaultMessage: 'Nothing has been exported for this client yet. Pick a period above and export it.',
  },
  historyLoading: { id: 'export.exportView.historyLoading', defaultMessage: 'Loading export history…' },
  historyError: { id: 'export.exportView.historyError', defaultMessage: 'Export history could not be loaded' },
  historyRow: {
    id: 'export.exportView.historyRow',
    defaultMessage: '{from} to {to}',
  },
  historyRowCount: {
    id: 'export.exportView.historyRowCount',
    defaultMessage: '{rows, plural, one {# row} other {# rows}}',
  },
  historyNoDownload: {
    id: 'export.exportView.historyNoDownload',
    defaultMessage: 'Download links are short-lived, so history keeps none. Export the period again for a fresh file.',
  },

  syntheticNote: {
    id: 'export.exportView.syntheticNote',
    defaultMessage:
      'This preview is running on sample data, so there is nothing real to export. Sign in to the live workspace to export a client.',
  },
  noClientsNote: {
    id: 'export.exportView.noClientsNote',
    defaultMessage: 'Add a client before exporting — an export covers one client business at a time.',
  },
});

const TARGET_LABEL: Record<ExportTarget, MessageDescriptor> = {
  VT_TRANSACTION_PLUS: m.targetVt,
  GENERIC_CSV: m.targetCsv,
};

const TARGETS: ExportTarget[] = ['VT_TRANSACTION_PLUS', 'GENERIC_CSV'];

/** `YYYY-MM-DD` → `DD/MM/YYYY`. Rule 8: UK d/m/y on screen, ISO on the wire. */
function ukDate(calendarDate: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate ?? '');
  return match === null ? (calendarDate ?? '') : `${match[3]}/${match[2]}/${match[1]}`;
}

const FIELD_CLASS =
  'w-full px-4 py-3 rounded-2xl bg-raised border border-white/10 text-[13px] font-semibold text-white ' +
  'focus:outline-none focus:border-brand/50 disabled:opacity-40 disabled:cursor-not-allowed';

const LABEL_CLASS = 'block text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-2';

export function ExportView() {
  const intl = useIntl();
  // `slices` is deliberately not read: there is no `exports` member on
  // `SliceName`, and there should not be. The context arrays are the demo
  // route's, and an export is not one of them — this view computes its own
  // status from its own query (the `ChasesView` model), which is also what
  // keeps `api/exports.ts` off the bundle floor.
  const { session, businesses } = useAppContext();
  const liveOn = API_ENABLED && session.status === 'authenticated';

  const initialPeriod = useMemo(() => previousCalendarMonth(), []);
  const [businessId, setBusinessId] = useState('');
  const [periodStart, setPeriodStart] = useState(initialPeriod.periodStart);
  const [periodEnd, setPeriodEnd] = useState(initialPeriod.periodEnd);
  const [target, setTarget] = useState<ExportTarget>('VT_TRANSACTION_PLUS');

  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<Export | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [capHit, setCapHit] = useState(false);
  /**
   * The server's answer to "nothing? then where ARE my documents?" — the
   * `NT-EXP-001` extension member, carried through `NtProblemError`. Null on
   * every other refusal, and null when the client genuinely has nothing
   * Published, which is a different sentence and gets no hint.
   */
  const [outside, setOutside] = useState<NtProblemError['publishedOutsidePeriod']>(undefined);

  const history = useExportHistory({ enabled: liveOn && businessId !== '', businessId: businessId || undefined });
  const historyStatus = sliceStatus(liveOn && businessId !== '', history);

  const canSubmit = liveOn && businessId !== '' && periodStart !== '' && periodEnd !== '' && !building;

  /**
   * The refusal's dates, in the two forms the screen needs: `DD/MM/YYYY` to
   * read, and `YYYY-MM-DD` to put back in the two date inputs.
   *
   * Null unless the server sent both bounds — a count with no dates means every
   * one of those documents is undated, and there is no period a widening could
   * reach, so the plain refusal stands on its own.
   */
  const outsideSpan = useMemo(() => {
    if (outside === undefined) return null;
    const earliest = outside.earliestDocumentDate ?? null;
    const latest = outside.latestDocumentDate ?? null;
    if (earliest === null || latest === null) return null;
    return {
      count: outside.count,
      earliest: ukDate(earliest),
      latest: ukDate(latest),
      startIso: earliest,
      endIso: latest,
    };
  }, [outside]);

  async function onExport() {
    setBuilding(true);
    setResult(null);
    setFailure(null);
    setCapHit(false);
    setOutside(undefined);
    try {
      const created = await requestExport({ businessId, target, periodStart, periodEnd });
      setResult(created);
      await history.refetch();
    } catch (error) {
      // The `NT-` code stays in front of the words — it is what the screen, a
      // log line and a bug report have in common (frontend ten, item 5).
      setFailure(errorLabel(error));
      // On the CODE, not on the words. `NtProblemError.message` is the
      // problem's `detail`, which is prose the server is free to reword; the
      // `NT-` code is the stable half and is what the runbook is keyed on.
      setCapHit(error instanceof NtProblemError && error.code === 'NT-EXP-003');
      // Read off the problem, never computed here. The exporter is the only
      // thing that knows its own predicate, so it is the only thing allowed to
      // answer where the documents are.
      setOutside(error instanceof NtProblemError ? error.publishedOutsidePeriod : undefined);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-y-auto">
      <header className="px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
            <Download size={22} />
          </div>
          <div>
            <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">
              {intl.formatMessage(m.heading)}
            </h1>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
              {intl.formatMessage(m.subheading)}
            </p>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-10 pb-10 flex flex-col gap-5 max-w-3xl">
        {/* ⚠ D42, stated once, above everything. */}
        <p className="text-[13px] leading-relaxed text-zinc-400 px-5 py-4 rounded-2xl bg-white/[0.03] border border-white/10">
          {intl.formatMessage(m.d42Note)}
        </p>

        {!liveOn && (
          <div className="flex items-start gap-3 px-5 py-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 text-[13px] font-semibold text-amber-300">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>{intl.formatMessage(m.syntheticNote)}</span>
          </div>
        )}

        {liveOn && businesses.length === 0 && (
          <div className="flex items-start gap-3 px-5 py-4 rounded-2xl border border-white/10 bg-white/[0.03] text-[13px] font-semibold text-zinc-400">
            <Building2 size={15} className="shrink-0 mt-0.5" />
            <span>{intl.formatMessage(m.noClientsNote)}</span>
          </div>
        )}

        <section className="rounded-3xl bg-card border border-white/5 p-5 md:p-6 shadow-lg flex flex-col gap-5">
          <div>
            <label className={LABEL_CLASS} htmlFor="export-client">
              {intl.formatMessage(m.clientLabel)}
            </label>
            <select
              id="export-client"
              className={FIELD_CLASS}
              value={businessId}
              disabled={!liveOn}
              onChange={(event) => {
                setBusinessId(event.target.value);
                setResult(null);
                setFailure(null);
              }}
            >
              <option value="">{intl.formatMessage(m.clientPlaceholder)}</option>
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={LABEL_CLASS} htmlFor="export-from">
                {intl.formatMessage(m.fromLabel)}
              </label>
              <input
                id="export-from"
                type="date"
                className={FIELD_CLASS}
                value={periodStart}
                disabled={!liveOn}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="export-to">
                {intl.formatMessage(m.toLabel)}
              </label>
              <input
                id="export-to"
                type="date"
                className={FIELD_CLASS}
                value={periodEnd}
                disabled={!liveOn}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="export-target">
                {intl.formatMessage(m.formatLabel)}
              </label>
              <select
                id="export-target"
                className={FIELD_CLASS}
                value={target}
                disabled={!liveOn}
                onChange={(event) => setTarget(event.target.value as ExportTarget)}
              >
                {TARGETS.map((value) => (
                  <option key={value} value={value}>
                    {intl.formatMessage(TARGET_LABEL[value])}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-[12px] text-zinc-500 font-medium">{intl.formatMessage(m.periodHint)}</p>
          {/* ⚠ The cap, before it is hit. */}
          <p className="text-[12px] text-zinc-500 font-medium">
            {intl.formatMessage(m.capHint, { cap: EXPORT_BATCH_CAP })}
          </p>

          <div>
            <button
              type="button"
              onClick={() => void onExport()}
              disabled={!canSubmit}
              className="flex items-center gap-2 px-6 py-3 bg-brand text-brand-on text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-cta-soft disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {building ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {building
                ? intl.formatMessage(m.submitting)
                : intl.formatMessage(target === 'GENERIC_CSV' ? m.submitCsv : m.submitVt)}
            </button>
          </div>
        </section>

        {/* Failure, with the NT- code in front of the words. */}
        <div aria-live="polite" className="flex flex-col gap-5">
          {failure !== null && (
            <section className="rounded-3xl border border-red-500/20 bg-red-500/10 p-5 md:p-6">
              <h2 className="flex items-center gap-2 text-[14px] font-bold text-red-200">
                <AlertTriangle size={16} className="shrink-0" />
                {intl.formatMessage(m.failureHeading)}
              </h2>
              <p className="mt-2 text-[13px] font-semibold text-red-300">{failure}</p>
              {capHit && (
                <p className="mt-2 text-[13px] font-medium text-red-300/80">
                  {intl.formatMessage(m.capHit, { cap: EXPORT_BATCH_CAP })}
                </p>
              )}
              {outsideSpan !== null && (
                <>
                  <p className="mt-2 text-[13px] font-medium text-red-300/80">
                    {outsideSpan.count === 1
                      ? intl.formatMessage(m.outsidePeriodOne, { earliest: outsideSpan.earliest })
                      : intl.formatMessage(m.outsidePeriodMany, {
                          count: outsideSpan.count,
                          earliest: outsideSpan.earliest,
                          latest: outsideSpan.latest,
                        })}
                  </p>
                  {/*
                    The one action that fixes it, with the server's own dates in
                    it. The alternative — telling the accountant to widen the
                    period and leaving them to retype two dates read out of a
                    sentence — is how "nothing to export" stayed a dead end.
                  */}
                  <button
                    type="button"
                    className="mt-3 self-start px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-[13px] font-bold text-white"
                    onClick={() => {
                      setPeriodStart(outsideSpan.startIso);
                      setPeriodEnd(outsideSpan.endIso);
                      setFailure(null);
                      setOutside(undefined);
                    }}
                  >
                    {intl.formatMessage(m.widenAction, { earliest: outsideSpan.earliest, latest: outsideSpan.latest })}
                  </button>
                </>
              )}
            </section>
          )}

          {result !== null && (
            <section className="rounded-3xl bg-card border border-white/5 p-5 md:p-6 shadow-lg flex flex-col gap-4">
              <h2 className="flex items-center gap-2 text-[15px] font-bold text-white">
                <CheckCircle2 size={17} className="shrink-0 text-emerald-400" />
                {intl.formatMessage(m.readyHeading)}
              </h2>
              <p className="text-[13px] font-semibold text-zinc-300">
                {intl.formatMessage(m.readyCounts, {
                  rows: result.rowCount ?? 0,
                  documents: result.documentCount ?? 0,
                })}
              </p>
              <p className="text-[12px] text-zinc-500 font-medium">{intl.formatMessage(m.reconcileNote)}</p>

              <div className="flex flex-col sm:flex-row gap-3">
                {result.file && (
                  <a
                    href={result.file.url}
                    target="_blank"
                    // `noreferrer` is not decoration: the signed URL is bearer
                    // authority over a client's whole month, and a Referer
                    // header would carry it to wherever the tab goes next.
                    rel="noreferrer noopener"
                    className="flex items-center gap-2 px-6 py-3 bg-brand text-brand-on text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-cta-soft"
                  >
                    <FileSpreadsheet size={16} />
                    {intl.formatMessage(target === 'GENERIC_CSV' ? m.downloadFileCsv : m.downloadFile)}
                  </a>
                )}
                {result.bundle && (
                  <a
                    href={result.bundle.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-raised border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
                  >
                    <Archive size={16} />
                    {intl.formatMessage(m.downloadBundle)}
                  </a>
                )}
              </div>

              <p className="text-[12px] text-zinc-500 font-medium">{intl.formatMessage(m.bundleNote)}</p>
              <p className="text-[12px] text-zinc-500 font-medium">{intl.formatMessage(m.importSteps)}</p>
              <p className="text-[12px] text-zinc-500 font-medium">{intl.formatMessage(m.linksExpire)}</p>

              {result.warnings && result.warnings.length > 0 && (
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
                  <h3 className="flex items-center gap-2 text-[13px] font-bold text-amber-300">
                    <AlertTriangle size={14} className="shrink-0" />
                    {intl.formatMessage(m.warningsHeading, { count: result.warnings.length })}
                  </h3>
                  <p className="mt-1 text-[12px] font-medium text-amber-300/80">
                    {intl.formatMessage(m.warningsNote)}
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {result.warnings.map((warning, index) => (
                      <li key={`${warning.code}-${warning.documentId ?? index}`} className="text-[12px] text-amber-200/90 font-medium">
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>

        <section className="rounded-3xl bg-card border border-white/5 p-5 md:p-6 shadow-lg">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-white">
              <History size={17} className="shrink-0" />
              {intl.formatMessage(m.historyHeading)}
            </h2>
            <DataSourceBadge slice="exports" status={historyStatus} onRetry={() => void history.refetch()} />
          </div>
          <p className="mt-1 text-[12px] text-zinc-500 font-medium">{intl.formatMessage(m.historyNote)}</p>

          <div className="mt-4">
            {historyStatus.source === 'error' ? (
              <SliceLoadError
                heading={intl.formatMessage(m.historyError)}
                error={historyStatus.error}
                onRetry={() => void history.refetch()}
              />
            ) : historyStatus.loading ? (
              // Skeletons, never a spinner on a primary surface (frontend ten, item 5).
              <div className="flex flex-col gap-2" aria-label={intl.formatMessage(m.historyLoading)}>
                <div className="h-11 rounded-2xl bg-raised animate-pulse" />
                <div className="h-11 rounded-2xl bg-raised animate-pulse" />
              </div>
            ) : history.exports.length === 0 ? (
              <p className="text-[13px] text-zinc-500 font-medium">{intl.formatMessage(m.historyEmpty)}</p>
            ) : (
              <>
                <ul className="flex flex-col divide-y divide-white/5">
                  {history.exports.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-3 py-3">
                      <span className="text-[13px] font-semibold text-white truncate">
                        {intl.formatMessage(m.historyRow, {
                          from: ukDate(row.periodStart),
                          to: ukDate(row.periodEnd),
                        })}
                      </span>
                      <span className="flex items-center gap-3 shrink-0">
                        <span className="text-[12px] font-semibold text-zinc-400 tabular-nums">
                          {intl.formatMessage(m.historyRowCount, { rows: row.rowCount ?? 0 })}
                        </span>
                        <span className="text-[12px] font-semibold text-zinc-500">
                          {intl.formatMessage(TARGET_LABEL[row.target])}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[12px] text-zinc-500 font-medium">
                  {intl.formatMessage(m.historyNoDownload)}
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
