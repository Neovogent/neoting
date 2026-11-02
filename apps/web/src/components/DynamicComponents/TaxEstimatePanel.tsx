import type { ReactNode } from 'react';
import { AlertTriangle, Printer } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import type { TaxEstimate, TaxEstimateView } from '@neoting/contracts/model';
import { errorLabel } from '../../api/slices';
import { periodPresets, type Country, type EstimateParams } from '../../api/taxEstimate';
import { UkDateField } from './UkDateField';

/**
 * The tax estimate (D52), shared by the accountant's client page and the
 * client's own portal. Presentational: the caller owns the query and the
 * parameters, and says what to show when the add-on is not active.
 *
 * ⚠ **Every surface says it is an estimate that cannot be submitted** — the
 * banner here and the printout both. The figures are the server's; nothing in
 * this file does tax arithmetic.
 */

const m = defineMessages({
  title: { id: 'taxEstimate.panel.title', defaultMessage: 'Tax estimate' },
  banner: {
    id: 'taxEstimate.panel.banner',
    defaultMessage:
      'AI-generated estimate for reference only. It is not a tax return and cannot be submitted to {country, select, AU {the ATO} other {HMRC}}. Check it with your accountant.',
  },
  kindVat: { id: 'taxEstimate.panel.kindVat', defaultMessage: '{country, select, AU {BAS (GST)} other {VAT return}}' },
  kindCompany: { id: 'taxEstimate.panel.kindCompany', defaultMessage: 'Company tax' },
  periodLabel: { id: 'taxEstimate.panel.periodLabel', defaultMessage: 'Period' },
  fromLabel: { id: 'taxEstimate.panel.fromLabel', defaultMessage: 'From' },
  toLabel: { id: 'taxEstimate.panel.toLabel', defaultMessage: 'To' },
  presetThisQuarter: { id: 'taxEstimate.panel.presetThisQuarter', defaultMessage: 'This quarter' },
  presetLastQuarter: { id: 'taxEstimate.panel.presetLastQuarter', defaultMessage: 'Last quarter' },
  presetThisYear: { id: 'taxEstimate.panel.presetThisYear', defaultMessage: 'This income year' },
  presetLastYear: { id: 'taxEstimate.panel.presetLastYear', defaultMessage: 'Last income year' },
  presetLast12Months: { id: 'taxEstimate.panel.presetLast12Months', defaultMessage: 'Last 12 months' },
  schemeLabel: { id: 'taxEstimate.panel.schemeLabel', defaultMessage: 'VAT scheme' },
  schemeStandard: { id: 'taxEstimate.panel.schemeStandard', defaultMessage: 'Standard' },
  schemeFlat: { id: 'taxEstimate.panel.schemeFlat', defaultMessage: 'Flat rate' },
  flatPercentLabel: { id: 'taxEstimate.panel.flatPercentLabel', defaultMessage: 'Flat rate %' },
  loading: { id: 'taxEstimate.panel.loading', defaultMessage: 'Working out the estimate…' },
  failed: { id: 'taxEstimate.panel.failed', defaultMessage: 'The estimate could not be loaded: {reason}' },
  vatToPay: { id: 'taxEstimate.panel.vatToPay', defaultMessage: '{country, select, AU {GST} other {VAT}} to pay' },
  vatToReclaim: { id: 'taxEstimate.panel.vatToReclaim', defaultMessage: '{country, select, AU {GST} other {VAT}} to reclaim' },
  companyTax: { id: 'taxEstimate.panel.companyTax', defaultMessage: '{country, select, AU {Company tax} other {Corporation Tax}}' },
  range: { id: 'taxEstimate.panel.range', defaultMessage: 'Likely between {low} and {high}' },
  rangeReclaim: { id: 'taxEstimate.panel.rangeReclaim', defaultMessage: 'Likely between {low} and {high} to reclaim' },
  rangeMixed: { id: 'taxEstimate.panel.rangeMixed', defaultMessage: 'Likely anywhere from {reclaim} to reclaim to {pay} to pay' },
  rangeNote: {
    id: 'taxEstimate.panel.rangeNote',
    defaultMessage: 'A range, not one number: money in the bank with no receipt or invoice could change the result either way.',
  },
  score: { id: 'taxEstimate.panel.score', defaultMessage: '{percent}% complete' },
  scoreCoverage: { id: 'taxEstimate.panel.scoreCoverage', defaultMessage: 'Bank statements cover the period' },
  scoreEvidenced: { id: 'taxEstimate.panel.scoreEvidenced', defaultMessage: 'Bank money with a receipt or invoice' },
  scoreReviewed: { id: 'taxEstimate.panel.scoreReviewed', defaultMessage: 'Documents reviewed by a person' },
  formTitle: { id: 'taxEstimate.panel.formTitle', defaultMessage: '{country, select, AU {The BAS labels} other {The VAT return boxes}}' },
  computationTitle: { id: 'taxEstimate.panel.computationTitle', defaultMessage: 'How it is worked out' },
  notesTitle: { id: 'taxEstimate.panel.notesTitle', defaultMessage: 'What affects this estimate' },
  assumptionsTitle: { id: 'taxEstimate.panel.assumptionsTitle', defaultMessage: 'Assumptions' },
  documentsTitle: {
    id: 'taxEstimate.panel.documentsTitle',
    defaultMessage: '{count, plural, one {# document counted} other {# documents counted}}',
  },
  colDate: { id: 'taxEstimate.panel.colDate', defaultMessage: 'Date' },
  colDocument: { id: 'taxEstimate.panel.colDocument', defaultMessage: 'Document' },
  colTreatment: { id: 'taxEstimate.panel.colTreatment', defaultMessage: 'Treated as' },
  colTotal: { id: 'taxEstimate.panel.colTotal', defaultMessage: 'Total' },
  colTax: { id: 'taxEstimate.panel.colTax', defaultMessage: '{country, select, AU {GST} other {VAT}}' },
  notApplicable: { id: 'taxEstimate.panel.notApplicable', defaultMessage: 'No estimate for this client' },
  print: { id: 'taxEstimate.panel.print', defaultMessage: 'Print or save as PDF' },
  printPeriod: { id: 'taxEstimate.panel.printPeriod', defaultMessage: 'Period {start} to {end}' },
});

export interface TaxEstimatePanelProps {
  readonly country: Country;
  readonly view: TaxEstimateView | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly params: EstimateParams;
  readonly onParams: (next: EstimateParams) => void;
  /** Shown instead of the estimate when the add-on is not active. */
  readonly inactive: ReactNode;
  /** Who the printout names, e.g. the business name. */
  readonly subject: string;
}

const PRESET_LABEL = {
  thisQuarter: m.presetThisQuarter,
  lastQuarter: m.presetLastQuarter,
  thisYear: m.presetThisYear,
  lastYear: m.presetLastYear,
  last12Months: m.presetLast12Months,
} as const;

export function TaxEstimatePanel({ country, view, loading, error, params, onParams, inactive, subject }: TaxEstimatePanelProps) {
  const intl = useIntl();
  const estimate = view?.estimate ?? null;
  const shownCountry: Country = estimate?.country ?? country;
  const presets = periodPresets(shownCountry, params.kind, new Date());
  const fault = errorLabel(error);

  const setKind = (kind: EstimateParams['kind']) => {
    // VAT/BAS: the last completed quarter (as `initialParams`); company tax: the first preset.
    const options = periodPresets(shownCountry, kind, new Date());
    const first = kind === 'VAT' ? options[1] : options[0];
    onParams({ ...params, kind, periodStart: first?.start ?? params.periodStart, periodEnd: first?.end ?? params.periodEnd });
  };

  return (
    <section className="flex flex-col gap-4" data-tour="tax-estimate">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">{intl.formatMessage(m.title)}</h2>
        {estimate !== null && (
          <button
            type="button"
            onClick={() => printEstimate(intl, estimate, subject)}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-raised px-4 py-2 text-[13px] font-semibold text-zinc-200 hover:bg-card"
          >
            <Printer size={15} aria-hidden="true" />
            {intl.formatMessage(m.print)}
          </button>
        )}
      </div>

      {/* The LapsedSubscriptionNotice pattern: amber tint and icon, neutral ink —
          `text-amber-*` has no light-theme override and reads ~2.6:1 there. */}
      <p role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-[13px] font-medium text-zinc-200">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
        <span>{intl.formatMessage(m.banner, { country: shownCountry })}</span>
      </p>

      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-card p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label={intl.formatMessage(m.title)}>
          {(['VAT', 'COMPANY_TAX'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={params.kind === kind}
              onClick={() => setKind(kind)}
              className={`rounded-full px-4 py-2 text-[13px] font-semibold ${
                params.kind === kind ? 'bg-brand text-brand-on' : 'bg-raised text-zinc-300 hover:bg-ground'
              }`}
            >
              {kind === 'VAT' ? intl.formatMessage(m.kindVat, { country: shownCountry }) : intl.formatMessage(m.kindCompany)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500">{intl.formatMessage(m.periodLabel)}</span>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={params.periodStart === p.start && params.periodEnd === p.end}
                  onClick={() => onParams({ ...params, periodStart: p.start, periodEnd: p.end })}
                  className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                    params.periodStart === p.start && params.periodEnd === p.end
                      ? 'bg-brand text-brand-on'
                      : 'bg-raised text-zinc-300 hover:bg-ground'
                  }`}
                >
                  {intl.formatMessage(PRESET_LABEL[p.key])}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1 text-[12px] text-zinc-400" htmlFor="tax-estimate-from">
            {intl.formatMessage(m.fromLabel)}
            <UkDateField id="tax-estimate-from" value={params.periodStart} onChange={(v) => {
                if (v !== '') onParams({ ...params, periodStart: v });
              }} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-zinc-400" htmlFor="tax-estimate-to">
            {intl.formatMessage(m.toLabel)}
            <UkDateField id="tax-estimate-to" value={params.periodEnd} onChange={(v) => {
                if (v !== '') onParams({ ...params, periodEnd: v });
              }} />
          </label>
          {shownCountry === 'GB' && params.kind === 'VAT' && (
            <SchemeControl params={params} onParams={onParams} />
          )}
        </div>
      </div>

      {fault !== null ? (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">
          {intl.formatMessage(m.failed, { reason: fault })}
        </p>
      ) : loading || view === undefined ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label={intl.formatMessage(m.loading)}>
          <div className="h-32 animate-pulse rounded-2xl bg-raised" />
          <div className="h-48 animate-pulse rounded-2xl bg-raised" />
        </div>
      ) : !view.active || estimate === null ? (
        inactive
      ) : (
        <EstimateBody estimate={estimate} />
      )}
    </section>
  );
}

function SchemeControl({ params, onParams }: { params: EstimateParams; onParams: (next: EstimateParams) => void }) {
  const intl = useIntl();
  const flat = params.vatScheme === 'FLAT_RATE';
  return (
    <div className="flex items-end gap-2">
      <label className="flex flex-col gap-1 text-[12px] text-zinc-400" htmlFor="tax-estimate-scheme">
        {intl.formatMessage(m.schemeLabel)}
        <select
          id="tax-estimate-scheme"
          value={flat ? 'FLAT_RATE' : 'STANDARD'}
          onChange={(e) =>
            onParams(
              e.target.value === 'FLAT_RATE'
                ? { ...params, vatScheme: 'FLAT_RATE', flatRateBasisPoints: params.flatRateBasisPoints ?? 1650 }
                : { kind: params.kind, periodStart: params.periodStart, periodEnd: params.periodEnd },
            )
          }
          className="rounded-lg border border-white/10 bg-ground px-3 py-2 text-[13px] text-white"
        >
          <option value="STANDARD">{intl.formatMessage(m.schemeStandard)}</option>
          <option value="FLAT_RATE">{intl.formatMessage(m.schemeFlat)}</option>
        </select>
      </label>
      {flat && (
        <label className="flex flex-col gap-1 text-[12px] text-zinc-400" htmlFor="tax-estimate-flat">
          {intl.formatMessage(m.flatPercentLabel)}
          <input
            id="tax-estimate-flat"
            type="number"
            min={1}
            max={100}
            step={0.5}
            value={(params.flatRateBasisPoints ?? 1650) / 100}
            onChange={(e) => {
              const bps = Math.round(Number(e.target.value) * 100);
              if (bps >= 1 && bps <= 10000) onParams({ ...params, flatRateBasisPoints: bps });
            }}
            className="w-24 rounded-lg border border-white/10 bg-ground px-3 py-2 text-[13px] text-white"
          />
        </label>
      )}
    </div>
  );
}

function money(intl: IntlShape, pence: number, currency: string): string {
  return intl.formatNumber(pence / 100, { style: 'currency', currency });
}

/**
 * The range in words. VAT/GST can be a reclaim (negative), so a range of
 * reclaims reads as amounts to reclaim, and one that crosses zero says both.
 */
function rangeText(intl: IntlShape, e: TaxEstimate): string | null {
  const low = Math.min(e.result.lowPence, e.result.highPence);
  const high = Math.max(e.result.lowPence, e.result.highPence);
  if (low === high) return null;
  const fmt = (pence: number) => money(intl, pence, e.currency);
  if (e.kind === 'VAT' && high <= 0) return intl.formatMessage(m.rangeReclaim, { low: fmt(-high), high: fmt(-low) });
  if (e.kind === 'VAT' && low < 0) return intl.formatMessage(m.rangeMixed, { reclaim: fmt(-low), pay: fmt(high) });
  return intl.formatMessage(m.range, { low: fmt(low), high: fmt(high) });
}

function resultLabel(intl: IntlShape, e: TaxEstimate): string {
  if (e.kind === 'COMPANY_TAX') return intl.formatMessage(m.companyTax, { country: e.country });
  return intl.formatMessage(e.result.amountPence < 0 ? m.vatToReclaim : m.vatToPay, { country: e.country });
}

function EstimateBody({ estimate: e }: { estimate: TaxEstimate }) {
  const intl = useIntl();
  const fmt = (pence: number) => money(intl, pence, e.currency);
  const c = e.completeness;

  if (!e.applicable) {
    return (
      <div className="rounded-2xl border border-white/10 bg-card p-5">
        <h3 className="text-[15px] font-semibold text-white">{intl.formatMessage(m.notApplicable)}</h3>
        {e.notes.map((note) => (
          <p key={note} className="mt-2 text-[13px] leading-relaxed text-zinc-300">
            {note}
          </p>
        ))}
      </div>
    );
  }

  const range = rangeText(intl, e);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-card p-5">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-zinc-500">{resultLabel(intl, e)}</p>
          <p className="mt-1 text-3xl font-bold text-white">{fmt(Math.abs(e.result.amountPence))}</p>
          {range !== null && <p className="mt-2 text-[14px] text-zinc-300">{range}</p>}
          <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">{intl.formatMessage(m.rangeNote)}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-card p-5">
          <p className="text-2xl font-bold text-white">{intl.formatMessage(m.score, { percent: c.scorePercent })}</p>
          <Meter label={intl.formatMessage(m.scoreCoverage)} percent={c.statementCoveragePercent} />
          <Meter label={intl.formatMessage(m.scoreEvidenced)} percent={c.evidencedPercent} />
          <Meter label={intl.formatMessage(m.scoreReviewed)} percent={c.reviewedPercent} />
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-card p-5">
        <h3 className="mb-3 text-[15px] font-semibold text-white">
          {e.kind === 'VAT' ? intl.formatMessage(m.formTitle, { country: e.country }) : intl.formatMessage(m.computationTitle)}
        </h3>
        <table className="w-full text-[13px]">
          <tbody>
            {e.figures.map((f) => (
              <tr key={f.code} className="border-t border-white/5">
                <td className="w-16 py-2 pr-3 font-mono text-zinc-500">{e.kind === 'VAT' ? f.code : ''}</td>
                <td className="py-2 pr-3 text-zinc-300">{f.label}</td>
                <td className="py-2 text-right font-semibold tabular-nums text-white">{fmt(f.amountPence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {e.notes.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-card p-5">
          <h3 className="mb-2 text-[15px] font-semibold text-white">{intl.formatMessage(m.notesTitle)}</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-zinc-300">
            {e.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="rounded-2xl border border-white/10 bg-card p-5">
        <summary className="cursor-pointer text-[15px] font-semibold text-white">{intl.formatMessage(m.assumptionsTitle)}</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-zinc-400">
          {e.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>

      <details className="rounded-2xl border border-white/10 bg-card p-5">
        <summary className="cursor-pointer text-[15px] font-semibold text-white">
          {intl.formatMessage(m.documentsTitle, { count: e.lines.length })}
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="text-left text-[12px] text-zinc-500">
                <th className="py-1 pr-3 font-semibold">{intl.formatMessage(m.colDate)}</th>
                <th className="py-1 pr-3 font-semibold">{intl.formatMessage(m.colDocument)}</th>
                <th className="py-1 pr-3 font-semibold">{intl.formatMessage(m.colTreatment)}</th>
                <th className="py-1 pr-3 text-right font-semibold">{intl.formatMessage(m.colTotal)}</th>
                <th className="py-1 text-right font-semibold">{intl.formatMessage(m.colTax, { country: e.country })}</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.documentId} className="border-t border-white/5">
                  <td className="py-2 pr-3 text-zinc-400">{intl.formatDate(`${l.date}T00:00:00Z`, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</td>
                  <td className="py-2 pr-3 text-zinc-200">{l.label}</td>
                  <td className="py-2 pr-3 text-zinc-400">{l.treatment}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-200">{fmt(l.grossPence)}</td>
                  <td className="py-2 text-right tabular-nums text-zinc-200">{fmt(l.taxPence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Meter({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="mt-3">
      <div className="flex justify-between text-[12px] text-zinc-400">
        <span>{label}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised" role="presentation">
        <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

/**
 * A plain printable page in a new window — the browser's own "Save as PDF" is
 * the PDF. Carries the same not-submittable statement as the screen, and every
 * string is escaped (labels and notes are server text, document names came
 * from strangers' invoices). Black on white in both themes, like the QR code:
 * it is paper, and the app's colour tokens do not exist in that window.
 */
function printEstimate(intl: IntlShape, e: TaxEstimate, subject: string): void {
  const win = window.open('', '_blank', 'width=820,height=1000');
  if (win === null) return;
  const fmt = (pence: number) => escapeHtml(money(intl, pence, e.currency));
  const range = rangeText(intl, e);
  const rows = e.figures
    .map((f) => `<tr><td>${e.kind === 'VAT' ? escapeHtml(f.code) : ''}</td><td>${escapeHtml(f.label)}</td><td class="n">${fmt(f.amountPence)}</td></tr>`)
    .join('');
  const list = (items: readonly string[]) => items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const title = `${intl.formatMessage(m.title)} · ${subject}`;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}
.warn{border:2px solid #b45309;background:#fef3c7;padding:10px 12px;margin:12px 0;font-weight:600}
table{border-collapse:collapse;width:100%;margin:12px 0}td{border-bottom:1px solid #ddd;padding:6px 8px}.n{text-align:right;white-space:nowrap}
.big{font-size:26px;font-weight:700;margin:4px 0}</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div>${escapeHtml(intl.formatMessage(m.printPeriod, { start: e.periodStart, end: e.periodEnd }))}</div>
<div class="warn">${escapeHtml(intl.formatMessage(m.banner, { country: e.country }))}</div>
<div>${escapeHtml(resultLabel(intl, e))}</div><div class="big">${fmt(Math.abs(e.result.amountPence))}</div>
<div>${range === null ? '' : `${escapeHtml(range)} · `}${escapeHtml(intl.formatMessage(m.score, { percent: e.completeness.scorePercent }))}</div>
<table>${rows}</table>
<h2>${escapeHtml(intl.formatMessage(m.notesTitle))}</h2><ul>${list(e.notes)}</ul>
<h2>${escapeHtml(intl.formatMessage(m.assumptionsTitle))}</h2><ul>${list(e.assumptions)}</ul>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}
