import { expect, test } from 'vitest';

import { buildPracticeReport, MINUTES_SAVED_PER_PUBLISHED_DOCUMENT, type ClientReportRow } from './analyticsReport';
import type { ClientStats } from './selectors';

/** Review item 56 — the report generation test the package owes. */

function stats(over: Partial<ClientStats> = {}): ClientStats {
  return {
    missing: 2,
    requested: 1,
    overdue: 0,
    unmatched: 6,
    statementGaps: 0,
    toReview: 3,
    ready: 1,
    processing: 0,
    rejected: 0,
    published: 12,
    duplicates: 0,
    approvals: 1,
    unverified: 0,
    health: 82,
    itemDelay: 0,
    ...over,
  };
}

const ROWS: ClientReportRow[] = [
  { name: 'Zeplow Ltd', stats: stats(), subscriptionStatus: 'ACTIVE' },
  { name: 'Smith, Sons & Co', stats: stats({ published: 8, unmatched: 0, health: 91 }), subscriptionStatus: null },
];

function report(): string {
  return buildPracticeReport({ rows: ROWS, scopeName: 'Whole practice', generatedOn: '5 September 2026' });
}

test('one row per client, a practice summary, and the scope/date header', () => {
  const csv = report();

  expect(csv).toContain('"Practice analytics report"');
  expect(csv).toContain('"Scope","Whole practice"');
  expect(csv).toContain('"Generated","5 September 2026"');
  expect(csv).toContain('"Clients in scope",2');
  // The roll-up is the sum of the per-client server counts, nothing recounted.
  expect(csv).toContain('"Published (approved and released for export)",20');
  expect(csv).toContain('"Unmatched bank lines",6');
  // Both client rows, with a comma-carrying name surviving quoting.
  expect(csv).toContain('"Zeplow Ltd",82,3,1,0,12,2,1,0,6,0,1,"ACTIVE",0.6');
  expect(csv).toContain('"Smith, Sons & Co",91,3,1,0,8,2,1,0,0,0,1,"not recorded",0.4');
});

test('the time-saved assumption is printed in the file, never silent', () => {
  const csv = report();
  expect(csv).toContain(`${MINUTES_SAVED_PER_PUBLISHED_DOCUMENT} minutes of manual keying avoided per published document`);
  // 20 published × 3 min = 60 min = 1 hour.
  expect(csv).toContain('"Time saved (hours, estimated)",1');
});

test('counts with no server source are declared as omitted, not printed as zero', () => {
  const csv = report();
  expect(csv).toContain('omitted rather than guessed');
  expect(csv).toContain('duplicates caught');
  // No column ever claims a duplicates or item-delay figure.
  expect(csv).not.toMatch(/"Duplicates/);
  expect(csv).not.toMatch(/"Item delay/);
});

test('⚠ D42: the report never claims transmission and never names a ledger vendor', () => {
  const csv = report();
  for (const forbidden of [/sent to/i, /publish(ed|ing)? to/i, /\bsync/i, /\bposted to\b/i, /\bXero\b/, /\bQuickBooks\b/, /auto.?published/i]) {
    expect(csv).not.toMatch(forbidden);
  }
  // Published wears its D42 meaning in the file itself.
  expect(csv).toContain('approved and released for export');
});
