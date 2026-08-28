import { describe, expect, it, test } from 'vitest';

import { getDocumentResponse } from '@neoting/contracts/zod';

import {
  FIELD_PRESENTATION,
  isEditableLabel,
  parseCodingDraft,
  parseDocumentDetail,
  ruleIdFromEvents,
  toDetailData,
} from './document-detail';

/**
 * The detail boundary (METH S7): the accepted extraction becoming the rows the
 * overlay renders, and a typed correction becoming the exact
 * `UpdateCodingPayload.fields` a proposal carries. Money crosses in both
 * directions here, which is reason enough for the suite on its own.
 */

const aiField = (value: string | number | boolean | null, confidence = 0.94) => ({
  value,
  provenance: 'AI_SUGGESTED' as const,
  confidence,
  source: 'demo-extractor-1',
});

const WIRE_DOC = {
  id: 'doc_currys',
  businessId: 'biz_burger',
  inbox: 'COSTS',
  state: 'READY',
  docType: 'RECEIPT',
  channel: 'WEB_UPLOAD',
  originalFilename: 'currys-receipt.jpg',
  receivedAt: '2026-08-19T09:00:00.000Z',
  supplierName: 'Currys',
  customerName: null,
  documentDate: '2026-08-09',
  dueDate: null,
  currency: 'GBP',
  totalPence: 129_900,
  taxPence: 21_650,
  reference: 'CR-4417',
  categoryCode: 'OFFICE_EQUIPMENT',
  mimeType: 'image/jpeg',
  byteSize: 1024,
  byteHash: 'a'.repeat(64),
  createdAt: '2026-08-19T09:00:00.000Z',
  updatedAt: '2026-08-19T09:00:05.000Z',
  retryable: false,
  acceptedExtraction: {
    id: 'ext_1',
    documentId: 'doc_currys',
    extractorKind: 'demo-extractor',
    modelVersion: 'demo-extractor-1',
    overallConfidence: 0.94,
    isAccepted: true,
    createdAt: '2026-08-19T09:00:04.000Z',
    fields: {
      supplierName: aiField('Currys'),
      documentDate: aiField('2026-08-09'),
      totalPence: aiField(129_900),
      taxPence: aiField(21_650),
      currency: aiField('GBP'),
      reference: aiField('CR-4417'),
      vatNumber: aiField('GB123456789'),
    },
    lineItems: [
      {
        description: aiField('Commercial chest freezer'),
        quantity: aiField(1),
        totalPence: aiField(99_900),
        taxPence: aiField(16_650),
      },
    ],
  },
  // The fields the mapper never reads may be absent — this object is typed at
  // the call site, not parsed, so the cast below mirrors the hook's own use.
} as unknown as Parameters<typeof toDetailData>[0];

describe('toDetailData', () => {
  it('renders money as pounds, dates as the house format, and keeps labels the readiness rules match on', () => {
    const detail = toDetailData(WIRE_DOC, null);
    const byLabel = new Map(detail.fields.map((f) => [f.label, f]));

    expect(byLabel.get('Supplier')?.value).toBe('Currys');
    expect(byLabel.get('Total')?.value).toBe('£1,299.00');
    expect(byLabel.get('Tax amount')?.value).toBe('£216.50');
    expect(byLabel.get('Document date')?.value).toBe('09 Aug 2026');
    expect(byLabel.get('Invoice number')?.value).toBe('CR-4417');
  });

  it('carries per-field confidence and names the provenance class (§13.3)', () => {
    const detail = toDetailData(WIRE_DOC, null);
    const supplier = detail.fields.find((f) => f.label === 'Supplier');

    expect(supplier?.confidence).toBe(0.94);
    expect(supplier?.provenance).toBe('AI suggested: demo-extractor-1');
  });

  it('shows a corrected value as human-confirmed with certainty, never a probability', () => {
    const corrected = {
      ...WIRE_DOC,
      acceptedExtraction: {
        ...WIRE_DOC.acceptedExtraction!,
        fields: {
          ...WIRE_DOC.acceptedExtraction!.fields,
          supplierName: {
            value: 'Currys PC World',
            provenance: 'HUMAN_CONFIRMED',
            confidence: null,
            source: 'proposal:prop_1',
            wasCorrected: true,
          },
        },
      },
    } as typeof WIRE_DOC;

    const supplier = toDetailData(corrected, null).fields.find((f) => f.label === 'Supplier');
    expect(supplier?.value).toBe('Currys PC World');
    expect(supplier?.confidence).toBe(1);
    expect(supplier?.provenance).toBe('human confirmed — corrected in review');
  });

  it('answers Category from the header, citing the rule when the extract event recorded one', () => {
    const withRule = toDetailData(WIRE_DOC, 'rule_bidfood').fields.find((f) => f.label === 'Category');
    expect(withRule?.value).toBe('OFFICE_EQUIPMENT');
    expect(withRule?.provenance).toBe('supplier rule: rule_bidfood');
    expect(withRule?.confidence).toBe(1);

    const withoutRule = toDetailData(WIRE_DOC, null).fields.find((f) => f.label === 'Category');
    expect(withoutRule?.provenance).toBe('AI suggested: demo-extractor-1');
    expect(withoutRule?.confidence).toBe(0.94);
  });

  it('reads line items with pence becoming pounds exactly once', () => {
    const detail = toDetailData(WIRE_DOC, null);
    expect(detail.lineItems).toEqual([
      { description: 'Commercial chest freezer', quantity: 1, total: 999, tax: 166.5 },
    ]);
  });

  it('renders an unextracted document as no fields, not invented ones', () => {
    const bare = { ...WIRE_DOC, acceptedExtraction: null } as typeof WIRE_DOC;
    expect(toDetailData(bare, null).fields).toEqual([]);
    expect(toDetailData(bare, null).lineItems).toEqual([]);
  });
});

describe('ruleIdFromEvents', () => {
  it('finds the recorded rule on the extract stage and nothing else', () => {
    expect(
      ruleIdFromEvents([
        { stage: 'route', detail: { sourceRuleId: 'not-this-one' } },
        { stage: 'extract', detail: { sourceRuleId: 'rule_bidfood' } },
      ]),
    ).toBe('rule_bidfood');
    expect(ruleIdFromEvents([{ stage: 'extract', detail: {} }])).toBeNull();
    expect(ruleIdFromEvents([])).toBeNull();
  });
});

describe('parseCodingDraft — the pounds → pence boundary and its refusals', () => {
  it('turns typed pounds into integer pence, however a person writes them', () => {
    for (const draft of ['1299', '1299.00', '£1,299.00', ' £1299 ']) {
      const parsed = parseCodingDraft('Total', draft);
      expect(parsed).toMatchObject({ ok: true, fields: { totalPence: 129_900 }, display: '£1,299.00' });
    }
  });

  it('never produces a fractional penny', () => {
    const parsed = parseCodingDraft('Total', '12.99');
    expect(parsed.ok && Number.isInteger((parsed.fields as { totalPence?: number }).totalPence)).toBe(true);
  });

  it('refuses a value that is not money, with the reason named', () => {
    expect(parseCodingDraft('Total', 'about twelve quid')).toEqual({ ok: false, problem: 'not-money' });
    expect(parseCodingDraft('Total', '12.999')).toEqual({ ok: false, problem: 'not-money' });
  });

  it('accepts both date shapes and emits the contract calendar date', () => {
    expect(parseCodingDraft('Document date', '2026-08-09')).toMatchObject({ ok: true, fields: { documentDate: '2026-08-09' } });
    expect(parseCodingDraft('Document date', '9 Aug 2026')).toMatchObject({
      ok: true,
      fields: { documentDate: '2026-08-09' },
      display: '09 Aug 2026',
    });
    expect(parseCodingDraft('Document date', '09/08/2026')).toEqual({ ok: false, problem: 'not-date' });
  });

  it('normalises currency and document type, and refuses what the contract would', () => {
    expect(parseCodingDraft('Currency', 'gbp')).toMatchObject({ ok: true, fields: { currency: 'GBP' } });
    expect(parseCodingDraft('Currency', 'pounds')).toEqual({ ok: false, problem: 'not-currency' });
    expect(parseCodingDraft('Type', 'credit note')).toMatchObject({ ok: true, fields: { docType: 'CREDIT_NOTE' } });
    expect(parseCodingDraft('Type', 'novel')).toEqual({ ok: false, problem: 'not-doc-type' });
  });

  it('refuses an empty correction — corrections carry values, never deletions', () => {
    expect(parseCodingDraft('Supplier', '  ')).toEqual({ ok: false, problem: 'empty' });
    expect(parseCodingDraft('Supplier', '—')).toEqual({ ok: false, problem: 'empty' });
  });

  it('refuses the fields the contract has no correction path for', () => {
    expect(parseCodingDraft('VAT number', 'GB123')).toEqual({ ok: false, problem: 'not-editable' });
    expect(isEditableLabel('VAT number')).toBe(false);
    expect(isEditableLabel('Category')).toBe(true);
  });
});

describe('the presentation table', () => {
  it('keeps the labels the readiness rules and seeds compare against, byte for byte', () => {
    const labels = FIELD_PRESENTATION.map((p) => p.label);
    // `missingMandatory` and the mandatory-fields config match on these exact
    // strings; the synthetic seeds carry the same ones. Renaming a label here
    // silently breaks readiness in live mode — this pin makes it loud.
    expect(labels).toContain('Supplier');
    expect(labels).toContain('Total');
    expect(labels).toContain('Category');
  });
});

/* ── The allOf/strict generator gap ───────────────────────────────────────── */

test('a valid document parses — the composed schema alone refuses it', () => {
  // `Document` is `allOf: [DocumentSummary, {…}]`, which orval emits as an
  // intersection of two `.strict()` halves. Each rejects the other's keys, so
  // the composed parse fails on a body that is entirely correct — and the
  // screen rendered "No fields extracted" over a document the server had sent
  // in full. This pins BOTH facts: the gap is real, and the workaround handles
  // it. When orval fixes the generation the second assertion fails and the
  // whole workaround can be deleted.
  const body = {
    id: 'doc_1',
    businessId: 'biz_1',
    inbox: 'COSTS',
    state: 'READY',
    channel: 'WEB_UPLOAD',
    originalFilename: 'booker.pdf',
    receivedAt: '2026-08-15T09:00:00.000Z',
    retryable: false,
    supplierName: 'Booker',
    documentDate: '2026-08-15',
    totalPence: 73_320,
    currency: 'GBP',
    mimeType: 'application/pdf',
    byteSize: 1024,
    byteHash: 'a'.repeat(64),
    createdAt: '2026-08-15T09:00:00.000Z',
    updatedAt: '2026-08-15T09:00:00.000Z',
  };

  expect(getDocumentResponse.safeParse(body).success).toBe(false);

  const parsed = parseDocumentDetail(body);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.byteHash).toBe('a'.repeat(64));
  expect(parsed.value.supplierName).toBe('Booker');
});

test('a genuinely wrong body is still refused, with the field named', () => {
  const parsed = parseDocumentDetail({ id: 'doc_1', byteHash: 'not-a-hash' });
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.detail.length).toBeGreaterThan(0);
});
