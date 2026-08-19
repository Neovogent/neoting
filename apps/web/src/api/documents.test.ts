import { describe, expect, it } from 'vitest';
import { DocumentChannel, DocumentState } from '@neoting/contracts/model';
import type { DocumentSummary } from '@neoting/contracts/model';

import { listDocumentsResponse } from '@neoting/contracts/zod';
import { fromIsoDate, fromPence, toLocalDocument } from './documents';
import { unwrapBody } from './envelope';
import { documentFixtures, toPence } from './mocks/fixtures';
import type { DocStatus, SourceChannel } from '../lib/types';

/**
 * The boundary where the contract's integer pence becomes the pounds every
 * screen renders, and where the contract's enums become the app's.
 *
 * Both are exactly the kind of conversion that looks right in a demo and is
 * wrong by a factor of a hundred, or silently renders an unknown state as
 * something reassuring.
 */

const row = (over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: 'doc-1',
  businessId: 'biz_1',
  inbox: 'COSTS',
  state: 'READY',
  docType: 'RECEIPT',
  channel: 'EMAIL',
  originalFilename: 'bidfood-uk.pdf',
  receivedAt: '2026-08-12T09:00:00Z',
  supplierName: 'Bidfood UK',
  customerName: null,
  documentDate: '2026-08-10',
  dueDate: null,
  currency: 'GBP',
  totalPence: 142050,
  taxPence: null,
  reference: null,
  categoryCode: 'Cost of Sales Food',
  description: null,
  projectRef: null,
  parentDocumentId: null,
  failureCode: null,
  failureMessage: null,
  retryable: false,
  archivedAt: null,
  ...over,
});

const nameFor = (businessId: string) => (businessId === 'biz_1' ? 'American Burger Ltd' : 'Cosmo Restaurants');

describe('money', () => {
  it('reads integer pence as pounds', () => {
    expect(fromPence(142050)).toBe(1420.5);
    expect(fromPence(6199)).toBe(61.99);
    expect(fromPence(1)).toBe(0.01);
    expect(fromPence(0)).toBe(0);
  });

  it('treats a missing total as nothing rather than NaN', () => {
    expect(fromPence(null)).toBe(0);
    expect(fromPence(undefined)).toBe(0);
  });

  it('round-trips every fixture total without losing a penny', () => {
    for (const doc of documentFixtures) {
      const pence = doc.totalPence ?? 0;
      expect(Number.isInteger(pence)).toBe(true);
      expect(toPence(fromPence(pence))).toBe(pence);
    }
  });

  it('round-trips pounds through pence, including the values float arithmetic ruins', () => {
    for (const pounds of [0, 0.01, 0.1, 0.29, 61.99, 340, 850.2, 1420.5, 4820.75, 6240, 1234567.89]) {
      expect(fromPence(toPence(pounds))).toBe(pounds);
    }
  });

  it('never produces a fractional penny from a fractional pound', () => {
    // 0.1 + 0.2 is 0.30000000000000004; a truncating conversion writes 30.000…
    expect(toPence(0.1 + 0.2)).toBe(30);
    expect(Number.isInteger(toPence(19.995))).toBe(true);
  });

  it('carries the total onto the rendered document as pounds, once', () => {
    const doc = toLocalDocument(row({ totalPence: 142050 }), nameFor);

    expect(doc.total).toBe(1420.5);
  });
});

describe('dates', () => {
  it('renders a calendar date the way every screen shows it', () => {
    expect(fromIsoDate('2026-08-10')).toBe('10 Aug 2026');
    expect(fromIsoDate('2026-01-01')).toBe('01 Jan 2026');
    expect(fromIsoDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('reads the date out of an instant without shifting it', () => {
    expect(fromIsoDate('2026-08-10T23:30:00Z')).toBe('10 Aug 2026');
  });

  it('says so plainly when there is no date, rather than inventing today', () => {
    expect(fromIsoDate(null)).toBe('—');
    expect(fromIsoDate(undefined)).toBe('—');
    expect(fromIsoDate('')).toBe('—');
    expect(fromIsoDate('10/08/2026')).toBe('—');
  });

  it('falls back to when it arrived if the document itself is undated', () => {
    const doc = toLocalDocument(row({ documentDate: null, receivedAt: '2026-08-12T09:00:00Z' }), nameFor);

    expect(doc.date).toBe('12 Aug 2026');
  });
});

/**
 * The mapping tables are not exported, so they are pinned through the public
 * function — and the contract's own enum is the list, so a value added to the
 * spec fails here instead of rendering as something plausible.
 */
describe('state mapping', () => {
  const EXPECTED: Record<string, DocStatus> = {
    RECEIVED: 'processing',
    PROCESSING: 'processing',
    TO_REVIEW: 'review',
    READY: 'ready',
    PUBLISHED: 'published',
    REJECTED: 'rejected',
    FAILED: 'rejected',
    ARCHIVED: 'published',
  };

  it('covers every state the contract can send', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(DocumentState).sort());
  });

  it.each(Object.entries(EXPECTED))('%s renders as %s', (state, status) => {
    expect(toLocalDocument(row({ state: state as DocumentState }), nameFor).status).toBe(status);
  });

  it('flags a failed publish so the Ready pill can show it went wrong', () => {
    expect(toLocalDocument(row({ state: 'FAILED' }), nameFor).publishFailed).toBe(true);
    expect(toLocalDocument(row({ state: 'READY' }), nameFor).publishFailed).toBeUndefined();
  });

  it('shows the server’s own reason rather than a generic line', () => {
    const doc = toLocalDocument(
      row({ state: 'REJECTED', failureCode: 'NT-ING-004', failureMessage: 'Password-protected PDF' }),
      nameFor,
    );

    expect(doc.statusNote).toBe('Password-protected PDF');
  });
});

describe('channel mapping', () => {
  const EXPECTED: Record<string, SourceChannel> = {
    WEB_UPLOAD: 'web',
    EMAIL: 'email',
    WHATSAPP: 'whatsapp',
    SMS_PORTAL: 'sms-link',
    CHAT_UPLOAD: 'chat',
    STRUCTURED_IMPORT: 'csv',
    API: 'web',
  };

  it('covers every channel the contract can send', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(DocumentChannel).sort());
  });

  it.each(Object.entries(EXPECTED))('%s renders as %s', (channel, source) => {
    expect(toLocalDocument(row({ channel: channel as DocumentChannel }), nameFor).source).toBe(source);
  });
});

describe('the rest of the row', () => {
  it('takes the counterparty from the side of the ledger the document is on', () => {
    const cost = toLocalDocument(row({ inbox: 'COSTS', supplierName: 'Bidfood UK', customerName: null }), nameFor);
    const sale = toLocalDocument(row({ inbox: 'SALES', supplierName: null, customerName: 'Deliveroo' }), nameFor);

    expect(cost.supplier).toBe('Bidfood UK');
    expect(cost.kind).toBe('cost');
    expect(sale.supplier).toBe('Deliveroo');
    expect(sale.kind).toBe('sales');
  });

  it('says Unknown rather than showing an empty name', () => {
    const doc = toLocalDocument(row({ supplierName: null, customerName: null }), nameFor);

    expect(doc.supplier).toBe('Unknown');
  });

  it('resolves the client name from the caller rather than parsing the id', () => {
    const doc = toLocalDocument(row({ businessId: 'biz_2' }), nameFor);

    expect(doc.clientId).toBe('biz_2');
    expect(doc.clientName).toBe('Cosmo Restaurants');
  });

  it('shows an em dash for an uncoded document rather than the word null', () => {
    expect(toLocalDocument(row({ categoryCode: null }), nameFor).category).toBe('—');
  });

  it('defaults the currency to sterling when the server omits it', () => {
    expect(toLocalDocument(row({ currency: null }), nameFor).currency).toBe('GBP');
    expect(toLocalDocument(row({ currency: 'EUR' }), nameFor).currency).toBe('EUR');
  });

  it('marks a document that came out of a split batch', () => {
    const split = toLocalDocument(row({ parentDocumentId: 'doc-parent' }), nameFor);
    const whole = toLocalDocument(row({ parentDocumentId: null }), nameFor);

    expect(split.splitFrom).toBe('bidfood-uk.pdf');
    expect(whole.splitFrom).toBeUndefined();
  });

  it('maps every fixture without throwing or losing an id', () => {
    const mapped = documentFixtures.map((d) => toLocalDocument(d, nameFor));

    expect(mapped.map((d) => d.id)).toEqual(documentFixtures.map((d) => d.id));
    expect(mapped.every((d) => d.total >= 0 && d.supplier.length > 0)).toBe(true);
  });
});

/**
 * The hook's parse, owed since the bank slice found the envelope problem
 * (apps/web/CLAUDE.md): the generated type promises `{ status, data }`, the
 * runtime value is the raw body, and this hook shipped reading one level too
 * deep — so with the API enabled every inbox load reported a contract error.
 * The hook's exact composition — `listDocumentsResponse` over `unwrapBody` —
 * must accept both shapes, so the fix survives the mutator ever changing.
 */
describe('the list parse and the envelope that does not exist', () => {
  const page = { data: [row()], pageInfo: { nextCursor: null, hasMore: false } };
  const parse = (value: unknown) => listDocumentsResponse.safeParse(unwrapBody(value));

  it('reads the raw body the mutator actually returns', () => {
    const parsed = parse(page);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.data).toHaveLength(1);
  });

  it('reads the enveloped shape the generated types describe, should it ever become real', () => {
    expect(parse({ status: 200, data: page }).success).toBe(true);
  });

  it('does not unwrap a body whose own fields merely look like an envelope', () => {
    // `status` here is a string, not an HTTP code — the shape test must not
    // strip a legitimate body that happens to carry `data` and `status` keys.
    expect(unwrapBody({ data: [], status: 'READY' })).toEqual({ data: [], status: 'READY' });
  });

  it('names the field when the server answer does not match the contract', () => {
    const parsed = parse({ data: [{ ...row(), state: 'MISFILED' }], pageInfo: page.pageInfo });

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.some((i) => i.path.join('.').includes('state'))).toBe(true);
  });
});
