import { expect, test, vi } from 'vitest';

import type { DocumentExtractor, ExtractionOutcome, ExtractionRequest } from './document-extractor.js';
import { FallbackExtractor } from './fallback-extractor.js';

const REQUEST: ExtractionRequest = {
  filename: 'bidfood-invoice.png',
  byteHash: 'a'.repeat(64),
  s3Key: 'w/biz_burger/abc.png',
  mimeType: 'image/png',
};

const OK: ExtractionOutcome = { ok: true, document: { supplierName: 'Real' } as never };
const REFUSED: ExtractionOutcome = { ok: false, failure: { code: 'NT-EXT-004', message: 'unreadable' } };

function extractor(outcome: ExtractionOutcome | Error): DocumentExtractor {
  return {
    extract: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}

test('the real answer passes straight through', async () => {
  const fallback = extractor({ ok: true, document: { supplierName: 'Fixture' } as never });
  const result = await new FallbackExtractor(extractor(OK), fallback).extract(REQUEST);
  expect(result).toBe(OK);
  expect(fallback.extract).not.toHaveBeenCalled();
});

test('an ok:false answer is NOT a fallback trigger — it is a considered answer', async () => {
  // "I read it and could not use it" must land the document in FAILED with a
  // reason. Substituting fixture data here would hide a real unreadable
  // document behind an invented supplier and total.
  const fallback = extractor({ ok: true, document: { supplierName: 'Fixture' } as never });
  const result = await new FallbackExtractor(extractor(REFUSED), fallback).extract(REQUEST);
  expect(result).toBe(REFUSED);
  expect(fallback.extract).not.toHaveBeenCalled();
});

test('a THROW falls back — the demo survives a Bedrock outage', async () => {
  const fallback = extractor({ ok: true, document: { supplierName: 'Fixture' } as never });
  const result = await new FallbackExtractor(extractor(new Error('ThrottlingException')), fallback).extract(REQUEST);
  expect(result.ok).toBe(true);
  expect(fallback.extract).toHaveBeenCalledOnce();
});

test('the fallback is announced, never silent', async () => {
  const warn = vi.spyOn(await import('@nestjs/common').then((m) => m.Logger.prototype), 'warn').mockImplementation(() => {});
  await new FallbackExtractor(
    extractor(new Error('ThrottlingException')),
    extractor({ ok: true, document: {} as never }),
  ).extract(REQUEST);

  // The substituted data does not read the image. A client's document showing a
  // confident supplier that came from a fixture table must be greppable.
  const message = String(warn.mock.calls[0]?.[0] ?? '');
  expect(message).toContain('bidfood-invoice.png');
  expect(message).toMatch(/FALLING BACK TO FIXTURE DATA/);
  expect(message).toContain('ThrottlingException');
  warn.mockRestore();
});
