import { expect, test } from 'vitest';

import { foldCounts, foldPrimaryContacts } from './businesses.service.js';

/**
 * The counts fold, offline. The integration suite proves the whole read
 * against real RLS; this pins the fold's own rules on machines with no
 * database configured — the contract's grouping is exactly three buckets,
 * and getting it wrong renders as a badge quietly lying on every screen.
 */

const row = (businessId: string | null, state: string, count: number, docType?: string) =>
  ({ businessId, state, ...(docType === undefined ? {} : { docType }), _count: { _all: count } }) as Parameters<typeof foldCounts>[0][number];

const chaseRow = (businessId: string, state: string, count: number) =>
  ({ businessId, state, _count: { _all: count } }) as NonNullable<Parameters<typeof foldCounts>[1]>[number];

const plainRow = (businessId: string | null, count: number) =>
  ({ businessId, _count: { _all: count } }) as NonNullable<Parameters<typeof foldCounts>[2]>[number];

/** Every count zero — what a business with nothing waiting folds to. */
const zero = {
  toReview: 0,
  ready: 0,
  failed: 0,
  published: 0,
  missing: 0,
  requested: 0,
  overdue: 0,
  unmatched: 0,
  statementGaps: 0,
  approvals: 0,
};

test('REJECTED and FAILED fold into one `failed` — the contract says together', () => {
  const counts = foldCounts([row('b1', 'REJECTED', 2), row('b1', 'FAILED', 3)]);
  expect(counts.get('b1')).toEqual({ ...zero, failed: 5 });
});

test('a STATEMENT document lights no toReview/ready badge — but its failures still count (4 Sep 2026)', () => {
  const counts = foldCounts([
    row('b1', 'TO_REVIEW', 2, 'STATEMENT'),
    row('b1', 'TO_REVIEW', 3, 'INVOICE'),
    row('b1', 'READY', 1, 'STATEMENT'),
    // A statement whose READ failed is real work and stays visible.
    row('b1', 'FAILED', 1, 'STATEMENT'),
    row('b1', 'PUBLISHED', 1, 'STATEMENT'),
  ]);
  expect(counts.get('b1')).toEqual({ ...zero, toReview: 3, failed: 1, published: 1 });
});

test('each counted state lands in its own bucket, per business', () => {
  const counts = foldCounts([
    row('b1', 'TO_REVIEW', 4),
    row('b1', 'READY', 1),
    row('b1', 'PUBLISHED', 6),
    row('b2', 'READY', 7),
  ]);
  expect(counts.get('b1')).toEqual({ ...zero, toReview: 4, ready: 1, published: 6 });
  expect(counts.get('b2')).toEqual({ ...zero, ready: 7 });
});

test('chase states fold into missing, requested and overdue', () => {
  // SENT and REMINDED are both "asked for and still outstanding"; DETECTED is
  // a gap nobody has been asked about yet, and ESCALATED is late.
  const counts = foldCounts(
    [],
    [
      chaseRow('b1', 'DETECTED', 3),
      chaseRow('b1', 'SENT', 2),
      chaseRow('b1', 'REMINDED', 1),
      chaseRow('b1', 'ESCALATED', 4),
    ],
  );
  expect(counts.get('b1')).toEqual({ ...zero, missing: 3, requested: 3, overdue: 4 });
});

test('a composed-but-unsent chase is NOT counted as requested', () => {
  // D44 splits composition from release. Counting PROPOSED or APPROVED here
  // would tell an accountant they had chased a client they had not.
  const counts = foldCounts([], [chaseRow('b1', 'PROPOSED', 5), chaseRow('b1', 'APPROVED', 5)]);
  expect(counts.size).toBe(0);
});

test('a closed chase belongs in no column', () => {
  const counts = foldCounts([], [chaseRow('b1', 'CLOSED_RECEIVED', 9), chaseRow('b1', 'CLOSED_DISMISSED', 9)]);
  expect(counts.size).toBe(0);
});

test('unmatched and approvals fold from their own aggregates', () => {
  const counts = foldCounts([], [], [plainRow('b1', 6)], [plainRow('b1', 2)]);
  expect(counts.get('b1')).toEqual({ ...zero, unmatched: 6, approvals: 2 });
});

test('a business seen only in a non-document aggregate still gets every count', () => {
  // The contract requires all ten. A client with three unmatched bank lines and
  // no documents at all must still report `toReview: 0` rather than arriving
  // without the key and rendering as an absent column.
  const counts = foldCounts([], [], [plainRow('b9', 3)]);
  expect(counts.get('b9')).toEqual({ ...zero, unmatched: 3 });
});

test('an unrouted group (null businessId) is counted nowhere', () => {
  expect(foldCounts([row(null, 'TO_REVIEW', 9)]).size).toBe(0);
});

test('a state outside the three buckets never leaks into a badge', () => {
  // The where-clause already excludes these; the fold not trusting that is
  // what keeps a widened query from silently inflating `toReview`.
  expect(foldCounts([row('b1', 'RECEIVED', 5), row('b1', 'ARCHIVED', 5)]).size).toBe(0);
});

/**
 * `primaryContactEmail` — the fold, offline.
 *
 * The query is what enforces `is_primary` and the ordering; what these pin is
 * the rule the query cannot express: which row wins, and that "no address on
 * file" survives as null instead of being replaced by somebody else's.
 */

const contact = (businessId: string, email: string | null) => ({ businessId, email });

test("the primary contact's address is folded per business", () => {
  const emails = foldPrimaryContacts([
    contact('b1', 'owner@americanburger.test'),
    contact('b2', 'maria@ananda.test'),
  ]);
  expect(emails.get('b1')?.email).toBe('owner@americanburger.test');
  expect(emails.get('b2')?.email).toBe('maria@ananda.test');
});

test('the earliest primary contact wins when a client somehow carries several', () => {
  // The caller orders by `created_at` ascending, so first-wins is the
  // longest-standing primary. Intake writes exactly one, so this decides a
  // state nothing in the repo creates — but the field must not change which
  // person it names between two page loads.
  const emails = foldPrimaryContacts([contact('b1', 'first@client.test'), contact('b1', 'second@client.test')]);
  expect(emails.get('b1')?.email).toBe('first@client.test');
});

test('a primary contact with no address on file folds to null, not to another contact', () => {
  // `contacts.email` is nullable — a phone-only contact is a real record
  // (SoT §3.3). Skipping past it to the next row would put a different
  // person's address under the words "primary contact".
  const emails = foldPrimaryContacts([contact('b1', null), contact('b1', 'someone.else@client.test')]);
  expect(emails.get('b1')?.email).toBeNull();
});

test('a business with no primary contact is absent, and the caller reads that as null', () => {
  const emails = foldPrimaryContacts([contact('b1', 'owner@client.test')]);
  expect(emails.has('b2')).toBe(false);
  expect(emails.get('b2') ?? null).toBeNull();
});

test('name and mobile ride the SAME first-wins row as the email — never three lookups (5 Sep 2026)', () => {
  const facts = foldPrimaryContacts([
    { businessId: 'b1', email: 'ana@sparkle.test', firstName: 'Ana', lastName: 'Rossi', mobileE164: '+447700900123' },
    { businessId: 'b1', email: 'late@sparkle.test', firstName: 'Late', lastName: 'Arrival', mobileE164: '+447700900999' },
  ]);
  expect(facts.get('b1')).toEqual({ email: 'ana@sparkle.test', name: 'Ana Rossi', mobile: '+447700900123' });
  // A nameless §3.3 contact folds to a null name, never the email retyped.
  const nameless = foldPrimaryContacts([{ businessId: 'b2', email: 'x@y.test', firstName: null, lastName: null, mobileE164: null }]);
  expect(nameless.get('b2')).toEqual({ email: 'x@y.test', name: null, mobile: null });
});
