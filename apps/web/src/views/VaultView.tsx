import { useRef, useState } from 'react';
import { AlertTriangle, Eye, FilePlus2, Lock, PencilLine, RefreshCw, UploadCloud } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useQueryClient } from '@tanstack/react-query';

import { API_ENABLED } from '../api/config';
import {
  listArchivedDocuments,
  previewVaultItem,
  reanalyseVaultItem,
  updateVaultItem,
  uploadVaultItem,
  useVaultItems,
  VAULT_CATEGORIES,
  VAULT_MAX_BYTES,
  vaultItemFromDocument,
  type VaultItem,
} from '../api/practiceVault';
import { useAppContext } from '../context/AppContext';

/**
 * The practice-side Document Vault (SoT §10) — a client's non-transactional
 * paperwork (leases, insurance, MOTs, engagement letters…), organised
 * Client → Financial Year → Category, with a "To review" view of what expires
 * within 14 days or already has.
 *
 * ⚠ NOT the client's £2 Vault add-on (`views/business/LivePortalVault.tsx`):
 * that one is the client's own sent documents in their portal; this one is the
 * practice's store of what the client is not sending as a transaction.
 *
 * Live only. With no server there is nothing to read, and the synthetic Vault
 * shelf on the Documents screen already carries the demo.
 */

const m = defineMessages({
  title: { id: 'vault.vaultView.title', defaultMessage: 'Document Vault' },
  lead: {
    id: 'vault.vaultView.lead',
    defaultMessage:
      'Contracts, leases, insurance, tax filings, engagement letters, MOTs and payroll — kept per client, read by the AI for a summary and any expiry or renewal dates.',
  },
  demoOnly: {
    id: 'vault.vaultView.demoOnly',
    defaultMessage: 'The vault reads live data. Sign in to the live workspace to use it.',
  },
  all: { id: 'vault.vaultView.all', defaultMessage: 'Everything' },
  toReview: { id: 'vault.vaultView.toReview', defaultMessage: 'To review (expiring in 14 days or expired)' },
  upload: { id: 'vault.vaultView.upload', defaultMessage: 'Upload to vault' },
  uploading: { id: 'vault.vaultView.uploading', defaultMessage: 'Uploading…' },
  uploadFor: { id: 'vault.vaultView.uploadFor', defaultMessage: 'Upload for' },
  pickClient: { id: 'vault.vaultView.pickClient', defaultMessage: 'Choose a client…' },
  tooBig: { id: 'vault.vaultView.tooBig', defaultMessage: '{name} is over the 100 MB limit and was not uploaded.' },
  fromArchive: { id: 'vault.vaultView.fromArchive', defaultMessage: 'Add from archived documents' },
  fromArchiveEmpty: {
    id: 'vault.vaultView.fromArchiveEmpty',
    defaultMessage: 'This client has no archived documents to move into the vault.',
  },
  fromArchiveAdd: { id: 'vault.vaultView.fromArchiveAdd', defaultMessage: 'Move to vault' },
  loading: { id: 'vault.vaultView.loading', defaultMessage: 'Loading the vault…' },
  empty: {
    id: 'vault.vaultView.empty',
    defaultMessage: 'Nothing in the vault yet. Upload a lease, an insurance certificate or an engagement letter to start.',
  },
  emptyToReview: { id: 'vault.vaultView.emptyToReview', defaultMessage: 'Nothing is expiring in the next 14 days.' },
  noYear: { id: 'vault.vaultView.noYear', defaultMessage: 'No financial year' },
  noCategory: { id: 'vault.vaultView.noCategory', defaultMessage: 'Uncategorised' },
  reading: { id: 'vault.vaultView.reading', defaultMessage: 'The AI is reading this document…' },
  readFailed: { id: 'vault.vaultView.readFailed', defaultMessage: 'The AI could not read this one — fill the details in, or re-analyse.' },
  expired: { id: 'vault.vaultView.expired', defaultMessage: 'Expired {date}' },
  expiresIn: {
    id: 'vault.vaultView.expiresIn',
    defaultMessage: '{days, plural, =0 {Expires today} one {Expires in # day} other {Expires in # days}} ({date})',
  },
  expiresOn: { id: 'vault.vaultView.expiresOn', defaultMessage: 'Expires {date}' },
  preview: { id: 'vault.vaultView.preview', defaultMessage: 'Preview' },
  edit: { id: 'vault.vaultView.edit', defaultMessage: 'Edit' },
  reanalyse: { id: 'vault.vaultView.reanalyse', defaultMessage: 'Re-analyse' },
  save: { id: 'vault.vaultView.save', defaultMessage: 'Save' },
  cancel: { id: 'vault.vaultView.cancel', defaultMessage: 'Cancel' },
  fieldTitle: { id: 'vault.vaultView.fieldTitle', defaultMessage: 'Title' },
  fieldCategory: { id: 'vault.vaultView.fieldCategory', defaultMessage: 'Category' },
  fieldTags: { id: 'vault.vaultView.fieldTags', defaultMessage: 'Tags (comma separated)' },
  fieldYear: { id: 'vault.vaultView.fieldYear', defaultMessage: 'Financial year (e.g. 2025-26)' },
  fieldExpiry: { id: 'vault.vaultView.fieldExpiry', defaultMessage: 'Expiry or renewal date' },
  fieldSummary: { id: 'vault.vaultView.fieldSummary', defaultMessage: 'Summary' },
  keyDate: { id: 'vault.vaultView.keyDate', defaultMessage: '{label}: {date}' },
  loadFailed: { id: 'vault.vaultView.loadFailed', defaultMessage: 'The vault could not be loaded: {error}' },
});

const CATEGORY_LABEL = defineMessages({
  contract: { id: 'vault.category.contract', defaultMessage: 'Contract' },
  lease: { id: 'vault.category.lease', defaultMessage: 'Lease' },
  insurance: { id: 'vault.category.insurance', defaultMessage: 'Insurance' },
  'tax-filing': { id: 'vault.category.taxFiling', defaultMessage: 'Tax filing' },
  'engagement-letter': { id: 'vault.category.engagementLetter', defaultMessage: 'Engagement letter' },
  mot: { id: 'vault.category.mot', defaultMessage: 'MOT' },
  payroll: { id: 'vault.category.payroll', defaultMessage: 'Payroll' },
  other: { id: 'vault.category.other', defaultMessage: 'Other' },
});

const DAY_MS = 86_400_000;

/** UK long form of a calendar date, rendered in UTC so the day never shifts. */
function ukDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function daysUntil(iso: string): number {
  return Math.ceil((Date.parse(iso) - Date.now()) / DAY_MS);
}

/** Insertion-ordered grouping — the list arrives newest first and stays that way inside a group. */
function groupBy<T>(rows: T[], key: (row: T) => string): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list === undefined) out.set(k, [row]);
    else list.push(row);
  }
  return [...out.entries()];
}

export function VaultView({ businessId }: { businessId?: string }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const { clients } = useAppContext();
  const [toReview, setToReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadClient, setUploadClient] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archived, setArchived] = useState<Awaited<ReturnType<typeof listArchivedDocuments>> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useVaultItems(businessId, toReview, API_ENABLED);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['practice-vault'] });

  if (!API_ENABLED) {
    return (
      <section className="rounded-[28px] border border-white/5 bg-card p-6">
        <h2 className="text-[15px] font-bold text-white">{intl.formatMessage(m.title)}</h2>
        <p className="mt-2 text-[13px] text-zinc-400">{intl.formatMessage(m.demoOnly)}</p>
      </section>
    );
  }

  const target = businessId ?? uploadClient;

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const upload = (files: FileList | null) => {
    // A FileList is live — the input is cleared right after this, so snapshot it now.
    const picked = files === null ? [] : Array.from(files);
    if (picked.length === 0 || target === '') return;
    void guard(async () => {
      const refused: string[] = [];
      for (const file of picked) {
        if (file.size > VAULT_MAX_BYTES) {
          refused.push(intl.formatMessage(m.tooBig, { name: file.name }));
          continue;
        }
        await uploadVaultItem(target, file);
      }
      if (refused.length > 0) throw new Error(refused.join(' '));
    });
  };

  const openArchive = () => {
    setArchiveOpen((open) => !open);
    if (businessId === undefined || archived !== null) return;
    void listArchivedDocuments(businessId)
      .then(setArchived)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const items = query.data ?? [];

  const renderItems = (rows: VaultItem[]) =>
    groupBy(rows, (row) => row.financialYear ?? '').map(([year, inYear]) => (
      <div key={year || 'none'} className="mt-3">
        <h4 className="text-[12px] font-bold uppercase tracking-wide text-zinc-400">
          {year === '' ? intl.formatMessage(m.noYear) : year}
        </h4>
        {groupBy(inYear, (row) => row.category ?? '').map(([category, inCategory]) => (
          <div key={category || 'none'} className="mt-2 pl-3 border-l border-white/10">
            <h5 className="text-[12px] font-semibold text-zinc-300">{categoryName(category)}</h5>
            <ul className="mt-1 flex flex-col gap-2">
              {inCategory.map((item) => (
                <VaultRow key={item.id} item={item} onChanged={refresh} onError={setError} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    ));

  function categoryName(category: string): string {
    if (category === '') return intl.formatMessage(m.noCategory);
    const descriptor = CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL];
    return descriptor === undefined ? category : intl.formatMessage(descriptor);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-[28px] border border-white/5 bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-white">
              <Lock size={16} aria-hidden /> {intl.formatMessage(m.title)}
            </h2>
            <p className="mt-1 max-w-2xl text-[12px] text-zinc-400">{intl.formatMessage(m.lead)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {businessId === undefined && (
              <label className="flex items-center gap-2 text-[12px] text-zinc-400">
                {intl.formatMessage(m.uploadFor)}
                <select
                  value={uploadClient}
                  onChange={(e) => setUploadClient(e.target.value)}
                  className="rounded-full border border-white/10 bg-raised px-3 py-2 text-[12px] text-white"
                >
                  <option value="">{intl.formatMessage(m.pickClient)}</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              disabled={busy || target === ''}
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-brand-on hover:bg-brand-hover disabled:opacity-40"
            >
              <UploadCloud size={16} aria-hidden />
              {intl.formatMessage(busy ? m.uploading : m.upload)}
            </button>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
            {businessId !== undefined && (
              <button
                type="button"
                onClick={openArchive}
                className="flex items-center gap-2 rounded-full border border-white/10 px-4 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-raised"
              >
                <FilePlus2 size={16} aria-hidden />
                {intl.formatMessage(m.fromArchive)}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 flex gap-2" role="group">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={toReview === value}
              onClick={() => setToReview(value)}
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold ${
                toReview === value ? 'bg-brand text-brand-on' : 'bg-raised text-zinc-300 hover:text-white'
              }`}
            >
              {intl.formatMessage(value ? m.toReview : m.all)}
            </button>
          ))}
        </div>

        {error !== null && (
          <p role="alert" className="mt-3 flex items-center gap-2 text-[12px] text-red-400">
            <AlertTriangle size={14} aria-hidden /> {error}
          </p>
        )}

        {archiveOpen && businessId !== undefined && (
          <div className="mt-4 rounded-2xl border border-white/10 bg-raised p-4">
            {archived === null ? (
              <p className="text-[12px] text-zinc-400">{intl.formatMessage(m.loading)}</p>
            ) : archived.length === 0 ? (
              <p className="text-[12px] text-zinc-400">{intl.formatMessage(m.fromArchiveEmpty)}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {archived.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between gap-3 text-[13px] text-zinc-200">
                    <span className="min-w-0 truncate">
                      {doc.supplierName ?? doc.originalFilename}
                      {doc.documentDate !== null && <span className="text-zinc-500"> · {ukDate(doc.documentDate)}</span>}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void guard(async () => {
                          await vaultItemFromDocument(doc.id);
                          setArchived((rows) => (rows ?? []).filter((row) => row.id !== doc.id));
                        })
                      }
                      className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-[12px] font-semibold hover:bg-card disabled:opacity-40"
                    >
                      {intl.formatMessage(m.fromArchiveAdd)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="rounded-[28px] border border-white/5 bg-card p-6">
        {query.isLoading ? (
          <p className="text-[13px] text-zinc-400">{intl.formatMessage(m.loading)}</p>
        ) : query.error !== null ? (
          <p role="alert" className="text-[13px] text-red-400">
            {intl.formatMessage(m.loadFailed, { error: query.error instanceof Error ? query.error.message : String(query.error) })}
          </p>
        ) : items.length === 0 ? (
          <p className="text-[13px] text-zinc-400">{intl.formatMessage(toReview ? m.emptyToReview : m.empty)}</p>
        ) : businessId !== undefined ? (
          renderItems(items)
        ) : (
          groupBy(items, (row) => row.businessName).map(([client, rows]) => (
            <details key={client} open className="mt-2 first:mt-0">
              <summary className="cursor-pointer text-[14px] font-bold text-white">{client}</summary>
              {renderItems(rows)}
            </details>
          ))
        )}
      </section>
    </div>
  );
}

function VaultRow({ item, onChanged, onError }: { item: VaultItem; onChanged: () => void; onError: (e: string) => void }) {
  const intl = useIntl();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    title: item.title ?? '',
    summary: item.summary ?? '',
    category: item.category ?? 'other',
    tags: item.tags.join(', '),
    financialYear: item.financialYear ?? '',
    expiresAt: item.expiresAt?.slice(0, 10) ?? '',
  });

  const run = (work: () => Promise<unknown>) =>
    void work()
      .then(onChanged)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));

  const days = item.expiresAt === null ? null : daysUntil(item.expiresAt);
  const expiry =
    item.expiresAt === null || days === null
      ? null
      : days < 0
        ? { text: intl.formatMessage(m.expired, { date: ukDate(item.expiresAt) }), tone: 'text-red-400' }
        : days <= 14
          ? { text: intl.formatMessage(m.expiresIn, { days, date: ukDate(item.expiresAt) }), tone: 'text-amber-400' }
          : { text: intl.formatMessage(m.expiresOn, { date: ukDate(item.expiresAt) }), tone: 'text-zinc-400' };

  const input = 'w-full rounded-xl border border-white/10 bg-raised px-3 py-2 text-[13px] text-white';

  return (
    <li className="rounded-2xl border border-white/5 bg-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-bold text-white" title={item.filename}>{item.title ?? item.filename}</p>
          {item.aiState === 'pending' && <p className="text-[12px] text-zinc-400">{intl.formatMessage(m.reading)}</p>}
          {item.aiState === 'failed' && <p className="text-[12px] text-amber-400">{intl.formatMessage(m.readFailed)}</p>}
          {item.summary !== null && <p className="mt-1 text-[12px] text-zinc-300">{item.summary}</p>}
          {expiry !== null && <p className={`mt-1 text-[12px] font-semibold ${expiry.tone}`}>{expiry.text}</p>}
          {item.keyDates.length > 0 && (
            <p className="mt-1 text-[11px] text-zinc-500">
              {item.keyDates.map((k) => intl.formatMessage(m.keyDate, { label: k.label, date: ukDate(k.date) })).join(' · ')}
            </p>
          )}
          {item.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-card px-2 py-0.5 text-[11px] text-zinc-300">{tag}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <IconButton label={intl.formatMessage(m.preview)} onClick={() => run(() => previewVaultItem(item.id))}><Eye size={14} /></IconButton>
          <IconButton label={intl.formatMessage(m.edit)} onClick={() => setEditing((on) => !on)}><PencilLine size={14} /></IconButton>
          <IconButton label={intl.formatMessage(m.reanalyse)} onClick={() => run(() => reanalyseVaultItem(item.id))}><RefreshCw size={14} /></IconButton>
        </div>
      </div>

      {editing && (
        <form
          className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await updateVaultItem(item.id, {
                title: draft.title.trim(),
                summary: draft.summary.trim(),
                category: draft.category,
                tags: draft.tags.split(',').map((t) => t.trim()).filter((t) => t !== ''),
                financialYear: draft.financialYear.trim(),
                expiresAt: draft.expiresAt === '' ? null : draft.expiresAt,
              });
              setEditing(false);
            });
          }}
        >
          <label className="text-[11px] text-zinc-400">
            {intl.formatMessage(m.fieldTitle)}
            <input className={input} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="text-[11px] text-zinc-400">
            {intl.formatMessage(m.fieldCategory)}
            <select className={input} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {VAULT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{intl.formatMessage(CATEGORY_LABEL[c])}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-zinc-400">
            {intl.formatMessage(m.fieldTags)}
            <input className={input} value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
          </label>
          <label className="text-[11px] text-zinc-400">
            {intl.formatMessage(m.fieldYear)}
            <input className={input} value={draft.financialYear} onChange={(e) => setDraft({ ...draft, financialYear: e.target.value })} />
          </label>
          <label className="text-[11px] text-zinc-400">
            {intl.formatMessage(m.fieldExpiry)}
            <input type="date" className={input} value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} />
          </label>
          <label className="text-[11px] text-zinc-400 sm:col-span-2">
            {intl.formatMessage(m.fieldSummary)}
            <textarea className={input} rows={2} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className="rounded-full bg-brand px-4 py-1.5 text-[12px] font-bold text-brand-on hover:bg-brand-hover">
              {intl.formatMessage(m.save)}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-full border border-white/10 px-4 py-1.5 text-[12px] text-zinc-300">
              {intl.formatMessage(m.cancel)}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-full p-2 text-zinc-400 hover:bg-card hover:text-white"
    >
      {children}
    </button>
  );
}

export default VaultView;
