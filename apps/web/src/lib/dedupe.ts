import { defineMessages, type IntlShape, type MessageDescriptor } from 'react-intl';
import type { Document, DuplicatePair } from './types';

/**
 * Stage 6 — duplicate detection.
 *
 * Dext's rule is a field match: receipts are duplicates when supplier, date,
 * total and uploader all agree; invoices when supplier, total and the document
 * reference agree. That rule has two well-known holes, both of which its users
 * complain about: if one copy failed to extract a key field the pair is missed
 * entirely, and an invoice is never matched to its receipt-formatted twin
 * (the 120-vote request).
 *
 * So the field rule is the baseline here, not the whole test. Every pair is
 * scored across several independent signals — file hash, perceptual image
 * hash, OCR-text similarity, amount and date proximity — and a pair clears the
 * bar on the weight of evidence rather than on one field being present. That
 * makes it survive a missing field, and it lets an invoice match a receipt,
 * because the document type is never required to agree.
 *
 * Nothing here deletes anything. Detection produces a flag with its score and
 * the signals behind it; what happens next is the `duplicateMode` setting and,
 * in review mode, a person's decision.
 *
 * ## Why `intl` is a parameter
 *
 * This is not a component, so it cannot call `useIntl` — every string below is
 * a `MessageDescriptor` (`i18n/index.ts`). Unlike `failures.ts`, the
 * descriptors cannot be handed to the caller unformatted: a signal is a
 * `DuplicatePair['signals']` entry, which is a plain string in the shared
 * contract, and half of them interpolate a value the detector alone knows —
 * the day gap, the OCR percentage, the two document types. So the caller
 * passes its `intl` in and gets finished sentences back, which is the second
 * shape §12.6 allows for a module that has no hooks of its own.
 */

const m = defineMessages({
  signalIdenticalTotal: { id: 'pipeline.dedupe.signalIdenticalTotal', defaultMessage: 'Identical total' },
  signalTotalsWithin: { id: 'pipeline.dedupe.signalTotalsWithin', defaultMessage: 'Totals within 2%' },
  signalSameSupplier: { id: 'pipeline.dedupe.signalSameSupplier', defaultMessage: 'Same supplier' },
  signalSupplierNamesClose: {
    id: 'pipeline.dedupe.signalSupplierNamesClose',
    defaultMessage: 'Supplier names close',
  },
  signalSameDate: { id: 'pipeline.dedupe.signalSameDate', defaultMessage: 'Same date' },
  // Was `Dates ${gap} day${gap === 1 ? '' : 's'} apart` — a plural built by
  // concatenation, which §12.6 forbids and which no locale whose plural rule is
  // not "add an s" can express. ICU states the rule once.
  signalDatesApart: {
    id: 'pipeline.dedupe.signalDatesApart',
    defaultMessage: '{days, plural, one {Dates # day apart} other {Dates # days apart}}',
  },
  signalOcrSimilar: { id: 'pipeline.dedupe.signalOcrSimilar', defaultMessage: 'OCR text {percent}% similar' },
  signalSameReference: { id: 'pipeline.dedupe.signalSameReference', defaultMessage: 'Same document reference' },
  signalFileHashMatch: { id: 'pipeline.dedupe.signalFileHashMatch', defaultMessage: 'File hash match' },
  signalFileHashDiffers: { id: 'pipeline.dedupe.signalFileHashDiffers', defaultMessage: 'File hash differs' },
  signalPerceptualHash: {
    id: 'pipeline.dedupe.signalPerceptualHash',
    defaultMessage: 'Perceptual hash near-match',
  },
  signalDifferentUploaders: {
    id: 'pipeline.dedupe.signalDifferentUploaders',
    defaultMessage: 'Different uploaders',
  },
  signalCrossType: { id: 'pipeline.dedupe.signalCrossType', defaultMessage: 'Cross-type: {left} ↔ {right}' },

  typeCreditNote: { id: 'pipeline.dedupe.typeCreditNote', defaultMessage: 'Credit note' },
  typeReceipt: { id: 'pipeline.dedupe.typeReceipt', defaultMessage: 'Receipt' },
  typeInvoice: { id: 'pipeline.dedupe.typeInvoice', defaultMessage: 'Invoice' },

  // The whole phrase, not the type name lowercased and stuck after the
  // supplier: lowercasing a noun is not a transformation every language allows
  // — German capitalises them — and the word order is exactly what differs.
  sideLabelCreditNote: { id: 'pipeline.dedupe.sideLabelCreditNote', defaultMessage: '{supplier} credit note' },
  sideLabelReceipt: { id: 'pipeline.dedupe.sideLabelReceipt', defaultMessage: '{supplier} receipt' },
  sideLabelInvoice: { id: 'pipeline.dedupe.sideLabelInvoice', defaultMessage: '{supplier} invoice' },
});

export interface DedupeSettings {
  /** How close two dates must be to count as the same spend. Dext: ±3–31. */
  dateToleranceDays: number;
  /** Score a pair must reach to be flagged at all. */
  threshold: number;
}

export const DEFAULT_DEDUPE_SETTINGS: DedupeSettings = {
  dateToleranceDays: 5,
  threshold: 0.55,
};

/** Weights sum to 1 — the score is readable as "how much of the evidence agrees". */
const WEIGHTS = {
  amount: 0.3,
  supplier: 0.22,
  date: 0.16,
  ocrText: 0.14,
  reference: 0.08,
  fileHash: 0.05,
  imageHash: 0.05,
};

export function detectDuplicates(
  intl: IntlShape,
  documents: Document[],
  settings: DedupeSettings = DEFAULT_DEDUPE_SETTINGS,
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  // Only documents that have been read are comparable — one still extracting
  // has nothing to compare on, and flagging it would be noise.
  const candidates = documents.filter((d) => d.status !== 'processing' && d.total > 0);

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      // Unreachable: both indices are bounded by the loop conditions and the
      // array is dense, having come straight out of filter().
      if (!a || !b) continue;

      // A duplicate is always within one client. The same invoice reaching two
      // different companies is two legitimate documents.
      if (a.clientId !== b.clientId) continue;
      // Money in and money out are never the same document.
      if (a.kind !== b.kind) continue;

      const verdict = compare(intl, a, b, settings);
      if (verdict.score < settings.threshold) continue;

      pairs.push({
        id: `dup-${a.id}-${b.id}`,
        clientName: a.clientName,
        similarity: Math.round(verdict.score * 100) / 100,
        signals: verdict.signals,
        crossType: typeOf(a) !== typeOf(b),
        left: side(intl, a),
        right: side(intl, b),
      });
    }
  }

  // Strongest evidence first — that is the order someone should work through.
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

interface Verdict {
  score: number;
  signals: string[];
}

function compare(intl: IntlShape, a: Document, b: Document, settings: DedupeSettings): Verdict {
  const signals: string[] = [];
  let score = 0;

  /* ── amount: the strongest single signal ────────────────────────────────── */
  const spread = Math.abs(a.total - b.total);
  const relative = spread / Math.max(a.total, b.total);
  if (spread < 0.005) {
    score += WEIGHTS.amount;
    signals.push(intl.formatMessage(m.signalIdenticalTotal));
  } else if (relative < 0.02) {
    // A rounding or FX difference on the same underlying spend.
    score += WEIGHTS.amount * 0.6;
    signals.push(intl.formatMessage(m.signalTotalsWithin));
  } else {
    // Different money is strong evidence *against*, so stop early rather than
    // accumulating weak agreement on everything else.
    return { score: 0, signals: [] };
  }

  /* ── supplier ───────────────────────────────────────────────────────────── */
  const supplierMatch = nameSimilarity(a.supplier, b.supplier);
  if (supplierMatch > 0.9) {
    score += WEIGHTS.supplier;
    signals.push(intl.formatMessage(m.signalSameSupplier));
  } else if (supplierMatch > 0.6) {
    score += WEIGHTS.supplier * 0.5;
    signals.push(intl.formatMessage(m.signalSupplierNamesClose));
  }

  /* ── date proximity ─────────────────────────────────────────────────────── */
  const gap = dayGap(a.date, b.date);
  if (gap === 0) {
    score += WEIGHTS.date;
    signals.push(intl.formatMessage(m.signalSameDate));
  } else if (gap !== null && gap <= settings.dateToleranceDays) {
    score += WEIGHTS.date * (1 - gap / (settings.dateToleranceDays + 1));
    signals.push(intl.formatMessage(m.signalDatesApart, { days: gap }));
  }

  /* ── OCR text similarity ────────────────────────────────────────────────── */
  const textMatch = textSimilarity(ocrText(a), ocrText(b));
  if (textMatch > 0.5) {
    score += WEIGHTS.ocrText * textMatch;
    signals.push(intl.formatMessage(m.signalOcrSimilar, { percent: Math.round(textMatch * 100) }));
  }

  /* ── document reference — Dext's invoice rule ───────────────────────────── */
  const refA = referenceOf(a);
  const refB = referenceOf(b);
  if (refA && refB && refA === refB) {
    score += WEIGHTS.reference;
    signals.push(intl.formatMessage(m.signalSameReference));
  }

  /* ── file hash: the same file sent twice ────────────────────────────────── */
  if (fileHash(a) === fileHash(b)) {
    score += WEIGHTS.fileHash;
    signals.push(intl.formatMessage(m.signalFileHashMatch));
  } else {
    signals.push(intl.formatMessage(m.signalFileHashDiffers));
  }

  /* ── perceptual hash: the same paper photographed twice ─────────────────── */
  if (isImage(a) && isImage(b) && perceptualHash(a) === perceptualHash(b)) {
    score += WEIGHTS.imageHash;
    signals.push(intl.formatMessage(m.signalPerceptualHash));
  }

  /* ── the two gaps this exists to close ──────────────────────────────────── */
  if (a.uploader !== b.uploader) signals.push(intl.formatMessage(m.signalDifferentUploaders));
  if (typeOf(a) !== typeOf(b)) {
    signals.push(
      intl.formatMessage(m.signalCrossType, {
        left: intl.formatMessage(TYPE_LABEL[typeOf(a)]),
        right: intl.formatMessage(TYPE_LABEL[typeOf(b)]),
      }),
    );
  }

  return { score: Math.min(1, score), signals };
}

/* ── signal helpers ───────────────────────────────────────────────────────── */

/**
 * Invoice, receipt or credit note — never required to agree, only reported.
 *
 * A key rather than the printed word: `crossType` compares two of these, and a
 * comparison that reads translated text is a comparison that changes answer
 * with the locale.
 */
type DocumentType = 'creditNote' | 'receipt' | 'invoice';

/**
 * The channel alone is not enough: a receipt scanned and emailed is still a
 * receipt. An invoice always carries a reference number, so the absence of one
 * is the better tell.
 */
function typeOf(d: Document): DocumentType {
  if (d.total < 0) return 'creditNote';
  if (isImage(d)) return 'receipt';
  return referenceOf(d) ? 'invoice' : 'receipt';
}

/** The type as a person reads it, on the pill and in the cross-type signal. */
const TYPE_LABEL: Record<DocumentType, MessageDescriptor> = {
  creditNote: m.typeCreditNote,
  receipt: m.typeReceipt,
  invoice: m.typeInvoice,
};

/** The whole side label, so the phrase is translated rather than assembled. */
const SIDE_LABEL: Record<DocumentType, MessageDescriptor> = {
  creditNote: m.sideLabelCreditNote,
  receipt: m.sideLabelReceipt,
  invoice: m.sideLabelInvoice,
};

const isImage = (d: Document) =>
  d.source === 'whatsapp' || d.source === 'sms-link' || /receipt|photo|\.(jpe?g|png|heic)/i.test(d.splitFrom ?? '');

/**
 * The text a reader would have pulled off the page: supplier, every extracted
 * value, and the line items. Comparing this is what survives one copy having
 * failed to extract a field the other has.
 */
function ocrText(d: Document): string {
  return [
    d.supplier,
    d.category,
    ...d.fields.map((f) => `${f.label} ${f.value}`),
    ...d.lineItems.map((l) => l.description),
  ]
    .join(' ')
    .toLowerCase();
}

/** Token overlap, which is stable against reordering and missing fields. */
function textSimilarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.split(/[^a-z0-9£.]+/).filter((t) => t.length > 2));
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  ta.forEach((t) => { if (tb.has(t)) shared++; });
  return shared / Math.max(ta.size, tb.size);
}

function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\b(ltd|limited|plc|llp|uk|group)\b/g, '').replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  return textSimilarity(a.toLowerCase(), b.toLowerCase());
}

function referenceOf(d: Document): string | null {
  const field = d.fields.find((f) => /invoice number|reference|document reference/i.test(f.label));
  return field && field.value !== '—' ? field.value.trim().toLowerCase() : null;
}

/**
 * Stand-ins for the real thing. A production build hashes the bytes and runs a
 * perceptual hash over the image; here both are derived deterministically so
 * the signal behaves consistently without the file itself.
 */
const fileHash = (d: Document) => hash(`${d.splitFrom ?? d.id}`);
const perceptualHash = (d: Document) => hash(`${d.supplier}|${d.total}|${d.date}`);

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Whole days between two "10 Aug 2026" strings, or null if either is unreadable. */
function dayGap(a: string, b: string): number | null {
  const parse = (s: string) => {
    // `parts`, not `m`: `m` is the message catalogue at module scope now.
    const parts = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
    if (!parts) return null;
    const [, day, mon, year] = parts;
    // Unreachable: none of the three groups is optional, so a match means all
    // three participated.
    if (!day || !mon || !year) return null;
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return null;
    return Date.UTC(Number(year), month, Number(day));
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  return Math.round(Math.abs(x - y) / 86400000);
}

const side = (intl: IntlShape, d: Document): DuplicatePair['left'] => ({
  id: d.id,
  label: intl.formatMessage(SIDE_LABEL[typeOf(d)], { supplier: d.supplier }),
  type: intl.formatMessage(TYPE_LABEL[typeOf(d)]),
  total: d.total,
  date: d.date,
  uploader: d.uploader,
});
