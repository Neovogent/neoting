import type { VatReturnBoxes } from '@neoting/contracts/model';

/**
 * VAT return computation — pure, integer pence throughout.
 *
 * Money only leaves pence at the HMRC boundary (`hmrcMoney`, `hmrcWholePounds`,
 * `hmrcReturnBody`), and it does so by string formatting over integers, never
 * by dividing into a float.
 */

export type VatScheme = 'STANDARD' | 'CASH' | 'FLAT_RATE';
export type VatFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type AdjustableBox = 1 | 2 | 4 | 6 | 7 | 8 | 9;

export interface VatDocument {
  readonly id: string;
  readonly label: string;
  /** `YYYY-MM-DD` or null. */
  readonly date: string | null;
  readonly inbox: 'SALES' | 'COSTS' | 'UNROUTED';
  readonly creditNote: boolean;
  readonly totalPence: number | null;
  readonly taxPence: number | null;
  readonly currency: string | null;
  readonly categoryCode: string | null;
  readonly state: string;
  /** Cash accounting only: the absolute amount paid inside the period. */
  readonly paidPence?: number;
}

export interface VatAdjustmentLine {
  readonly box: AdjustableBox;
  readonly amountPence: number;
  readonly reason: string;
}

export interface VatLine {
  readonly documentId: string;
  readonly label: string;
  readonly date: string | null;
  readonly inbox: 'SALES' | 'COSTS';
  /** Signed contribution to each box, pence. */
  readonly box1Pence: number;
  readonly box4Pence: number;
  readonly box6Pence: number;
  readonly box7Pence: number;
  readonly flags: readonly string[];
}

export interface ComputedReturn {
  readonly boxes: VatReturnBoxes;
  readonly lines: readonly VatLine[];
  readonly warnings: readonly string[];
  readonly documentCount: number;
}

const COUNTED_STATES = new Set(['READY', 'PUBLISHED']);

export function computeReturn(
  scheme: VatScheme,
  flatRateBasisPoints: number | null,
  documents: readonly VatDocument[],
  adjustments: readonly VatAdjustmentLine[],
): ComputedReturn {
  if (scheme === 'FLAT_RATE' && (flatRateBasisPoints === null || !Number.isInteger(flatRateBasisPoints))) {
    throw new Error('the Flat Rate Scheme needs a flat-rate percentage before a return can be computed');
  }

  let box1 = 0;
  let box2 = 0;
  let box4 = 0;
  let box6 = 0;
  let box7 = 0;
  let box8 = 0;
  let box9 = 0;
  let flatTurnover = 0;
  const lines: VatLine[] = [];
  const skipped = { inReview: 0, unrouted: 0, foreign: 0, noTotal: 0 };
  let uncategorised = 0;
  let zeroVat = 0;
  let noVatRead = 0;

  for (const doc of documents) {
    if (!COUNTED_STATES.has(doc.state)) {
      skipped.inReview += 1;
      continue;
    }
    if (doc.inbox === 'UNROUTED') {
      skipped.unrouted += 1;
      continue;
    }
    if (doc.currency !== null && doc.currency.toUpperCase() !== 'GBP') {
      skipped.foreign += 1;
      continue;
    }
    if (doc.totalPence === null || doc.totalPence === 0) {
      skipped.noTotal += 1;
      continue;
    }

    const flags: string[] = [];
    if (doc.categoryCode === null || doc.categoryCode.trim() === '') {
      uncategorised += 1;
      flags.push('Uncategorised');
    }
    if (doc.taxPence === null) {
      noVatRead += 1;
      flags.push('No VAT amount read — treated as zero');
    } else if (doc.taxPence === 0) {
      zeroVat += 1;
      flags.push('No VAT — check it is zero-rated or exempt');
    }

    const sign = doc.creditNote ? -1 : 1;
    let gross = sign * Math.abs(doc.totalPence);
    let vat = sign * Math.abs(doc.taxPence ?? 0);
    if (scheme === 'CASH') {
      // ponytail: a payment is applied pro rata to the document's VAT; a batch
      // payment covering several invoices is capped at each invoice's total.
      const total = Math.abs(doc.totalPence);
      const paid = Math.min(total, Math.abs(doc.paidPence ?? 0));
      gross = Math.round((gross * paid) / total);
      vat = Math.round((vat * paid) / total);
      if (paid < total) flags.push('Part-paid in this period');
    }
    const net = gross - vat;

    let c1 = 0;
    let c4 = 0;
    let c6 = 0;
    let c7 = 0;
    if (scheme === 'FLAT_RATE') {
      // FRS: box 6 is VAT-INCLUSIVE turnover, box 1 the flat % of it; input VAT
      // is not reclaimed (capital assets over £2,000 go in as an adjustment).
      if (doc.inbox === 'SALES') {
        c6 = gross;
        flatTurnover += gross;
      } else {
        c7 = gross;
      }
    } else if (doc.inbox === 'SALES') {
      c1 = vat;
      c6 = net;
    } else {
      c4 = vat;
      c7 = net;
    }
    box1 += c1;
    box4 += c4;
    box6 += c6;
    box7 += c7;
    lines.push({
      documentId: doc.id,
      label: doc.label,
      date: doc.date,
      inbox: doc.inbox,
      box1Pence: c1,
      box4Pence: c4,
      box6Pence: c6,
      box7Pence: c7,
      flags,
    });
  }

  if (scheme === 'FLAT_RATE') {
    box1 = Math.round((flatTurnover * (flatRateBasisPoints as number)) / 10000);
  }

  for (const adj of adjustments) {
    if (adj.box === 1) box1 += adj.amountPence;
    else if (adj.box === 2) box2 += adj.amountPence;
    else if (adj.box === 4) box4 += adj.amountPence;
    else if (adj.box === 6) box6 += adj.amountPence;
    else if (adj.box === 7) box7 += adj.amountPence;
    else if (adj.box === 8) box8 += adj.amountPence;
    else box9 += adj.amountPence;
  }

  const warnings: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (skipped.inReview > 0)
    warnings.push(`${plural(skipped.inReview, 'document is', 'documents are')} still being reviewed and not included.`);
  if (skipped.unrouted > 0)
    warnings.push(`${plural(skipped.unrouted, 'document has', 'documents have')} not been sorted into sales or costs and not included.`);
  if (skipped.foreign > 0)
    warnings.push(`${plural(skipped.foreign, 'document is', 'documents are')} not in pounds sterling and not included — add them as an adjustment.`);
  if (skipped.noTotal > 0) warnings.push(`${plural(skipped.noTotal, 'document has', 'documents have')} no total and are not included.`);
  if (uncategorised > 0) warnings.push(`${plural(uncategorised, 'document is', 'documents are')} uncategorised.`);
  if (noVatRead > 0) warnings.push(`${plural(noVatRead, 'document has', 'documents have')} no VAT amount read — treated as zero.`);
  if (zeroVat > 0 && scheme !== 'FLAT_RATE')
    warnings.push(`${plural(zeroVat, 'document carries', 'documents carry')} no VAT — check each is zero-rated or exempt.`);
  if (adjustments.length > 0) warnings.push(`${plural(adjustments.length, 'manual adjustment is', 'manual adjustments are')} included.`);

  return { boxes: finaliseBoxes({ box1, box2, box4, box6, box7, box8, box9 }), lines, warnings, documentCount: lines.length };
}

/** Boxes 3 and 5 derived; boxes 6–9 cut to whole pounds (HMRC takes no pence there). */
export function finaliseBoxes(b: {
  box1: number;
  box2: number;
  box4: number;
  box6: number;
  box7: number;
  box8: number;
  box9: number;
}): VatReturnBoxes {
  const box3 = b.box1 + b.box2;
  return {
    vatDueSalesPence: b.box1,
    vatDueAcquisitionsPence: b.box2,
    totalVatDuePence: box3,
    vatReclaimedCurrPeriodPence: b.box4,
    netVatDuePence: Math.abs(box3 - b.box4),
    totalValueSalesExVatPence: wholePoundsInPence(b.box6),
    totalValuePurchasesExVatPence: wholePoundsInPence(b.box7),
    totalValueGoodsSuppliedExVatPence: wholePoundsInPence(b.box8),
    totalAcquisitionsExVatPence: wholePoundsInPence(b.box9),
  };
}

/** Truncate toward zero to whole pounds, staying in pence. */
function wholePoundsInPence(pence: number): number {
  const kept = pence - (pence % 100);
  return kept === 0 ? 0 : kept; // never -0
}

// ── The HMRC boundary ────────────────────────────────────────────────────────

/** Pence → HMRC's 2-dp pounds, e.g. 10550 → "105.50", -45 → "-0.45". Integer maths only. */
export function hmrcMoney(pence: number): string {
  if (!Number.isSafeInteger(pence)) throw new Error('money must be integer pence');
  const abs = Math.abs(pence);
  const pounds = (abs - (abs % 100)) / 100;
  return `${pence < 0 ? '-' : ''}${pounds}.${String(abs % 100).padStart(2, '0')}`;
}

/** Pence → HMRC's whole pounds (boxes 6–9), truncated toward zero. */
export function hmrcWholePounds(pence: number): string {
  if (!Number.isSafeInteger(pence)) throw new Error('money must be integer pence');
  const kept = wholePoundsInPence(pence);
  return String(kept / 100);
}

/** HMRC's number (pounds, ≤ 2dp) → integer pence. The ONE place a float meets money. */
export function hmrcToPence(pounds: number): number {
  return Math.round(pounds * 100);
}

/**
 * The submit-return body, built as a string so every figure is the exact
 * decimal produced by integer formatting — `JSON.stringify(105.5)` would be
 * valid too, but would round-trip the value through a float on our side.
 */
export function hmrcReturnBody(periodKey: string, b: VatReturnBoxes): string {
  return (
    `{"periodKey":${JSON.stringify(periodKey)}` +
    `,"vatDueSales":${hmrcMoney(b.vatDueSalesPence)}` +
    `,"vatDueAcquisitions":${hmrcMoney(b.vatDueAcquisitionsPence)}` +
    `,"totalVatDue":${hmrcMoney(b.totalVatDuePence)}` +
    `,"vatReclaimedCurrPeriod":${hmrcMoney(b.vatReclaimedCurrPeriodPence)}` +
    `,"netVatDue":${hmrcMoney(b.netVatDuePence)}` +
    `,"totalValueSalesExVAT":${hmrcWholePounds(b.totalValueSalesExVatPence)}` +
    `,"totalValuePurchasesExVAT":${hmrcWholePounds(b.totalValuePurchasesExVatPence)}` +
    `,"totalValueGoodsSuppliedExVAT":${hmrcWholePounds(b.totalValueGoodsSuppliedExVatPence)}` +
    `,"totalAcquisitionsExVAT":${hmrcWholePounds(b.totalAcquisitionsExVatPence)}` +
    `,"finalised":true}`
  );
}

// ── Periods ──────────────────────────────────────────────────────────────────

const PERIOD_MONTHS: Record<VatFrequency, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/**
 * The current VAT period and the ones before it, from the stagger alone — for
 * a client not (yet) connected to HMRC. Connected clients use HMRC's own
 * obligations, which are authoritative.
 */
export function localPeriods(
  frequency: VatFrequency,
  periodEndMonth: number,
  today: Date,
  count = 4,
): { start: string; end: string }[] {
  const len = PERIOD_MONTHS[frequency];
  let idx = today.getUTCFullYear() * 12 + today.getUTCMonth();
  while (((idx % 12) + 1 - periodEndMonth + 12) % 12 % len !== 0) idx += 1;
  const out: { start: string; end: string }[] = [];
  for (let i = 0; i < count; i += 1, idx -= len) {
    const startIdx = idx - len + 1;
    const start = new Date(Date.UTC(Math.floor(startIdx / 12), startIdx % 12, 1));
    const end = new Date(Date.UTC(Math.floor(idx / 12), (idx % 12) + 1, 0));
    out.push({ start: isoDate(start), end: isoDate(end) });
  }
  return out;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
