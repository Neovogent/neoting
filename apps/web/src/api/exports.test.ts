import { afterEach, expect, test, vi } from 'vitest';
import { createExport } from '@neoting/contracts/client';

import { EXPORT_BATCH_CAP, previousCalendarMonth, requestExport } from './exports';

vi.mock('@neoting/contracts/client', () => ({ createExport: vi.fn(), listExports: vi.fn() }));

afterEach(() => vi.clearAllMocks());

const BODY = {
  id: 'exp_1',
  businessId: 'biz_1',
  target: 'VT_TRANSACTION_PLUS',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  rowCount: 12,
  documentCount: 11,
  state: 'succeeded',
  file: {
    url: 'https://storage.test/vt.csv?sig=x',
    expiresAt: '2026-02-01T09:40:00.000Z',
    mimeType: 'text/csv',
    byteSize: 900,
    filename: 'vt.csv',
  },
  bundle: null,
  warnings: [],
  createdAt: '2026-02-01T09:30:00.000Z',
  completedAt: '2026-02-01T09:30:02.000Z',
};

const REQUEST = {
  businessId: 'biz_1',
  target: 'VT_TRANSACTION_PLUS' as const,
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
};

test('the create response is parsed by the contract’s own schema before anything reads it', async () => {
  // orval emits no response schema for a 201, so the item schema is reached off
  // the list response. If that ever stops resolving this test is what says so.
  vi.mocked(createExport).mockResolvedValue(BODY as never);

  const result = await requestExport(REQUEST);

  expect(result.rowCount).toBe(12);
  expect(result.file?.url).toBe(BODY.file.url);
});

test('the envelope the generated types describe is unwrapped, and so is the bare body', async () => {
  // `ntFetch` returns the body itself while orval types it as `{data, status}`.
  vi.mocked(createExport).mockResolvedValue({ data: BODY, status: 201 } as never);
  await expect(requestExport(REQUEST)).resolves.toMatchObject({ id: 'exp_1' });
});

test('a body that drifts from the contract throws, naming the field', async () => {
  // A download panel built from a body we could not validate is a panel that
  // might offer a link to nothing.
  vi.mocked(createExport).mockResolvedValue({ ...BODY, rowCount: 'twelve' } as never);
  await expect(requestExport(REQUEST)).rejects.toThrow(/rowCount/);
});

test('no Idempotency-Key is set here — the mutator attaches one to every mutation', async () => {
  vi.mocked(createExport).mockResolvedValue(BODY as never);
  await requestExport(REQUEST);

  // One argument: the body. A caller cannot forget the header because a caller
  // never sets it (`packages/contracts/src/http-client.ts`).
  expect(vi.mocked(createExport).mock.calls[0]).toEqual([REQUEST]);
});

test('the batch cap is read off the contract, not typed out here', () => {
  expect(EXPORT_BATCH_CAP).toBe(500);
});

test('the default period is the whole previous calendar month, as ISO calendar dates', () => {
  expect(previousCalendarMonth(new Date(2026, 7, 26))).toEqual({
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
  });
  // 30-day month, and February in both a common and a leap year.
  expect(previousCalendarMonth(new Date(2026, 4, 3))).toEqual({
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
  });
  expect(previousCalendarMonth(new Date(2026, 2, 3))).toEqual({
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
  });
  expect(previousCalendarMonth(new Date(2028, 2, 3))).toEqual({
    periodStart: '2028-02-01',
    periodEnd: '2028-02-29',
  });
});

test('January rolls back to the previous December, not to month zero', () => {
  expect(previousCalendarMonth(new Date(2026, 0, 9))).toEqual({
    periodStart: '2025-12-01',
    periodEnd: '2025-12-31',
  });
});

test('the first day of a month still resolves to the whole month before it', () => {
  // The off-by-one that files a period as "1 August to 31 July".
  expect(previousCalendarMonth(new Date(2026, 7, 1))).toEqual({
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
  });
});
