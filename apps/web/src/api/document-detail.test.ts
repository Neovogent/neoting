import { describe, expect, it, test } from 'vitest';

import { getDocumentResponse } from '@neoting/contracts/zod';

import { createActionProposalBody } from '@neoting/contracts/zod';

import {
  CATEGORY_LABEL,
  FIELD_PRESENTATION,
  isEditableLabel,
  parseCodingDraft,
  parseCreateProposalHalves,
  parseDocumentDetail,
  ruleIdFromEvents,
  toCodingSuggestion,
  toDetailData,
  usableBoundingBox,
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

  it('carries a complete boundingBox through to the row, and omits an absent one', () => {
    const box = { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.04 };
    const placed = {
      ...WIRE_DOC,
      acceptedExtraction: {
        ...WIRE_DOC.acceptedExtraction!,
        fields: {
          ...WIRE_DOC.acceptedExtraction!.fields,
          supplierName: { ...aiField('Currys'), boundingBox: box },
          totalPence: { ...aiField(129_900), boundingBox: null },
        },
      },
    } as typeof WIRE_DOC;

    const detail = toDetailData(placed, null);
    expect(detail.fields.find((f) => f.label === 'Supplier')?.boundingBox).toEqual(box);
    // Explicit null on the wire and never-sent both project as "no box": the
    // preview's fallback is the whole-frame band either way.
    expect(detail.fields.find((f) => f.label === 'Total')?.boundingBox).toBeUndefined();
    expect(detail.fields.find((f) => f.label === 'Document date')?.boundingBox).toBeUndefined();
  });
});

/**
 * The coding suggestion crossing the boundary — **the bug this closes is a
 * blank Category with no explanation**, so the assertions are about what the
 * accountant is shown and about the two things a suggestion must never do.
 */
describe('toCodingSuggestion — an opinion, never a coding', () => {
  /** An uncoded document, which is the only kind the ladder answers about. */
  const uncoded = (codingSuggestion: unknown) =>
    ({
      ...WIRE_DOC,
      categoryCode: null,
      acceptedExtraction: { ...WIRE_DOC.acceptedExtraction!, codingSuggestion },
    }) as typeof WIRE_DOC;

  const SUGGEST = {
    outcome: 'SUGGEST',
    provenance: 'AI_SUGGESTED',
    basis: 'SUBSCRIPTION_TERM_UNDER_TWO_YEARS',
    note: 'Suggested — not applied — as Software subscriptions, on an annual term stated on the document.',
    categoryCode: 'SOFTWARE_SUBSCRIPTIONS',
    analysisAccount: 'Overheads: Software subscriptions',
    confidence: 0.82,
    treatment: 'REVENUE',
    secondChoice: null,
    escalationReason: null,
    candidateCategoryCodes: [],
    advisories: [],
  };

  const ESCALATE = {
    outcome: 'ESCALATE',
    provenance: 'AI_SUGGESTED',
    basis: 'NOTHING_MATCHED',
    note: 'The licence term is not stated on this document, so it cannot be settled as capital or revenue.',
    categoryCode: null,
    analysisAccount: null,
    confidence: null,
    treatment: null,
    secondChoice: null,
    escalationReason: 'SOFTWARE_TERM_UNKNOWN',
    candidateCategoryCodes: [],
    advisories: [],
  };

  it('carries the engine’s own sentence through unchanged, for both outcomes', () => {
    // The whole point of the change: the words an accountant reads are composed
    // by the engine that took the decision, never re-worded on the way out.
    expect(toCodingSuggestion(uncoded(SUGGEST))?.note).toBe(SUGGEST.note);
    expect(toCodingSuggestion(uncoded(ESCALATE))?.note).toBe(ESCALATE.note);
    expect(toCodingSuggestion(uncoded(ESCALATE))?.escalationReason).toBe('SOFTWARE_TERM_UNKNOWN');
  });

  it('is absent when the ladder said nothing', () => {
    expect(toCodingSuggestion(uncoded(null))).toBeNull();
    expect(toCodingSuggestion(uncoded(undefined))).toBeNull();
  });

  it('is DROPPED for a document something already coded', () => {
    // A suggestion beside an accountant's own rule is not extra information —
    // it is pressure to second-guess an explicit instruction.
    const coded = { ...uncoded(SUGGEST), categoryCode: 'OFFICE_EQUIPMENT' } as typeof WIRE_DOC;
    expect(toCodingSuggestion(coded)).toBeNull();
  });

  it('⚠ NEVER fills the Category value — a suggestion must not make a document Ready', () => {
    // `DocumentPreview`'s Path-to-Ready panel decides what is missing by testing
    // `value === '—'` against the mandatory set. A suggested code written into
    // this row would tell an accountant a document is one field from Ready when
    // nothing has coded it. This is the assertion that stops that.
    const detail = toDetailData(uncoded(SUGGEST), null);
    const category = detail.fields.find((f) => f.label === CATEGORY_LABEL);
    expect(category?.value).toBe('—');
    expect(detail.codingSuggestion?.categoryCode).toBe('SOFTWARE_SUBSCRIPTIONS');
  });

  it('replaces the row’s invented provenance with the suggestion’s working (§13.3)', () => {
    // Before this change the row claimed `AI suggested: demo-extractor-1` over
    // an EMPTY value — a provenance for a value that did not exist.
    const suggested = toDetailData(uncoded(SUGGEST), null).fields.find((f) => f.label === CATEGORY_LABEL);
    expect(suggested?.provenance).toBe(SUGGEST.note);
    expect(suggested?.confidence).toBe(0.82);

    // ESCALATE carries no confidence, because there is no coding to be
    // confident about; zero is the honest number and renders the row amber.
    const escalated = toDetailData(uncoded(ESCALATE), null).fields.find((f) => f.label === CATEGORY_LABEL);
    expect(escalated?.provenance).toBe(ESCALATE.note);
    expect(escalated?.confidence).toBe(0);
  });

  it('leaves a rule-coded row exactly as it was', () => {
    // Regression guard on the branch above the suggestion: a rule still wins,
    // and still cites itself.
    const withRule = toDetailData(WIRE_DOC, 'rule_bidfood').fields.find((f) => f.label === CATEGORY_LABEL);
    expect(withRule?.provenance).toBe('supplier rule: rule_bidfood');
    expect(withRule?.value).toBe('OFFICE_EQUIPMENT');
  });

  it('parses through the contract’s own schema, suggestion and all', () => {
    // The `fields` map is parsed STRICTLY by the generated client, so a smuggled
    // key left in place fails every document read in the browser (#137). This is
    // the pin that the separated key is genuinely contract-shaped.
    const parsed = parseDocumentDetail(uncoded(SUGGEST));
    expect(parsed.ok).toBe(true);
  });
});

describe('usableBoundingBox — all-or-nothing over the contract box', () => {
  const box = { page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.04 };

  it('accepts a complete box, keeping the page it names', () => {
    expect(usableBoundingBox(box)).toEqual(box);
  });

  it('refuses null, undefined, a missing coordinate and a zero-area box — never a partial guess', () => {
    expect(usableBoundingBox(null)).toBeUndefined();
    expect(usableBoundingBox(undefined)).toBeUndefined();
    // Every member is optional in the generated schema (the spec declares no
    // `required` on the box), so each absence must be handled, not asserted.
    expect(usableBoundingBox({ ...box, page: undefined })).toBeUndefined();
    expect(usableBoundingBox({ ...box, x: undefined })).toBeUndefined();
    expect(usableBoundingBox({ ...box, y: undefined })).toBeUndefined();
    expect(usableBoundingBox({ ...box, width: undefined })).toBeUndefined();
    expect(usableBoundingBox({ ...box, height: undefined })).toBeUndefined();
    expect(usableBoundingBox({ ...box, width: 0 })).toBeUndefined();
    expect(usableBoundingBox({ ...box, height: 0 })).toBeUndefined();
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

describe('parseCreateProposalHalves — the outbound boundary that actually works', () => {
  const body = {
    kind: 'document.update-coding',
    businessId: 'biz_1',
    payload: { documentId: 'doc_1', fields: { categoryCode: 'Groceries' } },
  };

  test('a valid update-coding body passes', () => {
    expect(() => parseCreateProposalHalves(body)).not.toThrow();
  });

  test('a body the contract refuses is refused with the kind named, before the network', () => {
    expect(() =>
      parseCreateProposalHalves({
        kind: 'document.update-coding',
        businessId: 'biz_1',
        payload: { documentId: 'doc_1', fields: { currency: 'pounds' } },
      }),
    ).toThrow(/update-coding/);
  });

  test('⚠ THE PIN: the generated whole-body parse still rejects every valid body', () => {
    // orval's strict-intersection gap on the REQUEST side (getChaseResponse's
    // twin): each union member is strict().and(strict()), so each half refuses
    // the other half's keys and NO real body can ever pass. This is why
    // parseCreateProposalHalves exists. It cost a real correction on
    // 2 Sep 2026 — the parse threw before fetch and the card said "approved".
    // When orval fixes the generation this test fails, and the halves
    // workaround gets deleted in favour of the one-line parse.
    expect(createActionProposalBody.safeParse(body).success).toBe(false);
  });
});
