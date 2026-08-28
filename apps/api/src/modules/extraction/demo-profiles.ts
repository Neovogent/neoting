/**
 * The demo document profiles (METH Stage 4). Deterministic UK document fixtures
 * keyed by a filename keyword, with a hash-derived generic fallback so ANY upload
 * still flows. Aligns exactly with the demo cast (METH_MODE.md §7): Currys £1,299,
 * Google Ads £600, Bidfood, Adobe, Shell, Just Eat — plus one To-Review profile
 * (a failed VAT-arithmetic validator, which readiness treats as not-ready) and one
 * Failed profile (unreadable).
 *
 * // DEMO-MOCK: every value here is hand-authored fixture data. Textract + the
 * // vision ladder produces these fields for real post-demo.
 */

import type { DocumentType } from '@prisma/client';

import {
  aiField,
  type CodingSuggestion,
  type ExtractedDocument,
  type ExtractedField,
  type ExtractedLineItem,
  type ExtractionOutcome,
  type ValidatorVerdict,
} from './document-extractor.js';

/** The knobs a profile sets; everything else is assembled by {@link buildDocument}. */
interface ProfileSpec {
  readonly docType: DocumentType;
  readonly supplierName: string;
  readonly customerName?: string;
  readonly documentDate: string; // YYYY-MM-DD
  readonly dueDate?: string;
  readonly currency: string;
  readonly totalPence: number;
  readonly taxPence: number;
  readonly reference: string;
  readonly vatNumber: string;
  /** The extractor's default coding (a supplier rule may override it in the pipeline). */
  readonly categoryCode: string;
  readonly overallConfidence: number;
  readonly lineItems: ReadonlyArray<{ readonly description: string; readonly quantity: number; readonly totalPence: number; readonly taxPence: number }>;
  /** Set when a deterministic validator fails — pushes the document to To Review. */
  readonly vatArithmeticFails?: boolean;
}

function lineItem(item: ProfileSpec['lineItems'][number], confidence: number): ExtractedLineItem {
  return {
    description: aiField(item.description, confidence),
    quantity: aiField(item.quantity, confidence),
    totalPence: aiField(item.totalPence, confidence),
    taxPence: aiField(item.taxPence, confidence),
  };
}

function buildDocument(spec: ProfileSpec): ExtractedDocument {
  const c = spec.overallConfidence;
  const fields: Record<string, ExtractedField> = {
    docType: aiField(spec.docType, c),
    supplierName: aiField(spec.supplierName, c),
    documentDate: aiField(spec.documentDate, c),
    currency: aiField(spec.currency, c),
    totalPence: aiField(spec.totalPence, c),
    taxPence: aiField(spec.taxPence, c),
    reference: aiField(spec.reference, c),
    vatNumber: aiField(spec.vatNumber, c),
    ...(spec.customerName === undefined ? {} : { customerName: aiField(spec.customerName, c) }),
    ...(spec.dueDate === undefined ? {} : { dueDate: aiField(spec.dueDate, c) }),
  };

  // VAT arithmetic to ±1p: gross − net must equal the tax. The To-Review profile
  // sets vatArithmeticFails, and readiness blocks READY on a failed validator
  // regardless of field presence — the eval-calibrated confidence seam stays empty.
  const vatArithmetic: ValidatorVerdict = spec.vatArithmeticFails
    ? { ok: false, detail: 'declared VAT does not reconcile with net + gross (±1p) — needs a human' }
    : { ok: true };
  const validatorResults: Record<string, ValidatorVerdict> = {
    vatArithmetic,
    vrnChecksum: { ok: true },
    datePlausible: { ok: true },
    currencyAgreement: { ok: true },
  };

  const suggestions: CodingSuggestion[] = [
    {
      field: 'categoryCode',
      value: spec.categoryCode,
      confidence: c,
      reasoning: `${spec.supplierName} documents are coded ${spec.categoryCode} by default (demo profile).`,
    },
  ];

  return {
    docType: spec.docType,
    supplierName: spec.supplierName,
    customerName: spec.customerName ?? null,
    documentDate: spec.documentDate,
    dueDate: spec.dueDate ?? null,
    currency: spec.currency,
    totalPence: spec.totalPence,
    taxPence: spec.taxPence,
    reference: spec.reference,
    vatNumber: spec.vatNumber,
    categoryCode: spec.categoryCode,
    fields,
    lineItems: spec.lineItems.map((item) => lineItem(item, c)),
    validatorResults,
    validatorFailed: Object.values(validatorResults).some((v) => !v.ok),
    overallConfidence: c,
    suggestions,
  };
}

/** A profile is a function so a failure profile can return a failure outcome. */
export type DemoProfile = () => ExtractionOutcome;

const ok = (spec: ProfileSpec): DemoProfile => () => ({ ok: true, document: buildDocument(spec) });

/** Just Eat, registered under both `just-eat`/`just eat` (token `just`) and `justeat`. */
const justEat = ok({
  docType: 'OTHER',
  supplierName: 'Just Eat',
  customerName: 'American Burger Ltd',
  documentDate: '2026-08-10',
  currency: 'GBP',
  totalPence: 128_400,
  taxPence: 0,
  reference: 'JE-PAYOUT-5521',
  vatNumber: 'GB864792301',
  categoryCode: 'SALES_INCOME',
  overallConfidence: 0.88,
  lineItems: [{ description: 'Weekly payout (net of commission)', quantity: 1, totalPence: 128_400, taxPence: 0 }],
});

/**
 * Keyword → profile. First matching keyword in a lowercased filename wins, so
 * `currys-receipt.jpg` and `Currys Receipt (1).JPG` resolve to the same profile —
 * the determinism the mocking doctrine requires (same input → same output).
 */
export const DEMO_PROFILES: ReadonlyArray<readonly [keyword: string, profile: DemoProfile]> = [
  [
    'currys',
    ok({
      docType: 'RECEIPT',
      supplierName: 'Currys',
      customerName: 'American Burger Ltd',
      documentDate: '2026-08-09',
      currency: 'GBP',
      totalPence: 129_900,
      taxPence: 21_650,
      reference: 'CUR-88213',
      vatNumber: 'GB614571837',
      categoryCode: 'OFFICE_EQUIPMENT',
      overallConfidence: 0.96,
      lineItems: [
        { description: 'Commercial chest freezer', quantity: 1, totalPence: 99_900, taxPence: 16_650 },
        { description: 'Extended warranty (3yr)', quantity: 1, totalPence: 30_000, taxPence: 5_000 },
      ],
    }),
  ],
  [
    'google',
    ok({
      docType: 'INVOICE',
      supplierName: 'Google',
      customerName: 'American Burger Ltd',
      documentDate: '2026-08-05',
      dueDate: '2026-08-19',
      currency: 'GBP',
      totalPence: 60_000,
      taxPence: 10_000,
      reference: 'GOOG-ADS-40021',
      vatNumber: 'GB980375908',
      categoryCode: 'ADVERTISING',
      overallConfidence: 0.95,
      lineItems: [{ description: 'Google Ads — July campaign', quantity: 1, totalPence: 60_000, taxPence: 10_000 }],
    }),
  ],
  [
    'bidfood',
    ok({
      docType: 'INVOICE',
      supplierName: 'Bidfood',
      customerName: 'American Burger Ltd',
      documentDate: '2026-08-12',
      dueDate: '2026-09-11',
      currency: 'GBP',
      totalPence: 45_672,
      taxPence: 0, // most food is zero-rated — a real UK wrinkle worth showing
      reference: 'BF-2208841',
      vatNumber: 'GB233902611',
      categoryCode: 'GENERAL_EXPENSES', // the Stage-13 rule overrides this to Cost of Sales Food
      overallConfidence: 0.93,
      lineItems: [
        { description: 'Beef patties 4oz (case)', quantity: 6, totalPence: 28_800, taxPence: 0 },
        { description: 'Brioche buns (tray)', quantity: 8, totalPence: 12_872, taxPence: 0 },
        { description: 'Cleaning supplies', quantity: 2, totalPence: 4_000, taxPence: 0 },
      ],
    }),
  ],
  [
    'adobe',
    ok({
      docType: 'INVOICE',
      supplierName: 'Adobe',
      documentDate: '2026-08-01',
      dueDate: '2026-08-01',
      currency: 'GBP',
      totalPence: 5_994,
      taxPence: 999,
      reference: 'ADBE-INV-7781',
      vatNumber: 'GB123456789',
      categoryCode: 'SOFTWARE',
      overallConfidence: 0.97,
      lineItems: [{ description: 'Creative Cloud — monthly', quantity: 1, totalPence: 5_994, taxPence: 999 }],
    }),
  ],
  [
    'shell',
    ok({
      docType: 'RECEIPT',
      supplierName: 'Shell',
      documentDate: '2026-08-07',
      currency: 'GBP',
      totalPence: 7_250,
      taxPence: 1_208,
      reference: 'SHELL-0093312',
      vatNumber: 'GB235923556',
      categoryCode: 'MOTOR_FUEL',
      overallConfidence: 0.9,
      lineItems: [{ description: 'Unleaded petrol 41.2L', quantity: 1, totalPence: 7_250, taxPence: 1_208 }],
    }),
  ],
  ['just', justEat], // "just-eat-payout" / "just eat" → token `just`
  ['justeat', justEat], // "justeat-payout" → token `justeat`
  [
    'lowconf', // the To-Review profile — a validator says the VAT does not reconcile
    ok({
      docType: 'INVOICE',
      supplierName: 'Metro Cash & Carry',
      documentDate: '2026-08-08',
      currency: 'GBP',
      totalPence: 8_940,
      taxPence: 1_490,
      reference: 'MET-illegible',
      vatNumber: 'GB000000000',
      categoryCode: 'GENERAL_EXPENSES',
      overallConfidence: 0.61,
      vatArithmeticFails: true,
      lineItems: [{ description: 'Sundry (partially illegible)', quantity: 1, totalPence: 8_940, taxPence: 1_490 }],
    }),
  ],
  /**
   * A bank statement, so the fixture path can reach the statement importer.
   *
   * Without this every statement fell through to the generic profile, which
   * classifies `INVOICE` — so `statement-step` saw a non-STATEMENT document,
   * answered "not mine", and the D40 import lane was unreachable in fixture
   * mode. The header fields are deliberately thin: a statement has no supplier
   * and no single total, and inventing one would put a figure on the document
   * card that contradicts the transactions imported from it. The rows are the
   * point, and they come from the file itself, deterministically.
   *
   * ⚠ **LAST in the list, deliberately.** First matching keyword wins, and a
   * real upload is called `Just Eat statement.pdf` — a supplier document that
   * happens to carry the word. Placing this first classified it STATEMENT and
   * broke `demo-extractor.test.ts`, which exists for exactly this footgun. Only
   * a file matching no supplier keyword falls through to here.
   */
  [
    'statement',
    ok({
      docType: 'STATEMENT',
      // The spec's fields are non-nullable, so a statement's absent header is
      // expressed as the emptiest honest value rather than a made-up supplier.
      // Nothing downstream reads these for a STATEMENT document: the rows come
      // from the file, and `statement-ingest` never looks at the extraction.
      supplierName: '',
      customerName: '',
      documentDate: '',
      currency: 'GBP',
      totalPence: 0,
      taxPence: 0,
      reference: '',
      vatNumber: '',
      categoryCode: 'BANK',
      overallConfidence: 0.99,
      lineItems: [],
    }),
  ],
];

/** Filename keywords that model an unreadable document — lands it FAILED. */
export const FAILURE_KEYWORDS: readonly string[] = ['corrupt', 'blurry', 'unreadable', 'blank'];

/**
 * The hash-derived generic profile for any filename that matches no keyword.
 * Deterministic in the byte hash so the same file always reads the same way, and
 * always confidently coded so an arbitrary demo upload still reaches READY.
 */
export function genericProfile(byteHash: string): DemoProfile {
  const seed = Number.parseInt(byteHash.slice(0, 6), 16) || 0;
  const totalPence = 5_000 + (seed % 45_000);
  // VAT portion of a 20% gross, integer arithmetic (R5): gross × 20 ÷ 120, one round.
  const taxPence = Math.round((totalPence * 20) / 120);
  return ok({
    docType: 'INVOICE',
    supplierName: `Supplier ${byteHash.slice(0, 6).toUpperCase()}`,
    documentDate: '2026-08-06',
    currency: 'GBP',
    totalPence,
    taxPence,
    reference: `GEN-${byteHash.slice(0, 8).toUpperCase()}`,
    vatNumber: 'GB111222333',
    categoryCode: 'GENERAL_EXPENSES',
    overallConfidence: 0.8,
    lineItems: [{ description: 'Goods and services', quantity: 1, totalPence, taxPence }],
  });
}
