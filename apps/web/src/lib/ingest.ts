import { ATTRIBUTION_CONFIDENT, attributeClient } from './attribution';
import { isTabular } from './spreadsheet';
import type { Client, Document, DocKind, ExtractedField, RoutingRule, SourceChannel } from './types';

/** The ceiling an accountant working in the app gets, and the default. */
const ACCOUNTANT_UPLOAD_LIMIT = 100 * 1024 * 1024;

/** Per-channel size limits — asymmetric by design (PRD stage 1). */
export const CHANNEL_LIMITS: Record<string, number> = {
  'accountant-upload': ACCOUNTANT_UPLOAD_LIMIT,
  client: 25 * 1024 * 1024,
  vault: 100 * 1024 * 1024,
};

export const ACCEPTED_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'heic', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'zip', 'csv', 'xlsx',
];

export interface IngestResult {
  documents: Document[];
  rejected: { fileName: string; reason: string }[];
  /**
   * Spreadsheets, held back from the document pipeline entirely.
   *
   * A CSV has no page to photograph — there is nothing for extraction to do
   * with it, and one file is a hundred records rather than one. They are read
   * separately, row by row, and only become documents afterwards.
   */
  sheets: { fileName: string; file: File }[];
}

let ingestSeq = 0;

function hashString(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Turns uploaded files into documents entering the pipeline at stage 1.
 *
 * Multi-document PDFs are auto-split as standard, oversize files are rejected
 * visibly with a reason rather than silently dropped, and everything starts in
 * Processing until extraction lands.
 */
export interface IngestOptions {
  /** Size ceiling for the channel the files arrived on. */
  limit?: number;
  uploader?: string;
  /**
   * Omit on every client-facing channel. The business is sending paperwork,
   * not filing it — extraction works out whether it is money in or money out.
   * Supplied only where the accountant is already working in a named inbox.
   */
  kind?: DocKind;
  /** Carried through to the accountant so a client's note isn't lost. */
  clientNote?: string;
}

export function ingestFiles(
  files: { name: string; size: number; raw?: File }[],
  client: Client | undefined,
  source: SourceChannel,
  { limit = ACCOUNTANT_UPLOAD_LIMIT, uploader = 'You (web upload)', kind, clientNote }: IngestOptions = {},
): IngestResult {
  const documents: Document[] = [];
  const rejected: { fileName: string; reason: string }[] = [];
  const sheets: { fileName: string; file: File }[] = [];

  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      rejected.push({ fileName: file.name, reason: `Unsupported format .${ext}` });
      continue;
    }

    // A spreadsheet leaves here immediately — its rows are read, not scanned.
    if (isTabular(file.name)) {
      if (file.raw) sheets.push({ fileName: file.name, file: file.raw });
      else rejected.push({ fileName: file.name, reason: 'the file contents were not available to read' });
      continue;
    }
    if (file.size > limit) {
      rejected.push({
        fileName: file.name,
        reason: `Over the ${Math.round(limit / 1024 / 1024)}MB limit for this channel — use web upload or split it first`,
      });
      continue;
    }

    // Auto-split: a large PDF is treated as a batch of separate documents.
    const isPdf = ext === 'pdf';
    const parts = isPdf && file.size > 400 * 1024 ? Math.min(4, 2 + (hashString(file.name) % 3)) : 1;

    for (let i = 0; i < parts; i++) {
      documents.push({
        id: `ing-${Date.now()}-${ingestSeq++}`,
        clientId: client?.id ?? '',
        // Empty until extraction reads the addressee. There is no holding pen
        // for documents nobody owns — the bill-to block decides, the same way
        // it decides money in or money out.
        clientName: client?.name ?? '',
        supplier: 'Extracting…',
        date: '—',
        total: 0,
        category: '—',
        status: 'processing',
        statusNote: 'Extraction running — ETA under 5 min',
        source,
        uploader,
        currency: 'GBP',
        // Provisional when nobody said — extraction settles it, and until then
        // the document is not claimed by either inbox.
        kind: kind ?? 'cost',
        classifyKind: kind === undefined,
        classifyClient: client === undefined,
        uploadFileName: file.name,
        fields: [],
        lineItems: [],
        splitFrom: parts > 1 ? `${file.name} — document ${i + 1} of ${parts}` : undefined,
        clientNote: clientNote?.trim() || undefined,
      });
    }
  }

  return { documents, rejected, sheets };
}

const EXTRACTED_SUPPLIERS = ['Bidfood', 'Amazon Business', 'Currys', 'Adobe', 'Brakes', 'Screwfix', 'AWS', 'Uber', 'Costco'];
const EXTRACTED_CATEGORIES = ['Office Supplies', 'Cost of Sales Food', 'Software', 'Computer Equipment', 'Travel'];

/**
 * The result of extraction landing on a Processing document. Roughly a third
 * come back needing review, mirroring real correction rates.
 */
export function completeExtraction(
  doc: Document,
  clients: Client[] = [],
  routingRules: RoutingRule[] = [],
): Document {
  const h = hashString(doc.id);
  // Both lists are non-empty literals declared above, so a modulo of their own
  // length always lands on an entry.
  const supplier = EXTRACTED_SUPPLIERS[h % EXTRACTED_SUPPLIERS.length]!;
  const total = Math.round((40 + (h % 180000) / 100) * 100) / 100;
  const needsReview = h % 3 === 0;
  const category = needsReview ? '—' : EXTRACTED_CATEGORIES[h % EXTRACTED_CATEGORIES.length]!;

  /**
   * Money in or money out. Whoever sent the file was never asked — the
   * bill-to/from block says which it is, so classification belongs here with
   * the rest of the extraction, carrying a confidence like every other field.
   * A document the accountant filed into a named inbox keeps that decision.
   */
  const classified: DocKind = h % 5 === 0 ? 'sales' : 'cost';
  const kind: DocKind = doc.classifyKind ? classified : doc.kind;
  const kindConfidence = 0.88 + (h % 100) / 1000;

  const fields: ExtractedField[] = [
    { label: 'Supplier', value: supplier, confidence: 0.9 + (h % 90) / 1000, provenance: 'header block, page 1' },
    { label: 'Document date', value: '12 Aug 2026', confidence: 0.93, provenance: 'top-right, page 1' },
    { label: 'Invoice number', value: `INV-${100000 + (h % 899999)}`, confidence: 0.91, provenance: 'header block' },
    { label: 'Total', value: `£${total.toFixed(2)}`, confidence: 0.97, provenance: 'totals table' },
    { label: 'Tax amount', value: `£${(total * 0.2).toFixed(2)}`, confidence: 0.86, provenance: 'totals table' },
    ...(doc.classifyKind
      ? [{
          label: 'Document type',
          value: kind === 'sales' ? 'Money in — sales invoice' : 'Money out — bill or receipt',
          confidence: kindConfidence,
          provenance:
            kind === 'sales'
              ? 'bill-to block names a customer, not the client'
              : 'bill-to block names the client',
        }]
      : []),
    {
      label: 'Category',
      value: category,
      confidence: needsReview ? 0.23 : 0.88,
      provenance: needsReview ? 'no rule matched; new vendor' : 'learned history',
    },
  ];

  /**
   * Whose document this is, when nobody said at upload. Read off the page like
   * every other field, and carried with the confidence that produced it.
   */
  const attribution = doc.classifyClient
    ? attributeClient(doc, doc.uploadFileName ?? doc.splitFrom ?? doc.id, clients, routingRules)
    : null;
  const unsureWho = !!attribution && attribution.confidence < ATTRIBUTION_CONFIDENT;

  if (attribution) {
    fields.splice(1, 0, {
      label: 'Client',
      value: attribution.clientName,
      confidence: attribution.confidence,
      provenance: attribution.provenance,
    });
  }

  // A weak addressee outranks a missing category: publishing to the wrong
  // company's ledger is the more expensive mistake of the two.
  const note = unsureWho
    ? `Confirm the client — ${Math.round(attribution!.confidence * 100)}% sure this is ${attribution!.clientName}`
    : needsReview
    ? 'Missing Category'
    : undefined;

  return {
    ...doc,
    supplier,
    date: '12 Aug 2026',
    total,
    category,
    kind,
    clientId: attribution?.clientId ?? doc.clientId,
    clientName: attribution?.clientName ?? doc.clientName,
    classifyKind: undefined,
    classifyClient: undefined,
    uploadFileName: undefined,
    status: needsReview || unsureWho ? 'review' : 'ready',
    statusNote: note,
    fields,
  };
}
