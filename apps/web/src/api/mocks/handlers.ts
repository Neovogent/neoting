import { http, HttpResponse } from 'msw';

import { documentFixtures } from './fixtures';
import type { DocumentSummary } from '@neoting/contracts/model';

/**
 * The mocked API.
 *
 * ⚠ THESE ARE HAND-WRITTEN, AND THAT IS A DELIBERATE REVERSAL.
 *
 * orval generates MSW handlers for all 14 operations and `@neoting/contracts`
 * ships them. Importing those here cost 58 type errors that no flag fixes
 * cleanly: their faker calls return `T | undefined` under
 * `noUncheckedIndexedAccess`, and the fixture objects trip
 * `exactOptionalPropertyTypes`. Both flags are ON for this package on purpose —
 * relaxing them for 28k lines of application code to accommodate generated mock
 * bodies is the wrong way round.
 *
 * So this file mocks only what a screen actually consumes, with the app's own
 * fixtures. The endpoints below that no screen calls yet are simply absent:
 * MSW passes an unhandled request through, which surfaces as a real failure
 * rather than a faker-random body that looks like data. When a screen needs one,
 * it gets a handler with real fixtures — which is better than a random one.
 *
 * The filtering is the part that matters. The inbox is ONE endpoint serving four
 * screens purely through query parameters, so a mock returning everything
 * regardless would hide exactly the bug integration finds.
 */

/* (original note follows)
 * The mocked API.
 *
 * Every handler is orval's, generated from the contract — the shapes cannot
 * drift from the spec because nobody writes them. Two are given a body of
 * their own so the screens have something real to render: the generated
 * default returns the single worked example from the spec, which proves the
 * wire format and makes a poor inbox.
 *
 * The overrides implement the filtering the contract documents, not a stub
 * that ignores query parameters. That matters more than it sounds — the inbox
 * is one endpoint serving four screens purely through filters, so a mock that
 * returns everything regardless would hide the exact bug integration will find.
 */

const asArray = (params: URLSearchParams, key: string): string[] => params.getAll(key);

/** Applies the documented filters to the fixture set. Exported so the
 *  filtering can be exercised without a browser. */
export function filterDocuments(url: URL): { data: DocumentSummary[]; nextCursor: string | null; hasMore: boolean } {
  const params = url.searchParams;

  const businessId = params.get('businessId');
  const inbox = asArray(params, 'inbox');
  const state = asArray(params, 'state');
  const docType = asArray(params, 'docType');
  const channel = asArray(params, 'channel');
  const supplierName = params.get('supplierName');
  const q = params.get('q')?.toLowerCase();

  let rows = documentFixtures.filter((d) => {
    if (businessId && d.businessId !== businessId) return false;
    if (inbox.length && !inbox.includes(d.inbox)) return false;
    // "Omitted means every state except ARCHIVED" — the contract's default.
    if (state.length ? !state.includes(d.state) : d.state === 'ARCHIVED') return false;
    if (docType.length && (!d.docType || !docType.includes(d.docType))) return false;
    if (channel.length && !channel.includes(d.channel)) return false;
    if (supplierName && d.supplierName !== supplierName) return false;
    if (q) {
      const haystack = [d.supplierName, d.customerName, d.reference, d.description, d.originalFilename]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const sort = params.get('sort') ?? 'receivedAt';
  const order = params.get('order') ?? 'desc';
  rows = [...rows].sort((a, b) => {
    const pick = (d: DocumentSummary) =>
      sort === 'totalPence' ? d.totalPence ?? 0
        : sort === 'supplierName' ? d.supplierName ?? ''
        : sort === 'documentDate' ? d.documentDate ?? ''
        : d.receivedAt;
    const left = pick(a);
    const right = pick(b);
    const cmp = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right));
    return order === 'asc' ? cmp : -cmp;
  });

  /**
   * Cursor pagination, as the contract insists — no offsets anywhere. The
   * cursor is the index, base64'd, which is opaque enough to keep callers
   * honest about never constructing one.
   */
  const limit = Math.min(Number(params.get('limit') ?? 50), 200);
  const cursor = params.get('cursor');
  const start = cursor ? Number(atob(cursor)) || 0 : 0;
  const page = rows.slice(start, start + limit);
  const end = start + page.length;

  return {
    data: page,
    nextCursor: end < rows.length ? btoa(String(end)) : null,
    hasMore: end < rows.length,
  };
}

export const handlers = [
  http.get('*/v1/documents', ({ request }) => {
    const { data, nextCursor, hasMore } = filterDocuments(new URL(request.url));
    return HttpResponse.json({ data, pageInfo: { nextCursor, hasMore } });
  }),

  http.get('*/v1/documents/:documentId', ({ params }) => {
    const id = String(params['documentId']);
    const summary = documentFixtures.find((d) => d.id === id) ?? documentFixtures[0];
    if (!summary) return HttpResponse.json({ title: 'Not found', status: 404 }, { status: 404 });
    return HttpResponse.json({
      ...summary,
      mimeType: 'application/pdf',
      byteSize: 184_320,
      byteHash: 'a'.repeat(64),
      perceptualHash: null,
      submitterUserId: null,
      submitterLabel: null,
      receivedLocal: null,
      routingDecision: null,
      routingConfidence: null,
      pageRange: null,
      acceptedExtraction: null,
      createdAt: summary.receivedAt,
      updatedAt: summary.receivedAt,
    });
  }),
];
