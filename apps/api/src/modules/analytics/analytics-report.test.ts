import { describe, expect, it } from 'vitest';

import { ageBand, bucketFor, bucketKey, bucketStarts, median, percent, reportToCsv } from './analytics-report.js';
import { resolvePeriod } from './analytics.service.js';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('analytics pure math', () => {
  it('median handles empty, odd and even', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('percent is null with nothing to divide by, 1dp otherwise', () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 2)).toBe(100);
  });

  it('buckets by day up to 31 days and by Monday-start ISO week beyond', () => {
    expect(bucketFor(d('2026-10-01'), d('2026-10-31'))).toBe('day');
    expect(bucketFor(d('2026-10-01'), d('2026-11-01'))).toBe('week');
    // Thu 15 Oct 2026 falls in the week starting Mon 12 Oct.
    expect(bucketKey(new Date('2026-10-15T13:00:00Z'), 'week')).toBe('2026-10-12');
    expect(bucketStarts(d('2026-10-01'), d('2026-10-03'), 'day')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(bucketStarts(d('2026-10-01'), d('2026-10-20'), 'week')).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
  });

  it('age bands', () => {
    expect(ageBand(0.5)).toBe('Under 1 day');
    expect(ageBand(8)).toBe('Over 7 days');
  });

  it('defaults to the last 30 days and refuses a backwards period', () => {
    const { from, to } = resolvePeriod({}, new Date('2026-10-15T09:00:00Z'));
    expect(to.toISOString().slice(0, 10)).toBe('2026-10-15');
    expect(from.toISOString().slice(0, 10)).toBe('2026-09-16');
    expect(() => resolvePeriod({ from: '2026-10-10', to: '2026-10-01' }, new Date())).toThrow();
  });

  it('CSV escapes quotes and commas', () => {
    const csv = reportToCsv({
      scope: 'practice',
      businessId: null,
      from: '2026-10-01',
      to: '2026-10-01',
      bucket: 'day',
      generatedAt: '2026-10-01T00:00:00.000Z',
      series: [],
      metrics: [{ key: 'k', label: 'A "b", c', value: null, unit: 'count' }],
      breakdowns: [],
      inactiveClients: [],
    });
    expect(csv).toContain('metric,k,"A ""b"", c",,count');
  });
});
