import { useMemo, useRef, useState } from 'react';
import {
  Upload, Eye, Copy, CheckCircle, Send, Trash2, RefreshCw, MessageSquare, FileText, Image as ImageIcon,
  Link2, Sparkles, Download, PencilLine, UploadCloud,
} from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { SubTabs } from '../components/DynamicComponents/SubTabs';
import { DuplicateModal } from '../components/DynamicComponents/DuplicateModal';
import { navigate, path, useQueryParam, useSegment } from '../lib/router';
import { failureOf, retryMeaning } from '../lib/failures';
import { AnalysisModal } from '../components/DynamicComponents/AnalysisModal';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { blockedReason, partitionByReadiness, readinessOf } from '../lib/readiness';
import { currency } from '../lib/resolver';
import type { Client, DocKind, Document, DuplicatePair } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';

/**
 * Wireframe screen 8 — a client's Costs inbox. The Sales tab is the same
 * component over the opposite side of the ledger, because AI classification
 * routes documents to the right inbox and nothing else differs.
 *
 * Each status tab is a genuinely different job, so each gets the columns and
 * the actions that job needs rather than one table filtered five ways:
 *
 *   To Review       — ranked by uncertainty, least confident first
 *   Ready           — everything mandatory is present; the job is publishing
 *   Published       — done; the only actions left are getting the data out
 *   Processing      — waiting on extraction, nothing to decide yet
 *   Rejected/Failed — the 337-vote view: nothing ever vanishes silently
 *
 * Ordered the way an item moves through the accountant's hands: review it, it
 * becomes ready, it gets published. Processing sits after those because nobody
 * acts on it — extraction is running and the only thing to do is wait — and
 * Rejected / Failed is last because it is the exception, not a stage anything
 * passes through.
 */
const STATUSES = ['review', 'ready', 'published', 'processing', 'rejected', 'duplicates'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABEL: Record<Status, string> = {
  review: 'To Review',
  ready: 'Ready',
  published: 'Published',
  processing: 'Processing',
  rejected: 'Rejected / Failed',
  duplicates: 'Duplicates',
};

/** How the file was split on the way in — PRD stage 1, shown so it is auditable. */
const SPLIT_MODES = [
  { key: 'auto', label: 'Auto-split', hint: 'Standard — a multi-document PDF becomes one document per invoice' },
  { key: 'per-file', label: 'One per file', hint: 'Every file is exactly one document' },
  { key: 'per-page', label: 'One per page', hint: 'Every page is its own document' },
] as const;

export function ClientInbox({ client, kind, onPreview }: {
  client: Client;
  kind: DocKind;
  onPreview: (doc: Document) => void;
}) {
  const {
    documents, duplicates, mandatoryFields, ingest, sheetImports, updateDocumentStatus, retryDocument,
    deleteDocuments, startConversation, statsFor,
  } = useAppContext();

  const confirm = useConfirm();

  // /clients/:id/costs/:status — the sub-tab is the fourth segment.
  const [statusSlug, setStatusSlug] = useSegment(3);
  const status: Status = (STATUSES.find((st) => st === statusSlug) as Status) ?? 'review';
  const setStatus = (next: Status) => setStatusSlug(next);

  // ?compare=<pairId> — the side-by-side modal is linkable like any other.
  const [comparingId, setComparingId] = useQueryParam('compare');
  const comparing = comparingId ? duplicates.find((p) => p.id === comparingId) ?? null : null;
  const setComparing = (pair: DuplicatePair | null) => setComparingId(pair ? pair.id : null);
  const [splitMode, setSplitMode] = useState<(typeof SPLIT_MODES)[number]['key']>('auto');
  const fileRef = useRef<HTMLInputElement>(null);
  /** A replacement is one file for one unreadable document, kept off the bulk path. */
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<Document | null>(null);
  /** The upload being read on screen. */
  const [analysing, setAnalysing] = useState<{ docIds: string[]; importIds: string[] } | null>(null);

  const mine = documents.filter((d) => d.clientId === client.id && d.kind === kind);
  const counts = Object.fromEntries(
    STATUSES.map((st) => [st, mine.filter((d) => d.status === st).length]),
  ) as Record<Status, number>;

  /**
   * Pairs where at least one side is in this inbox, and the lookup from a
   * document to the pair it belongs to — the row needs the pair, not just the
   * knowledge that one exists.
   */
  const pairFor = useMemo(() => {
    const ids = new Set(mine.map((d) => d.id));
    const map = new Map<string, DuplicatePair>();
    duplicates
      .filter((p) => ids.has(p.left.id) || ids.has(p.right.id))
      .forEach((p) => {
        if (!map.has(p.left.id)) map.set(p.left.id, p);
        if (!map.has(p.right.id)) map.set(p.right.id, p);
      });
    return map;
  }, [duplicates, mine]);

  /** The pairs themselves, for the Duplicates tab. */
  const clientPairs = useMemo(() => {
    const ids = new Set(mine.map((d) => d.id));
    return duplicates.filter((p) => ids.has(p.left.id) || ids.has(p.right.id));
  }, [duplicates, mine]);

  /**
   * The least confident thing the extractor said about a document. Ranking on
   * it puts the documents most likely to be wrong at the top, which is the
   * whole point of a review queue — not date order.
   */
  const uncertainty = (d: Document) =>
    d.fields.length === 0 ? 0 : Math.min(...d.fields.map((f) => f.confidence));

  /** Why this document stopped, in the words of whatever stopped it. */
  const whyFlagged = (d: Document): { text: string; tone: 'amber' | 'red' | 'neutral' } => {
    if (pairFor.has(d.id)) {
      return { text: `Duplicate — ${Math.round(pairFor.get(d.id)!.similarity * 100)}% match`, tone: 'amber' };
    }
    if (d.statusNote) return { text: d.statusNote, tone: d.status === 'rejected' ? 'red' : 'amber' };
    const weakest = d.fields.length ? d.fields.reduce((a, b) => (a.confidence < b.confidence ? a : b)) : undefined;
    if (weakest && weakest.confidence < 0.6) {
      return { text: `Low confidence on ${weakest.label.toLowerCase()}`, tone: 'amber' };
    }
    const missing = mandatoryFields.filter((f) => !d.fields.some((x) => x.label === f && x.value !== '—'));
    if (missing.length) return { text: `Missing ${missing.join(', ')}`, tone: 'amber' };
    return { text: '—', tone: 'neutral' };
  };

  const rows = useMemo(() => {
    const list = mine.filter((d) => d.status === status);
    // Only the review queue is uncertainty-ranked; the others read better in
    // the order they arrived.
    return status === 'review' ? [...list].sort((a, b) => uncertainty(a) - uncertainty(b)) : list;
  }, [mine, status]);

  /**
   * Which tab you happened to be on is not evidence about the document.
   * `kind` is deliberately not passed: extraction reads the bill-to block and
   * decides, and the analysis panel shows that call with a control to change
   * it — so a receipt dropped on the Sales tab still files as a cost.
   */
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const result = ingest(
      Array.from(files).map((f) => ({ name: f.name, size: f.size, raw: f })),
      client.id,
      'web',
      { uploader: 'You (web upload)' },
    );
    if (result.documents.length || result.imports.length) {
      setAnalysing({ docIds: result.documents.map((d) => d.id), importIds: result.imports.map((t) => t.id) });
    }
  };

  /** Publishing always goes through the review gate — one path for row and bulk. */
  const publish = (docs: Document[]) => {
    // Naming the single document keeps the "length === 1" invariant — the only
    // thing that makes docs[0] present — visible at the point it is relied on.
    const single = docs.length === 1 ? docs[0] : undefined;
    return startConversation([client.id], [
      {
        id: `${Date.now()}-u`,
        role: 'user',
        content: `Publish ${single ? single.supplier : `${docs.length} ready items`} for ${client.name}`,
      },
      {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: 'Read the review — counts and gross/VAT totals — before approving the push.',
        intent: 'PUBLISH',
        payload: { clientIds: [client.id], clientNames: [client.name], documentIds: docs.map((d) => d.id) },
      },
    ]);
  };

  const openInChat = (doc: Document) =>
    startConversation([client.id], [
      { id: `${Date.now()}-u`, role: 'user', content: `Review the ${doc.supplier} document` },
      {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: 'Every field shows confidence and provenance — click any value to correct it.',
        intent: 'REVIEW_DOCUMENT',
        payload: { documentId: doc.id, clientIds: [client.id], clientNames: [client.name] },
      },
    ]);


  /* ── columns, per status ────────────────────────────────────────────────── */

  const docCell: Column<Document> = {
    key: 'doc',
    label: 'Doc',
    sortValue: (d) => d.splitFrom ?? d.id,
    render: (d) => {
      const isImage = /receipt|photo|jpg|png|heic/i.test(`${d.source} ${d.splitFrom ?? ''}`) || d.source === 'whatsapp';
      return (
        <span className="flex items-center gap-2.5">
          <span className="w-8 h-9 rounded-lg bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0">
            {isImage ? <ImageIcon size={14} /> : <FileText size={14} />}
          </span>
          <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
            {isImage ? 'Receipt' : 'Invoice'}
          </span>
        </span>
      );
    },
  };

  const supplierCell: Column<Document> = {
    key: 'supplier',
    label: kind === 'cost' ? 'Supplier' : 'Customer',
    sortValue: (d) => d.supplier,
    render: (d) => {
      const field = d.fields.find((f) => f.label === 'Supplier' || f.label === 'Customer');
      const low = field !== undefined && field.confidence < 0.75;
      return (
        <span className="flex items-center gap-2">
          <span className="text-white font-semibold">{d.supplier}</span>
          {/* Confidence is shown where it changes what you do, not everywhere. */}
          {low && <Pill tone="amber">{Math.round(field!.confidence * 100)}%</Pill>}
        </span>
      );
    },
  };

  const categoryCell: Column<Document> = {
    key: 'category',
    label: 'Category',
    sortValue: (d) => d.category,
    render: (d) => {
      const field = d.fields.find((f) => f.label === 'Category');
      if (d.category === '—') return <Pill tone="amber">Missing</Pill>;
      const byRule = field?.provenance?.includes('rule');
      return (
        <span className="flex items-center gap-2">
          <span className="text-zinc-300">{d.category}</span>
          {byRule ? (
            <span title={field?.provenance} className="text-brand shrink-0"><Link2 size={12} /></span>
          ) : field ? (
            <span title={`AI · ${Math.round(field.confidence * 100)}% confident`} className="text-zinc-500 shrink-0 flex items-center gap-1">
              <Sparkles size={12} />
              <span className="text-[11px] font-semibold">{Math.round(field.confidence * 100)}%</span>
            </span>
          ) : null}
        </span>
      );
    },
  };

  const totalCell: Column<Document> = {
    key: 'total',
    label: 'Total',
    align: 'right',
    sortValue: (d) => d.total,
    render: (d) => (
      <span className="flex items-center justify-end gap-2">
        {d.currency !== 'GBP' && <Pill tone="amber">{d.currency}</Pill>}
        <span className="text-white font-bold tabular-nums">{currency(d.total)}</span>
      </span>
    ),
  };

  // Kept at the user's request: which channel a document arrived on is how you
  // tell a chased upload from a supplier emailing us directly.
  const channelCell: Column<Document> = {
    key: 'source',
    label: 'Received via',
    sortValue: (d) => d.source,
    render: (d) => <Pill>{d.source}</Pill>,
  };

  const dateCell: Column<Document> = { key: 'date', label: 'Date', sortValue: (d) => d.date };

  /**
   * A duplicate flag has to be visible wherever the document is, not only on
   * the tab that happens to explain why an item stopped.
   */
  const flagCell: Column<Document> = {
    key: 'flags',
    label: '',
    render: (d) => {
      const pair = pairFor.get(d.id);
      if (!pair) return null;
      return (
        <button
          onClick={(e) => { e.stopPropagation(); setComparing(pair); }}
          title={`${Math.round(pair.similarity * 100)}% match — ${pair.signals.slice(0, 3).join(', ')}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/25 hover:bg-amber-400/20 transition-colors whitespace-nowrap"
        >
          <Copy size={11} />
          Duplicate {Math.round(pair.similarity * 100)}%
        </button>
      );
    },
  };

  const whyCell: Column<Document> = {
    key: 'why',
    label: 'Why flagged',
    sortValue: (d) => whyFlagged(d).text,
    render: (d) => {
      const { text, tone } = whyFlagged(d);
      if (text === '—') return <span className="text-zinc-700">—</span>;
      return <Pill tone={tone}>{text}</Pill>;
    },
  };

  /**
   * The one move that takes this document forward, named for where it goes.
   * A document waiting on extraction has no move — nobody can hurry it — and a
   * published one is finished, so neither gets a button rather than getting a
   * disabled one that invites a click.
   */
  /** Retry, saying what it will actually do — and whether it can help at all. */
  const askRetry = async (d: Document) => {
    const failure = failureOf(d);
    if (!failure) return;
    const ok = await confirm({
      title: failure.stage === 'extraction' ? `Read ${d.supplier} again?` : `Publish ${d.supplier} again?`,
      detail: `${failure.reason}. ${retryMeaning(failure)}`,
      ...(failure.retryHelps
        ? {}
        : { consequence: `This is unlikely to clear it on its own — ${failure.fixLabel.toLowerCase()} is what changes the outcome.` }),
      confirmLabel: 'Yes, retry',
    });
    if (ok) retryDocument(d.id);
  };

  /** The replacement is read from scratch and the unreadable original goes. */
  const handleReplacement = async (files: FileList | null) => {
    const doc = replacing;
    setReplacing(null);
    // Reading the file first says what the length check was really asserting:
    // a replacement is exactly one file, and there is nothing to do without it.
    const file = files?.[0];
    if (!doc || !file) return;
    const ok = await confirm({
      title: `Replace ${doc.supplier === 'Unknown' ? 'this document' : doc.supplier} with ${file.name}?`,
      detail: 'The new file is read from scratch under this client.',
      consequence: 'The unreadable original is removed, so the same spend is not on file twice.',
      confirmLabel: 'Yes, replace it',
    });
    if (!ok) return;
    ingest([{ name: file.name, size: file.size, raw: file }], client.id, 'web');
    deleteDocuments([doc.id]);
    setStatus('processing');
  };

  const nextStep = (
    d: Document,
  ): { label: string; icon: typeof CheckCircle; run: () => void; blocked?: string } | null => {
    if (d.status === 'review') {
      // Ready claims every check has passed. A document that cannot make that
      // claim is not offered the move at all — it is offered the fix, because
      // that is the only thing that gets it moving.
      const verdict = readinessOf(d, mandatoryFields);
      if (!verdict.ready) {
        return {
          label: 'Fix',
          icon: PencilLine,
          blocked: blockedReason(verdict),
          run: () => onPreview(d),
        };
      }
      return {
        label: 'Move to Ready',
        icon: CheckCircle,
        run: async () => {
          const flag = whyFlagged(d).text;
          const ok = await confirm({
            title: `Move ${d.supplier} to Ready?`,
            detail: `${currency(d.total)} · ${d.category}. Ready means every check has passed and it is queued to publish.`,
            ...(flag === '—' ? {} : { consequence: `This item is flagged: ${flag}.` }),
            confirmLabel: 'Yes, mark it Ready',
          });
          if (ok) updateDocumentStatus(d.id, 'ready');
        },
      };
    }
    if (d.status === 'ready') return { label: 'Publish', icon: Send, run: () => publish([d]) };
    if (d.status === 'rejected') {
      // "Fix & retry" was one button doing one thing — retrying — whatever the
      // cause. A locked PDF read again is still a locked PDF, so the cause
      // decides the verb, and Retry sits beside it in the action cell.
      const failure = failureOf(d);
      if (!failure) return null;
      if (failure.fix === 'replace-file') {
        return { label: failure.fixLabel, icon: UploadCloud, blocked: failure.reason, run: () => { setReplacing(d); replaceRef.current?.click(); } };
      }
      if (failure.fix === 'open-document') {
        return { label: failure.fixLabel, icon: PencilLine, blocked: failure.reason, run: () => onPreview(d) };
      }
      return { label: failure.fixLabel, icon: RefreshCw, run: () => askRetry(d) };
    }
    return null;
  };

  /** The wireframe's per-row verb, in this site's icon-button language. */
  const actionCell: Column<Document> = {
    key: 'actions',
    label: '',
    align: 'right',
    render: (d) => {
      const step = nextStep(d);
      return (
        <span className="flex items-center justify-end gap-1.5">
          <RowButton icon={Eye} title="Open — the original with every extracted field" onClick={() => onPreview(d)} />
          {pairFor.has(d.id) && (
            <RowButton
              icon={Copy}
              title="Compare the two copies side by side"
              tone="amber"
              onClick={() => setComparing(pairFor.get(d.id)!)}
            />
          )}
          {d.status === 'review' && (
            // Not a pencil: this leaves the table for the AI workspace rather
            // than editing in place, and an icon promising inline editing
            // makes the jump feel like a misfire.
            <RowButton
              icon={MessageSquare}
              title="Open in the AI workspace — every field with its confidence, click any value to correct it"
              onClick={() => openInChat(d)}
            />
          )}
          {step && (
            // Blocked rows get an amber Fix that opens the document, not a
            // dead grey button — there is always something to do about it.
            <button
              onClick={(e) => { e.stopPropagation(); step.run(); }}
              title={step.blocked ? `${step.blocked} — open it to sort that out first.` : undefined}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold border transition-colors whitespace-nowrap ${
                step.blocked
                  ? 'text-amber-400 bg-amber-400/10 border-amber-400/25 hover:bg-amber-400/20'
                  : 'text-brand bg-brand/10 border-brand/25 hover:bg-brand/20'
              }`}
            >
              <step.icon size={12} strokeWidth={2.5} />
              {step.label}
            </button>
          )}
          {/* Retry sits beside the cause's own fix rather than replacing it,
              and says plainly when it is not the thing that will help. */}
          {d.status === 'rejected' && failureOf(d)?.fix !== 'retry' && (() => {
            const failure = failureOf(d)!;
            return (
              <RowButton
                icon={RefreshCw}
                title={`Retry — ${failure.retryHelps ? retryMeaning(failure) : `unlikely to help while ${failure.reason.toLowerCase()}`}`}
                onClick={() => askRetry(d)}
              />
            );
          })()}
        </span>
      );
    },
  };

  /**
   * A column for each field the practice made mandatory.
   *
   * Requiring a field and then not showing it means opening documents one at a
   * time to find out which are short of it — the toggle in "Required before
   * publish" now puts the answer in the table.
   */
  const mandatoryCols: Column<Document>[] = mandatoryFields.map((label) => ({
    key: `req-${label}`,
    label,
    render: (d: Document) => {
      const value = d.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;
      return value && value !== '—' ? (
        <span className="text-zinc-300">{value}</span>
      ) : (
        <span className="text-amber-400" title={`${label} is required before this can be published`}>Missing</span>
      );
    },
  }));

  const columns: Column<Document>[] =
    status === 'processing'
      ? [docCell, supplierCell, dateCell, channelCell,
         { key: 'eta', label: 'Status', render: (d) => <Pill>{d.statusNote ?? 'Extraction running'}</Pill> },
         flagCell, actionCell]
      : status === 'ready'
      ? [docCell, supplierCell, totalCell, categoryCell,
         {
           key: 'vat', label: 'VAT', align: 'right',
           render: (d) => {
             const tax = d.fields.find((f) => f.label.toLowerCase().includes('tax'));
             return <span className="tabular-nums text-zinc-400">{tax?.value ?? '—'}</span>;
           },
         },
         channelCell,
         ...mandatoryCols,
         flagCell,
         {
           key: 'target', label: 'Publish to',
           render: () => (
             <span className="text-zinc-400">
               {client.xeroConnected ? (kind === 'cost' ? 'Xero — Bills' : 'Xero — Invoices') : 'No ledger connected'}
             </span>
           ),
         },
         actionCell]
      : status === 'published'
      ? [docCell, supplierCell, dateCell, totalCell, categoryCell,
         {
           key: 'vat', label: 'VAT', align: 'right',
           render: (d) => {
             const tax = d.fields.find((f) => f.label.toLowerCase().includes('tax'));
             return <span className="tabular-nums text-zinc-400">{tax?.value ?? '—'}</span>;
           },
         },
         channelCell,
         flagCell,
         {
           key: 'where', label: 'In the ledger',
           render: () => (
             <Pill tone="blue">{client.xeroConnected ? (kind === 'cost' ? 'Xero — Bills' : 'Xero — Invoices') : 'Exported'}</Pill>
           ),
         },
         actionCell]
      : status === 'rejected'
      ? [docCell, supplierCell,
         {
           key: 'failed', label: 'What failed',
           render: (d) => <Pill tone="red">{failureOf(d)?.stage === 'publish' ? 'Publish' : 'Extraction'}</Pill>,
         },
         {
           key: 'reason', label: 'Reason',
           render: (d) => {
             const failure = failureOf(d);
             return (
               <span className="text-zinc-400" title={failure?.detail}>
                 {failure?.reason ?? d.statusNote ?? 'No reason recorded'}
               </span>
             );
           },
         },
         channelCell,
         flagCell, actionCell]
      : [docCell, supplierCell, dateCell, totalCell, categoryCell, whyCell, channelCell, ...mandatoryCols, flagCell, actionCell];

  /* ── bulk actions, per status ───────────────────────────────────────────── */

  const bulkActions =
    status === 'review'
      ? [
          {
            label: 'Approve suggestions', icon: CheckCircle,
            onClick: async (sel: Document[]) => {
              const { ready, blocked } = partitionByReadiness(sel, mandatoryFields);
              if (ready.length === 0) {
                await confirm({
                  tone: 'red',
                  title: 'None of these can move yet',
                  detail: blocked
                    .map(({ doc, reason }) => `${doc.supplier} — ${reason.toLowerCase()}`)
                    .slice(0, 4)
                    .join('. '),
                  confirmLabel: 'Close',
                });
                return;
              }
              const ok = await confirm({
                title: `Accept the AI's coding on ${ready.length} item${ready.length === 1 ? '' : 's'}?`,
                detail: `${ready.map((d) => d.supplier).slice(0, 3).join(', ')}${ready.length > 3 ? ` and ${ready.length - 3} more` : ''} move to Ready with the categories as suggested.`,
                consequence: blocked.length
                  ? `${blocked.length} of the selected cannot move yet and will be left alone: ${blocked.map((b) => b.doc.supplier).join(', ')}.`
                  : 'Anything the extractor got wrong goes through unchallenged.',
                confirmLabel: 'Yes, accept them',
              });
              if (ok) ready.forEach((d) => updateDocumentStatus(d.id, 'ready'));
            },
          },
          {
            label: 'Delete', icon: Trash2,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                tone: 'red',
                title: `Delete ${sel.length} document${sel.length === 1 ? '' : 's'}?`,
                detail: sel.map((d) => `${d.supplier} ${currency(d.total)}`).slice(0, 4).join(' · '),
                consequence: 'The originals go with them, and a deleted document cannot be matched to a bank line later.',
                confirmLabel: 'Yes, delete',
              });
              if (ok) deleteDocuments(sel.map((d) => d.id));
            },
          },
        ]
      : status === 'ready'
      ? [
          {
            label: 'Back to review', icon: RefreshCw,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                title: `Send ${sel.length} item${sel.length === 1 ? '' : 's'} back to review?`,
                detail: 'They leave the publish queue until someone passes them again.',
                confirmLabel: 'Yes, send them back',
              });
              if (ok) sel.forEach((d) => updateDocumentStatus(d.id, 'review'));
            },
          },
          { label: 'Publish selected', icon: Send, primary: true, onClick: publish },
        ]
      : status === 'published'
      ? [
          // Published is the end of the line, so the only actions are getting
          // the data back out — never a silent edit of what the ledger holds.
          { label: 'Export CSV', icon: Download, minSelected: 2, disabledHint: EXPORT_HINT, onClick: (sel: Document[]) => exportDocuments(sel, client.name) },
          {
            label: 'Unpublish', icon: RefreshCw,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                tone: 'red',
                title: `Unpublish ${sel.length} item${sel.length === 1 ? '' : 's'}?`,
                detail: 'They come back to Ready here.',
                consequence: 'This does not remove them from the accounting software — that has to be undone in the ledger itself.',
                confirmLabel: 'Yes, unpublish',
              });
              if (ok) sel.forEach((d) => updateDocumentStatus(d.id, 'ready'));
            },
          },
        ]
      : status === 'rejected'
      ? [
          {
            label: 'Retry', icon: RefreshCw, primary: true,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                title: `Retry ${sel.length} failed item${sel.length === 1 ? '' : 's'}?`,
                detail: 'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
                confirmLabel: 'Yes, retry',
              });
              if (ok) sel.forEach((d) => retryDocument(d.id));
            },
          },
          { label: 'Enter manually', icon: MessageSquare, onClick: (sel: Document[]) => sel[0] && openInChat(sel[0]) },
        ]
      : [];

  const s = statsFor(client.id);

  return (
    <div className="flex flex-col gap-5">
      {/* Status tabs carry their own counts. Rendered as a recessed segmented
          control so they never read as a second row of client tabs. */}
      <SubTabs
        tabs={STATUSES.map((st) => ({
          key: st,
          label: STATUS_LABEL[st],
          count: st === 'duplicates' ? clientPairs.length : counts[st],
          alert: (st === 'rejected' && counts.rejected > 0) || (st === 'duplicates' && clientPairs.length > 0),
        }))}
        active={status}
        onChange={(k) => setStatus(k as Status)}
      />

      {status === 'duplicates' ? (
        <div className="flex flex-col gap-3">
          {clientPairs.length === 0 ? (
            <div className="border border-white/5 rounded-[32px] bg-card p-10 text-center shadow-2xl">
              <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
                Nothing flagged. Every document is checked against the others on file the moment it is read —
                same total, supplier, dates within a few days, matching text, file and image hashes — so an
                invoice and its photographed twin are caught even when they came from different people.
              </p>
            </div>
          ) : (
            clientPairs.map((pair) => (
              <button
                key={pair.id}
                onClick={() => setComparing(pair)}
                className="w-full text-left border border-amber-400/20 rounded-[24px] bg-amber-400/[0.05] p-5 hover:border-amber-400/40 transition-colors flex items-center gap-4 flex-wrap"
              >
                <span className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/25 flex items-center justify-center text-amber-400 shrink-0">
                  <Copy size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-white truncate">
                    {pair.left.label} ↔ {pair.right.label}
                  </span>
                  <span className="block text-[12px] text-zinc-500 mt-0.5 truncate">
                    {pair.signals.slice(0, 4).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  {pair.crossType && <Pill tone="blue">Cross-type</Pill>}
                  {pair.left.uploader !== pair.right.uploader && <Pill>Different uploaders</Pill>}
                  <Pill tone="amber">{Math.round(pair.similarity * 100)}%</Pill>
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
      <DataTable<Document>
        className="max-w-none"
        columns={columns}
        rows={rows}
        rowId={(d) => d.id}
        selectable={status !== 'processing'}
        bulkActions={bulkActions}
        actionsOnTop
        onRowClick={(d) => onPreview(d)}
        toolbar={
          <>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-[0_0_15px_rgba(20,227,196,0.2)]"
            >
              <Upload size={16} strokeWidth={2.5} />
              Upload
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
            />
            <input
              ref={replaceRef}
              type="file"
              className="hidden"
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf"
              onChange={(e) => { handleReplacement(e.target.files); e.target.value = ''; }}
            />
            <div className="flex items-center gap-1 bg-ground border border-white/5 rounded-full p-1 shadow-inner">
              {SPLIT_MODES.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setSplitMode(m.key)}
                  title={m.hint}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                    splitMode === m.key ? 'bg-raised text-white' : 'text-zinc-500 hover:text-white'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </>
        }
        emptyMessage={
          status === 'processing' ? 'Nothing extracting right now.'
            : status === 'review' ? 'Nothing to review — the inbox is clear.'
            : status === 'ready' ? 'Nothing ready to publish.'
            : status === 'published' ? 'Nothing published yet for this client.'
            : 'Nothing has failed. Anything that does lands here with its reason.'
        }
        footer={
          status === 'review'
            ? 'Ranked by uncertainty — least confident first'
            : status === 'ready'
            ? `Needs supplier, total and category${mandatoryFields.length ? `, plus ${mandatoryFields.join(', ')}` : ''} before publishing`
            : status === 'published'
            ? 'Already in the accounting software — unpublishing here does not remove it from the ledger'
            : status === 'rejected'
            ? 'Nothing ever disappears silently — every failure keeps its reason'
            : `${s.processing} extracting · ETA shown per item`
        }
      />
      )}

      {analysing && (
        <AnalysisModal
          docIds={analysing.docIds}
          importIds={analysing.importIds}
          lockedClientId={client.id}
          onClose={(settled) => {
            const importIds = analysing.importIds;
            setAnalysing(null);
            const first = settled[0];
            if (!first) {
              // A spreadsheet lands as rows, not as one document — go to
              // whichever side of the ledger most of them belong to.
              const imported = sheetImports.filter((t) => importIds.includes(t.id));
              const sales = imported.reduce((n, t) => n + t.counts.sales, 0);
              const costs = imported.reduce((n, t) => n + t.counts.cost, 0);
              if (!sales && !costs) return;
              const landedKind = sales > costs ? 'sales' : 'cost';
              if (landedKind !== kind) navigate(path('clients', client.id, landedKind === 'sales' ? 'sales' : 'costs', 'review'));
              else setStatus('review');
              return;
            }
            const landed: Status = first.status === 'ready' ? 'ready' : 'review';
            // The AI may have filed it as the other kind, in which case it is
            // not on this tab at all — go to where it actually is.
            if (first.kind !== kind) {
              navigate(path('clients', client.id, first.kind === 'sales' ? 'sales' : 'costs', landed));
              return;
            }
            setStatus(landed);
          }}
        />
      )}

      {comparing && <DuplicateModal pair={comparing} onClose={() => setComparing(null)} />}
    </div>
  );
}

/** CSV of the selected documents, flattened so the file is useful on its own. */
function exportDocuments(rows: Document[], clientName: string) {
  if (rows.length === 0) return;
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Supplier,Date,Category,Status,Channel,Uploader,Currency,Total\n';
  const body = rows
    .map((d) => [esc(d.supplier), esc(d.date), esc(d.category), esc(d.status), esc(d.source), esc(d.uploader), esc(d.currency), d.total].join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([header + body], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-published.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function RowButton({ icon: Icon, title, onClick, tone = 'plain' }: {
  icon: typeof Eye;
  title: string;
  onClick: () => void;
  tone?: 'plain' | 'amber';
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      aria-label={title}
      className={`p-2 rounded-lg border transition-colors ${
        tone === 'amber'
          ? 'text-amber-400 border-amber-400/20 bg-amber-400/10 hover:bg-amber-400/20'
          : 'text-zinc-400 border-white/5 hover:text-white hover:border-white/20 hover:bg-white/5'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}
