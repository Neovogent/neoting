import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_ZIP_CAPS, inspectZip } from './zip-safety.js';

interface Entry {
  readonly name: string;
  readonly compressed: number;
  readonly uncompressed: number;
}

/** Build a central-directory header (46 bytes + name). */
function cdh(e: Entry): Buffer {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt32LE(e.compressed >>> 0, 20);
  h.writeUInt32LE(e.uncompressed >>> 0, 24);
  h.writeUInt16LE(name.length, 28);
  name.copy(h, 46);
  return h;
}

/** Assemble a minimal but structurally-valid archive: [central directory][EOCD]. */
function makeZip(entries: Entry[]): Buffer {
  const cd = Buffer.concat(entries.map(cdh));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16); // central directory starts at offset 0
  return Buffer.concat([cd, eocd]);
}

test('a well-formed archive within the caps passes', () => {
  const zip = makeZip([{ name: 'invoice.pdf', compressed: 100, uncompressed: 1000 }]);
  assert.equal(inspectZip(zip), null);
});

test('too many entries is rejected (NT-ING-004, file-count cap)', () => {
  const zip = makeZip([
    { name: 'a', compressed: 1, uncompressed: 1 },
    { name: 'b', compressed: 1, uncompressed: 1 },
    { name: 'c', compressed: 1, uncompressed: 1 },
  ]);
  const r = inspectZip(zip, { ...DEFAULT_ZIP_CAPS, maxFileCount: 2 });
  assert.equal(r?.kind, 'zip_file_count_exceeded');
  assert.equal(r?.code, 'NT-ING-004');
});

test('a size explosion is caught by the total-uncompressed cap', () => {
  // ratio 500 stays under the ratio cap, so the total-size cap is what fires.
  const zip = makeZip([{ name: 'big.bin', compressed: 2000, uncompressed: 1_000_000 }]);
  const r = inspectZip(zip, { ...DEFAULT_ZIP_CAPS, maxTotalUncompressedBytes: 1000 });
  assert.equal(r?.kind, 'zip_total_size_exceeded');
});

test('an implausible compression ratio is caught (the classic bomb)', () => {
  const zip = makeZip([{ name: 'bomb.txt', compressed: 1, uncompressed: 5_000_000 }]);
  const r = inspectZip(zip); // default caps
  assert.equal(r?.kind, 'zip_total_size_exceeded');
  assert.ok(r?.detail?.ratio, 'reports the offending ratio for the audit trail');
});

test('a ZIP64-sentinel size is refused rather than under-counted', () => {
  const zip = makeZip([{ name: 'huge', compressed: 100, uncompressed: 0xffffffff }]);
  const r = inspectZip(zip);
  assert.equal(r?.kind, 'zip_total_size_exceeded');
});

test('a nested archive is refused past the depth cap', () => {
  const zip = makeZip([{ name: 'inner.zip', compressed: 100, uncompressed: 200 }]);
  const r = inspectZip(zip); // default maxDepth: 1
  assert.equal(r?.kind, 'zip_depth_exceeded');
});

test('a buffer with no end-of-central-directory is malformed', () => {
  const r = inspectZip(Buffer.from('this is definitely not a zip archive'));
  assert.equal(r?.kind, 'malformed_archive');
});

test('a central directory that does not match its header is malformed', () => {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(0, 16); // claims a CD at offset 0 that isn't there
  const garbage = Buffer.concat([Buffer.from('garbage-not-a-cdh-record-xxxxx'), eocd]);
  // offset 0 is 'g', not the CDH signature.
  const r = inspectZip(garbage);
  assert.equal(r?.kind, 'malformed_archive');
});
