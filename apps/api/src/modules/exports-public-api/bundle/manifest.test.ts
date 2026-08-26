import { describe, expect, test } from 'vitest';

import { MANIFEST_COLUMNS, type ManifestEntry, buildManifestCsv, bundleFileName } from './manifest.js';

const ENTRY: ManifestEntry = {
  code: 'A7K2M9PQ',
  fileName: 'documents/A7K2M9PQ.pdf',
  byteHashSha256: 'a'.repeat(64),
  reference: 'INV-2026-0041',
  documentDate: '2026-08-04',
  supplierName: 'Bidfood Ltd',
  totalPence: 123_456,
  url: 'https://neoacc.neovogent.com/d/A7K2M9PQ',
};

/** Bytes back to text, minus the BOM the module's encoder writes. */
function text(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/^﻿/, '');
}

describe('the manifest is the index an accountant reads', () => {
  test('the code is the FIRST column — it is the key they arrive holding', () => {
    expect(MANIFEST_COLUMNS[0]).toBe('Code');
  });

  test('it carries everything §24.3.2 names, plus the link', () => {
    // "document code, filename, checksum, document number, date, supplier,
    // amount" — the SoT's own list.
    expect([...MANIFEST_COLUMNS]).toEqual([
      'Code',
      'File',
      'Checksum (SHA-256)',
      'Reference',
      'Date',
      'Supplier',
      'Total',
      'Link',
    ]);
  });

  test('a header row is always written — nothing column-maps a manifest, a human reads it', () => {
    const rows = text(buildManifestCsv([])).split('\r\n');
    expect(rows[0]).toBe(MANIFEST_COLUMNS.join(','));
  });

  test('one entry renders in column order', () => {
    const rows = text(buildManifestCsv([ENTRY])).split('\r\n');
    expect(rows[1]).toBe(
      `A7K2M9PQ,documents/A7K2M9PQ.pdf,${'a'.repeat(64)},INV-2026-0041,2026-08-04,Bidfood Ltd,1234.56,https://neoacc.neovogent.com/d/A7K2M9PQ`,
    );
  });
});

describe('money, at the one boundary it stops being an integer', () => {
  test('integer pence become exactly two decimal places', () => {
    const cases: [number, string][] = [
      [0, '0.00'],
      [1, '0.01'],
      [99, '0.99'],
      [100, '1.00'],
      [123_456, '1234.56'],
      [-4_250, '-42.50'],
    ];
    for (const [pence, expected] of cases) {
      const rows = text(buildManifestCsv([{ ...ENTRY, totalPence: pence }])).split('\r\n');
      expect(rows[1]?.split(',')[6], String(pence)).toBe(expected);
    }
  });

  test('a credit note reads as negative here — the sign is VT’s convention, not the manifest’s', () => {
    expect(text(buildManifestCsv([{ ...ENTRY, totalPence: -1 }]))).toContain('-0.01');
  });

  test('a float is refused rather than rounded into something that looks right', () => {
    // Built rather than written as a literal: `totalPence: 12.34` is itself an
    // ESLint error (the R5 money selectors), which is the point — the lint rule
    // and this refusal are the same invariant enforced at two different moments.
    const wrong = 1234 / 100;
    expect(() => buildManifestCsv([{ ...ENTRY, totalPence: wrong }])).toThrow(/integer pence/);
  });
});

describe('⚠ the case that breaks hand-rolled serialisers', () => {
  test('a supplier name with BOTH a comma and an accent survives, quoted and encoded', () => {
    const bytes = buildManifestCsv([{ ...ENTRY, supplierName: 'Épicerie Dubois, S.à r.l.' }]);
    expect(text(bytes)).toContain('"Épicerie Dubois, S.à r.l."');
    // The manifest goes through the module's own encoder, so it agrees with the
    // VT import file byte-for-byte about encoding — including the BOM.
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test('a quote inside a value is doubled, not dropped', () => {
    expect(text(buildManifestCsv([{ ...ENTRY, supplierName: 'The "Good" Bakery' }]))).toContain('"The ""Good"" Bakery"');
  });

  test('a newline inside a value cannot break the row structure', () => {
    const rendered = text(buildManifestCsv([{ ...ENTRY, supplierName: 'Line one\r\nLine two' }]));
    expect(rendered).toContain('"Line one\r\nLine two"');
  });
});

describe('⚠ the filename comes from the STORED mime type, never the uploader’s', () => {
  test('the code IS the filename — that is the whole point of rung 4', () => {
    expect(bundleFileName('A7K2M9PQ', 'application/pdf')).toBe('documents/A7K2M9PQ.pdf');
  });

  test('every type ingestion accepts maps to its own extension', () => {
    expect(bundleFileName('A7K2M9PQ', 'image/jpeg')).toBe('documents/A7K2M9PQ.jpg');
    expect(bundleFileName('A7K2M9PQ', 'image/png')).toBe('documents/A7K2M9PQ.png');
    expect(bundleFileName('A7K2M9PQ', 'image/heic')).toBe('documents/A7K2M9PQ.heic');
    expect(bundleFileName('A7K2M9PQ', 'text/csv')).toBe('documents/A7K2M9PQ.csv');
    // Case from the wire is not trusted to be lower.
    expect(bundleFileName('A7K2M9PQ', 'APPLICATION/PDF')).toBe('documents/A7K2M9PQ.pdf');
  });

  test('an unknown type gets .bin — a GUESSED extension opens in the wrong application', () => {
    expect(bundleFileName('A7K2M9PQ', 'application/octet-stream')).toBe('documents/A7K2M9PQ.bin');
    expect(bundleFileName('A7K2M9PQ', 'application/x-msdownload')).toBe('documents/A7K2M9PQ.bin');
  });

  test('nothing an uploader chose can reach the name', () => {
    // The only inputs are a code we minted and a magic-byte-derived mime type,
    // so `invoice.pdf.exe` and `../../autorun.inf` have nowhere to enter.
    expect(bundleFileName('A7K2M9PQ', 'application/pdf')).not.toContain('..');
    expect(bundleFileName('A7K2M9PQ', 'application/pdf')).toMatch(/^documents\/[0-9A-Z]+\.[a-z]+$/);
  });
});
