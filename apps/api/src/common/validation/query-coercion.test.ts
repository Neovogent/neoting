import { expect, test } from 'vitest';

import { listDocumentEventsQueryParams, listDocumentsQueryParams } from '@neoting/contracts/zod';

import { coerceQuery } from './query-coercion.js';

/**
 * Driven against the REAL generated schemas, not hand-built ones. The helper's
 * whole job is to make Express's all-strings query objects parse under the
 * contract's types, and its one silent failure mode is `instanceof` across two
 * zod instances (pnpm gives `@neoting/contracts` its own) — a hand-built local
 * schema would share our instance and could never catch that.
 */

function parse(query: unknown) {
  return listDocumentsQueryParams.safeParse(coerceQuery(listDocumentsQueryParams, query));
}

test('the exact shape apps/web sends parses: numeric limit and a single-valued filter', () => {
  // REGRESSION. Express delivers `?limit=100&state=READY` as
  // `{ limit: '100', state: 'READY' }`. Parsed raw, BOTH fail — a string where
  // the schema wants a number, a bare string where it wants an array — so the
  // primary read surface 400'd on its most ordinary request.
  const result = parse({ limit: '100', state: 'READY' });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.limit).toBe(100);
    expect(result.data.state).toEqual(['READY']);
  }
});

test('a repeated filter is already an array and passes through unchanged', () => {
  const result = parse({ state: ['REJECTED', 'FAILED'] });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.state).toEqual(['REJECTED', 'FAILED']);
});

test('a limit that is not a number stays a string, so Zod names the real problem', () => {
  const result = parse({ limit: 'abc' });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.path).toEqual(['limit']);
});

test('an unknown key passes through untouched, so .strict() rejects it by name', () => {
  const result = parse({ limi: '10' });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
});

test('a value the schema types as a string is never numified', () => {
  // `q=2026` is a search for the text "2026", not the number — a filename or a
  // reference is allowed to look like arithmetic.
  const result = parse({ q: '2026' });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.q).toBe('2026');
});

test('defaults still apply when the query is empty', () => {
  const result = parse({});
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.limit).toBe(50);
    expect(result.data.sort).toBe('receivedAt');
    expect(result.data.order).toBe('desc');
  }
});

test('the child-list schema coerces its limit the same way', () => {
  const result = listDocumentEventsQueryParams.safeParse(
    coerceQuery(listDocumentEventsQueryParams, { limit: '25' }),
  );
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.limit).toBe(25);
});

test('a non-object query passes through for the schema to reject as it would have', () => {
  expect(listDocumentsQueryParams.safeParse(coerceQuery(listDocumentsQueryParams, 'limit=10')).success).toBe(false);
});


test('a boolean query param is coerced from "true"/"false" and NOTHING else', () => {
  // `deleted` is the first boolean query parameter in the contract, and
  // `?deleted=true` arrives from Express as the STRING 'true' — a 400 without
  // this branch, on the request that opens Trash.
  const on = listDocumentsQueryParams.safeParse(coerceQuery(listDocumentsQueryParams, { deleted: 'true' }));
  expect(on.success).toBe(true);
  if (on.success) expect(on.data.deleted).toBe(true);

  // ⚠ The half that matters. Truthy coercion (`Boolean(value)`) would make
  // `?deleted=false` mean TRUE — serving the entire Trash in place of the inbox
  // on the one spelling a caller is most likely to send explicitly.
  const off = listDocumentsQueryParams.safeParse(coerceQuery(listDocumentsQueryParams, { deleted: 'false' }));
  expect(off.success).toBe(true);
  if (off.success) expect(off.data.deleted).toBe(false);

  // Anything else passes through untouched, so Zod reports the honest "expected
  // boolean" against the field rather than this helper guessing.
  for (const guess of ['1', 'yes', '', 'TRUE']) {
    expect(listDocumentsQueryParams.safeParse(coerceQuery(listDocumentsQueryParams, { deleted: guess })).success).toBe(
      false,
    );
  }
});
