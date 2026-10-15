import type { AnalyticsBreakdown, AnalyticsMetric, AnalyticsReport } from '@neoting/contracts/model';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';

/**
 * SoT §11 pipeline analytics, computed from RLS-scoped rows inside a scopedDb
 * transaction the caller opens. Counts, rates and ages only — no money, no
 * ledger health, no financial statement. A metric with nothing to measure is
 * `null`, never a zero standing in for "unknown".
 */

const DAY_MS = 86_400_000;

// ---- pure helpers (unit-tested without a DB) --------------------------------

export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** n/d as a percentage to 1dp; null when there is nothing to divide by. */
export function percent(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round1((numerator / denominator) * 100);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Day buckets up to 31 days, ISO weeks (Monday start) beyond. */
export function bucketFor(from: Date, to: Date): 'day' | 'week' {
  return (to.getTime() - from.getTime()) / DAY_MS + 1 > 31 ? 'week' : 'day';
}

/** The bucket a moment falls in, as its first UTC day. */
export function bucketKey(at: Date, bucket: 'day' | 'week'): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (bucket === 'week') day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return isoDay(day);
}

/** Every bucket from `from` to `to` inclusive, so empty buckets render as zero. */
export function bucketStarts(from: Date, to: Date, bucket: 'day' | 'week'): string[] {
  const keys: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const key = bucketKey(new Date(t), bucket);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

function tally(labels: readonly string[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** Pending-proposal age band. */
export function ageBand(days: number): string {
  if (days < 1) return 'Under 1 day';
  if (days < 3) return '1–3 days';
  if (days < 7) return '3–7 days';
  return 'Over 7 days';
}

// ---- the report --------------------------------------------------------------

const UNPROCESSED = new Set(['RECEIVED', 'PROCESSING', 'FAILED']);
const OPEN_CHASE = ['SENT', 'REMINDED', 'ESCALATED'] as const;

export async function buildAnalyticsReport(
  db: ScopedClient,
  args: { businessId: string | null; from: Date; to: Date; now: Date },
): Promise<AnalyticsReport> {
  const { businessId, from, to, now } = args;
  const toExclusive = new Date(to.getTime() + DAY_MS);
  const period = { gte: from, lt: toExclusive };
  const biz = businessId === null ? {} : { businessId };
  const docWhere = { ...biz, ...notDeleted(), receivedAt: period };

  // ponytail: period documents are read whole (narrow select); groupBy per metric if a practice outgrows ~50k docs/period.
  const [docs, corrected, accepted, dismissed, duplicates, missing, chases, overdue, pending, publishFailures, integrations, tasks, businesses, rules] =
    await Promise.all([
      db.document.findMany({
        where: docWhere,
        select: { businessId: true, receivedAt: true, state: true, channel: true, documentDate: true, supplierName: true },
      }),
      db.extraction.findMany({
        where: { keyedByUserId: { not: null }, document: docWhere },
        select: { documentId: true },
        distinct: ['documentId'],
      }),
      db.suggestion.count({ where: { field: 'categoryCode', acceptedAt: { not: null }, document: docWhere } }),
      db.suggestion.count({ where: { field: 'categoryCode', dismissedAt: { not: null }, document: docWhere } }),
      db.duplicate.count({ where: { ...biz, createdAt: period } }),
      db.bankTransaction.count({ where: { ...biz, matchState: 'UNMATCHED', chaseSuppressed: false } }),
      db.chase.findMany({ where: { ...biz, firstSentAt: period }, select: { firstSentAt: true, closedAt: true, state: true } }),
      db.chase.count({
        where: { ...biz, state: { in: [...OPEN_CHASE] }, firstSentAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
      }),
      db.actionProposal.findMany({
        where: { ...biz, state: { in: ['CREATED', 'REVIEWED'] }, expiresAt: { gt: now } },
        select: { createdAt: true, createdByUserId: true },
      }),
      db.publish.count({ where: { ...biz, state: 'FAILED', createdAt: period } }),
      db.integration.findMany({ where: biz, select: { kind: true, health: true, isActive: true } }),
      db.task.findMany({
        where: { ...biz, status: { in: ['open'] }, ownerUserId: { not: null } },
        select: { ownerUserId: true },
      }),
      db.business.findMany({
        where: { isActive: true, ...(businessId === null ? {} : { id: businessId }) },
        select: { id: true, name: true },
      }),
      db.rule.findMany({
        where: { ...biz, isActive: true, tier: 'SUPPLIER_CUSTOMER', scopeKey: { not: null } },
        select: { businessId: true, scopeKey: true },
      }),
    ]);

  // Series.
  const bucket = bucketFor(from, to);
  const series = new Map(bucketStarts(from, to, bucket).map((k) => [k, { period: k, received: 0, processed: 0 }]));
  let processed = 0;
  for (const d of docs) {
    const row = series.get(bucketKey(d.receivedAt, bucket));
    const done = !UNPROCESSED.has(d.state);
    if (done) processed += 1;
    if (row !== undefined) {
      row.received += 1;
      if (done) row.processed += 1;
    }
  }

  // Chases.
  const responseHours = chases
    .filter((c) => c.state === 'CLOSED_RECEIVED' && c.firstSentAt !== null && c.closedAt !== null)
    .map((c) => ((c.closedAt as Date).getTime() - (c.firstSentAt as Date).getTime()) / 3_600_000);
  const chaseMedian = median(responseHours);

  // Approval ages.
  const ages = pending.map((p) => (now.getTime() - p.createdAt.getTime()) / DAY_MS);

  // Item delay: document date → upload.
  const delays = docs
    .filter((d) => d.documentDate !== null && d.receivedAt >= (d.documentDate as Date))
    .map((d) => (d.receivedAt.getTime() - (d.documentDate as Date).getTime()) / DAY_MS);

  // Supplier-rule coverage, per (client, supplier).
  const ruled = new Set(rules.map((r) => `${r.businessId}|${(r.scopeKey ?? '').trim().toLowerCase()}`));
  const suppliers = new Set(
    docs
      .filter((d) => d.businessId !== null && d.supplierName !== null && d.supplierName.trim() !== '')
      .map((d) => `${d.businessId}|${(d.supplierName as string).trim().toLowerCase()}`),
  );
  const covered = [...suppliers].filter((s) => ruled.has(s)).length;

  // Team workload: open tasks + proposals awaiting review, per human.
  const workloadIds = [
    ...tasks.map((t) => t.ownerUserId),
    ...pending.map((p) => p.createdByUserId),
  ].filter((id): id is string => id !== null);
  const people = await db.user.findMany({
    where: { id: { in: [...new Set(workloadIds)] }, kind: 'HUMAN' },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const nameOf = new Map(
    people.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Unnamed colleague']),
  );
  const workload = tally(workloadIds.filter((id) => nameOf.has(id)).map((id) => nameOf.get(id) as string));

  // Inactive clients: active, nothing received this period.
  const activeIds = new Set(docs.map((d) => d.businessId));
  const quiet = businesses.filter((b) => !activeIds.has(b.id));
  const lastSeen =
    quiet.length === 0
      ? []
      : await db.document.groupBy({
          by: ['businessId'],
          where: { businessId: { in: quiet.map((b) => b.id) }, ...notDeleted() },
          _max: { receivedAt: true },
        });
  const lastById = new Map(lastSeen.map((r) => [r.businessId, r._max.receivedAt]));

  const metric = (key: string, label: string, value: number | null, unit: AnalyticsMetric['unit']): AnalyticsMetric => ({
    key,
    label,
    value,
    unit,
  });

  const metrics: AnalyticsMetric[] = [
    metric('documentsReceived', 'Documents received', docs.length, 'count'),
    metric('documentsProcessed', 'Documents processed', processed, 'count'),
    metric('extractionCorrectionRate', 'Extraction correction rate', percent(corrected.length, processed), 'percent'),
    metric('autoCategorisationAcceptance', 'Auto-categorisation acceptance', percent(accepted, accepted + dismissed), 'percent'),
    metric('percentPublished', 'Published', percent(docs.filter((d) => d.state === 'PUBLISHED').length, docs.length), 'percent'),
    metric('duplicatesCaught', 'Duplicates caught', duplicates, 'count'),
    metric('missingDocuments', 'Bank lines with no document (now)', missing, 'count'),
    metric('chaseResponseRate', 'Chase response rate', percent(responseHours.length, chases.length), 'percent'),
    metric('chaseMedianResponseHours', 'Median chase response time', chaseMedian === null ? null : round1(chaseMedian), 'hours'),
    metric('overdueChases', 'Overdue chases (sent over 7 days ago, still open)', overdue, 'count'),
    metric('approvalQueue', 'Proposals awaiting approval', pending.length, 'count'),
    metric('approvalQueueOldestDays', 'Oldest proposal waiting', ages.length === 0 ? null : round1(Math.max(...ages)), 'days'),
    metric('publishFailures', 'Publish failures', publishFailures, 'count'),
    metric(
      'avgItemDelayDays',
      'Average delay, document date to upload',
      delays.length === 0 ? null : round1(delays.reduce((a, b) => a + b, 0) / delays.length),
      'days',
    ),
    metric('inactiveClients', 'Clients with nothing received', quiet.length, 'count'),
    metric('supplierRuleCoverage', 'Suppliers covered by a coding rule', percent(covered, suppliers.size), 'percent'),
  ];

  const breakdowns: AnalyticsBreakdown[] = [
    { key: 'channelMix', title: 'Documents by channel', rows: tally(docs.map((d) => d.channel)) },
    { key: 'documentStates', title: 'Documents by state', rows: tally(docs.map((d) => d.state)) },
    { key: 'approvalAges', title: 'Approval queue by age', rows: tally(ages.map(ageBand)) },
    { key: 'teamWorkload', title: 'Team workload (open tasks + proposals awaiting review)', rows: workload },
    {
      key: 'integrationHealth',
      title: 'Integration health',
      rows: tally(integrations.map((i) => `${i.kind} · ${i.isActive ? (i.health ?? 'unknown') : 'disconnected'}`)),
    },
  ];

  return {
    scope: businessId === null ? 'practice' : 'business',
    businessId,
    from: isoDay(from),
    to: isoDay(to),
    bucket,
    generatedAt: now.toISOString(),
    series: [...series.values()],
    metrics,
    breakdowns,
    inactiveClients: quiet.map((b) => ({
      businessId: b.id,
      name: b.name,
      lastDocumentAt: lastById.get(b.id)?.toISOString() ?? null,
    })),
  };
}

/** The same report as CSV — metrics, then series, then breakdowns. */
export function reportToCsv(report: AnalyticsReport): string {
  const cell = (v: string | number | null): string => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (...cells: (string | number | null)[]): string => cells.map(cell).join(',');
  return [
    line('section', 'key', 'label', 'value', 'unit'),
    ...report.metrics.map((m) => line('metric', m.key, m.label, m.value, m.unit)),
    ...report.series.map((s) => line('series', s.period, 'received', s.received, 'count')),
    ...report.series.map((s) => line('series', s.period, 'processed', s.processed, 'count')),
    ...report.breakdowns.flatMap((b) => b.rows.map((r) => line(b.key, r.label, b.title, r.count, 'count'))),
    ...report.inactiveClients.map((c) => line('inactiveClient', c.businessId, c.name, c.lastDocumentAt, 'lastDocumentAt')),
  ].join('\n') + '\n';
}
