import { useState } from 'react';
import { AlertTriangle, CheckCircle2, UploadCloud } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import {
  createImport,
  IMPORT_FIELDS,
  stageImportFile,
  VAULT_MAX_BYTES,
  type ImportField,
  type ImportMapping,
  type ImportResult,
  type ImportSource,
} from '../../api/practiceVault';
import { currency } from '../../lib/resolver';

/**
 * Bring a client's history over from another capture tool (Dext, Hubdoc,
 * AutoEntry, Datamolino or any CSV): their export CSV plus the images, or one
 * ZIP holding both. Every file is staged, the server maps the columns and
 * pairs each row with its image, and ONE itemised `document.import` proposal
 * is created — nothing becomes a document until it is approved in Approvals.
 */

const m = defineMessages({
  title: { id: 'imports.bundleDialog.title', defaultMessage: 'Import from another capture tool' },
  lead: {
    id: 'imports.bundleDialog.lead',
    defaultMessage:
      'Choose the export from Dext, Hubdoc, AutoEntry or Datamolino — the CSV and its images or PDFs, or a single ZIP holding both. Each row becomes a document with its fields filled in, once the import is approved.',
  },
  source: { id: 'imports.bundleDialog.source', defaultMessage: 'Exported from' },
  files: { id: 'imports.bundleDialog.files', defaultMessage: 'Files' },
  filesChosen: { id: 'imports.bundleDialog.filesChosen', defaultMessage: '{count, plural, one {# file chosen} other {# files chosen}}' },
  submit: { id: 'imports.bundleDialog.submit', defaultMessage: 'Upload and prepare import' },
  working: { id: 'imports.bundleDialog.working', defaultMessage: 'Uploading {done} of {total}…' },
  preparing: { id: 'imports.bundleDialog.preparing', defaultMessage: 'Reading the export…' },
  tooBig: { id: 'imports.bundleDialog.tooBig', defaultMessage: '{name} is over the 100 MB limit.' },
  staged: {
    id: 'imports.bundleDialog.staged',
    defaultMessage:
      '{count, plural, one {# document is} other {# documents are}} ready for approval ({images} with an image). Nothing is created until the import is approved.',
  },
  openApprovals: { id: 'imports.bundleDialog.openApprovals', defaultMessage: 'Open Approvals' },
  warnings: { id: 'imports.bundleDialog.warnings', defaultMessage: 'Worth checking' },
  mapping: { id: 'imports.bundleDialog.mapping', defaultMessage: 'Column mapping' },
  mappingHint: {
    id: 'imports.bundleDialog.mappingHint',
    defaultMessage: 'Wrong column picked, or one missed? Choose it here and prepare the import again.',
  },
  notMapped: { id: 'imports.bundleDialog.notMapped', defaultMessage: '— not in this file —' },
  remap: { id: 'imports.bundleDialog.remap', defaultMessage: 'Prepare again with this mapping' },
  colRow: { id: 'imports.bundleDialog.colRow', defaultMessage: 'Row' },
  colSupplier: { id: 'imports.bundleDialog.colSupplier', defaultMessage: 'Supplier' },
  colDate: { id: 'imports.bundleDialog.colDate', defaultMessage: 'Date' },
  colTotal: { id: 'imports.bundleDialog.colTotal', defaultMessage: 'Total' },
  colImage: { id: 'imports.bundleDialog.colImage', defaultMessage: 'Image' },
  yes: { id: 'imports.bundleDialog.yes', defaultMessage: 'Yes' },
  no: { id: 'imports.bundleDialog.no', defaultMessage: 'No' },
  moreRows: { id: 'imports.bundleDialog.moreRows', defaultMessage: '…and {count} more in the approval.' },
  close: { id: 'imports.bundleDialog.close', defaultMessage: 'Close' },
});

const SOURCES = defineMessages({
  dext: { id: 'imports.bundleDialog.sourceDext', defaultMessage: 'Dext' },
  hubdoc: { id: 'imports.bundleDialog.sourceHubdoc', defaultMessage: 'Hubdoc' },
  autoentry: { id: 'imports.bundleDialog.sourceAutoentry', defaultMessage: 'AutoEntry' },
  datamolino: { id: 'imports.bundleDialog.sourceDatamolino', defaultMessage: 'Datamolino' },
  generic: { id: 'imports.bundleDialog.sourceGeneric', defaultMessage: 'Other (any CSV)' },
});

const FIELD_LABEL = defineMessages({
  date: { id: 'imports.bundleDialog.fieldDate', defaultMessage: 'Date' },
  supplier: { id: 'imports.bundleDialog.fieldSupplier', defaultMessage: 'Supplier' },
  reference: { id: 'imports.bundleDialog.fieldReference', defaultMessage: 'Reference' },
  net: { id: 'imports.bundleDialog.fieldNet', defaultMessage: 'Net' },
  vat: { id: 'imports.bundleDialog.fieldVat', defaultMessage: 'VAT' },
  total: { id: 'imports.bundleDialog.fieldTotal', defaultMessage: 'Total' },
  category: { id: 'imports.bundleDialog.fieldCategory', defaultMessage: 'Category' },
  description: { id: 'imports.bundleDialog.fieldDescription', defaultMessage: 'Description' },
  image: { id: 'imports.bundleDialog.fieldImage', defaultMessage: 'Image filename' },
  currency: { id: 'imports.bundleDialog.fieldCurrency', defaultMessage: 'Currency' },
});

const PREVIEW_ROWS = 50;

/** Integer pence → the display string. The division is display-only. */
const pounds = (pence: number | null) => (pence === null ? '—' : currency(pence / 100));

export default function ImportBundleDialog({
  businessId,
  onClose,
  onOpenApprovals,
}: {
  businessId: string;
  onClose: () => void;
  onOpenApprovals: () => void;
}) {
  const intl = useIntl();
  const [source, setSource] = useState<ImportSource>('dext');
  const [files, setFiles] = useState<File[]>([]);
  const [uploadKeys, setUploadKeys] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});

  const prepare = async (withMapping?: ImportMapping) => {
    setError(null);
    try {
      let keys = uploadKeys;
      if (keys === null) {
        const tooBig = files.find((file) => file.size > VAULT_MAX_BYTES);
        if (tooBig !== undefined) throw new Error(intl.formatMessage(m.tooBig, { name: tooBig.name }));
        keys = [];
        for (const [i, file] of files.entries()) {
          setProgress(intl.formatMessage(m.working, { done: i + 1, total: files.length }));
          keys.push(await stageImportFile(businessId, file));
        }
        // Staged once: a re-mapping re-reads the same objects instead of uploading again.
        setUploadKeys(keys);
      }
      setProgress(intl.formatMessage(m.preparing));
      const created = await createImport({
        businessId,
        source,
        uploadKeys: keys,
        ...(withMapping === undefined ? {} : { mapping: withMapping }),
      });
      setResult(created);
      setMapping(
        Object.fromEntries(
          Object.entries(created.mapping).filter((entry): entry is [string, string] => entry[1] !== null),
        ) as ImportMapping,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProgress(null);
    }
  };

  const select = 'w-full rounded-xl border border-white/10 bg-raised px-3 py-2 text-[13px] text-white';

  return (
    <div className="w-full max-w-3xl rounded-[28px] border border-white/5 bg-card p-6 shadow-2xl">
      <h2 className="text-[16px] font-bold text-white">{intl.formatMessage(m.title)}</h2>
      <p className="mt-1 text-[12px] text-zinc-400">{intl.formatMessage(m.lead)}</p>

      {result === null && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-[12px] text-zinc-400">
            {intl.formatMessage(m.source)}
            <select className={select} value={source} onChange={(e) => setSource(e.target.value as ImportSource)}>
              {(Object.keys(SOURCES) as ImportSource[]).map((key) => (
                <option key={key} value={key}>{intl.formatMessage(SOURCES[key])}</option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-zinc-400">
            {intl.formatMessage(m.files)}
            <input
              type="file"
              multiple
              accept=".csv,.zip,.pdf,.jpg,.jpeg,.png,.heic,.tif,.tiff"
              className={select}
              onChange={(e) => {
                setFiles(e.target.files === null ? [] : Array.from(e.target.files));
                setUploadKeys(null);
              }}
            />
            {files.length > 0 && <span className="mt-1 block">{intl.formatMessage(m.filesChosen, { count: files.length })}</span>}
          </label>
          <div className="sm:col-span-2">
            <button
              type="button"
              disabled={files.length === 0 || progress !== null}
              onClick={() => void prepare()}
              className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-brand-on hover:bg-brand-hover disabled:opacity-40"
            >
              <UploadCloud size={16} aria-hidden />
              {progress ?? intl.formatMessage(m.submit)}
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-[12px] text-red-400">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {result !== null && (
        <div className="mt-4 flex flex-col gap-4">
          <p role="status" className="flex items-start gap-2 text-[13px] text-emerald-400">
            <CheckCircle2 size={16} aria-hidden className="mt-0.5 shrink-0" />
            {intl.formatMessage(m.staged, { count: result.rowCount, images: result.matchedImages })}
          </p>

          {result.warnings.length > 0 && (
            <div className="rounded-2xl border border-amber-400/30 p-3">
              <p className="text-[12px] font-bold text-amber-400">{intl.formatMessage(m.warnings)}</p>
              <ul className="mt-1 list-disc pl-5 text-[12px] text-zinc-300">
                {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px] text-zinc-300">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-3">{intl.formatMessage(m.colRow)}</th>
                  <th className="py-1 pr-3">{intl.formatMessage(m.colSupplier)}</th>
                  <th className="py-1 pr-3">{intl.formatMessage(m.colDate)}</th>
                  <th className="py-1 pr-3 text-right">{intl.formatMessage(m.colTotal)}</th>
                  <th className="py-1">{intl.formatMessage(m.colImage)}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, PREVIEW_ROWS).map((row) => (
                  <tr key={row.rowNumber} className="border-t border-white/5">
                    <td className="py-1 pr-3">{row.rowNumber}</td>
                    <td className="py-1 pr-3">{row.supplierName ?? '—'}</td>
                    <td className="py-1 pr-3">{row.documentDate ?? '—'}</td>
                    <td className="py-1 pr-3 text-right">{pounds(row.totalPence)}</td>
                    <td className="py-1">{intl.formatMessage(row.hasImage ? m.yes : m.no)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.rows.length > PREVIEW_ROWS && (
              <p className="mt-1 text-[11px] text-zinc-500">
                {intl.formatMessage(m.moreRows, { count: result.rows.length - PREVIEW_ROWS })}
              </p>
            )}
          </div>

          {result.columns.length > 0 && (
            <details className="rounded-2xl border border-white/5 p-3" open={result.warnings.length > 0}>
              <summary className="cursor-pointer text-[12px] font-bold text-zinc-200">{intl.formatMessage(m.mapping)}</summary>
              <p className="mt-1 text-[11px] text-zinc-500">{intl.formatMessage(m.mappingHint)}</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {IMPORT_FIELDS.map((field: ImportField) => (
                  <label key={field} className="text-[11px] text-zinc-400">
                    {intl.formatMessage(FIELD_LABEL[field])}
                    <select
                      className={select}
                      value={mapping[field] ?? ''}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (e.target.value === '') delete next[field];
                        else next[field] = e.target.value;
                        setMapping(next);
                      }}
                    >
                      <option value="">{intl.formatMessage(m.notMapped)}</option>
                      {result.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={progress !== null}
                onClick={() => void prepare(mapping)}
                className="mt-3 rounded-full border border-white/10 px-4 py-1.5 text-[12px] font-semibold text-zinc-200 hover:bg-raised disabled:opacity-40"
              >
                {progress ?? intl.formatMessage(m.remap)}
              </button>
            </details>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenApprovals}
              className="rounded-full bg-brand px-5 py-2 text-sm font-bold text-brand-on hover:bg-brand-hover"
            >
              {intl.formatMessage(m.openApprovals)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/10 px-5 py-2 text-sm text-zinc-300 hover:bg-raised"
            >
              {intl.formatMessage(m.close)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
