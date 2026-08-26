import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { MANIFEST_FILENAME } from './manifest.js';
import { type BundleDocument, type SourceDocumentBytes, buildSourceDocumentBundle } from './source-document-bundle.js';

/** The independent reader from `zip.test.ts`, reduced to names and payloads. */
function readNames(archive: Buffer): string[] {
  const eocd = archive.length - 22;
  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    names.push(archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('ascii'));
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  return names;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const PDF = Buffer.from('%PDF-1.4\ninvoice\n', 'ascii');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function document(over: Partial<BundleDocument> = {}): BundleDocument {
  return {
    documentId: 'doc_1',
    link: { code: 'A7K2M9PQ', url: 'https://neoacc.neovogent.com/d/A7K2M9PQ' },
    s3Key: 'w/biz_1/documents/one',
    mimeType: 'application/pdf',
    byteHash: sha256(PDF),
    supplierName: 'Bidfood Ltd',
    documentDate: '2026-08-04',
    reference: 'INV-2026-0041',
    totalPence: 123_456,
    ...over,
  };
}

function storeOf(objects: Record<string, Buffer>): SourceDocumentBytes {
  return {
    read: async (key) => {
      const bytes = objects[key];
      if (bytes === undefined) throw new Error(`no object at ${key}`);
      return bytes;
    },
  };
}

describe('the bundle', () => {
  test('the manifest is entry ZERO, then the documents named by their codes', async () => {
    const documents = [
      document(),
      document({
        documentId: 'doc_2',
        link: { code: 'B8N3P0QR', url: 'https://neoacc.neovogent.com/d/B8N3P0QR' },
        s3Key: 'w/biz_1/documents/two',
        mimeType: 'image/jpeg',
        byteHash: sha256(JPEG),
      }),
    ];
    const bundle = await buildSourceDocumentBundle({
      documents,
      readBytes: storeOf({ 'w/biz_1/documents/one': PDF, 'w/biz_1/documents/two': JPEG }),
    });

    expect(readNames(bundle.bytes)).toEqual([
      MANIFEST_FILENAME,
      'documents/A7K2M9PQ.pdf',
      'documents/B8N3P0QR.jpg',
    ]);
    expect(bundle.documentCount).toBe(2);
    expect(bundle.warnings).toEqual([]);
  });

  test('the manifest lists exactly the documents that made it in', async () => {
    const bundle = await buildSourceDocumentBundle({
      documents: [document()],
      readBytes: storeOf({ 'w/biz_1/documents/one': PDF }),
    });
    const manifest = bundle.bytes.toString('utf8');
    expect(manifest).toContain('A7K2M9PQ');
    expect(manifest).toContain('documents/A7K2M9PQ.pdf');
    expect(manifest).toContain('https://neoacc.neovogent.com/d/A7K2M9PQ');
  });

  test('an empty export is a valid bundle carrying only the header row', async () => {
    const bundle = await buildSourceDocumentBundle({ documents: [], readBytes: storeOf({}) });
    expect(readNames(bundle.bytes)).toEqual([MANIFEST_FILENAME]);
    expect(bundle.documentCount).toBe(0);
  });

  test('the object key never appears in the bundle — it is storage’s business, not the accountant’s', async () => {
    const bundle = await buildSourceDocumentBundle({
      documents: [document()],
      readBytes: storeOf({ 'w/biz_1/documents/one': PDF }),
    });
    expect(bundle.bytes.toString('binary')).not.toContain('w/biz_1/documents/one');
  });
});

describe('⚠ nothing is ever silently dropped', () => {
  test('a document whose bytes cannot be read is REPORTED and left out of both the archive and the manifest', async () => {
    const bundle = await buildSourceDocumentBundle({
      documents: [document()],
      readBytes: storeOf({}),
    });

    expect(bundle.documentCount).toBe(0);
    expect(readNames(bundle.bytes)).toEqual([MANIFEST_FILENAME]);
    expect(bundle.warnings).toEqual([
      {
        documentId: 'doc_1',
        code: 'source-document-unreadable',
        message: expect.stringContaining('A7K2M9PQ') as unknown as string,
      },
    ]);
    // A manifest that listed a file the archive does not contain would be a
    // manifest that lies — the one thing rung 4 must not do.
    expect(bundle.bytes.toString('utf8')).not.toContain('documents/A7K2M9PQ.pdf');
  });

  test('a document whose bytes no longer match its recorded checksum is refused, with its OWN warning code', async () => {
    const bundle = await buildSourceDocumentBundle({
      documents: [document({ byteHash: sha256(Buffer.from('a different file')) })],
      readBytes: storeOf({ 'w/biz_1/documents/one': PDF }),
    });

    expect(bundle.documentCount).toBe(0);
    expect(bundle.warnings[0]?.code).toBe('source-document-hash-mismatch');
    // "The file in storage is not the file that was approved" is a different
    // and worse thing than "the file is missing", and it reads differently.
    expect(bundle.warnings[0]?.message).toContain('Investigate');
  });

  test('one bad document does not take the rest of the export down', async () => {
    const bundle = await buildSourceDocumentBundle({
      documents: [
        document(),
        document({
          documentId: 'doc_2',
          link: { code: 'B8N3P0QR', url: 'https://neoacc.neovogent.com/d/B8N3P0QR' },
          s3Key: 'w/biz_1/documents/gone',
          byteHash: sha256(JPEG),
        }),
      ],
      readBytes: storeOf({ 'w/biz_1/documents/one': PDF }),
    });

    expect(readNames(bundle.bytes)).toEqual([MANIFEST_FILENAME, 'documents/A7K2M9PQ.pdf']);
    expect(bundle.documentCount).toBe(1);
    expect(bundle.warnings.map((warning) => warning.documentId)).toEqual(['doc_2']);
  });
});
