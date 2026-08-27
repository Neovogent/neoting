import { describe, expect, test } from 'vitest';
import { QrPayloadTooLargeError, byteCapacity, encodeQr, formatBits, versionBits } from './qr';

/**
 * The encoder in `qr.ts` is hand-written rather than installed, so these tests
 * are the whole of its warrant. They are not "does it produce a square" — they
 * pin the three things a QR encoder gets wrong silently, in the sense that the
 * output still looks like a QR code and simply does not scan.
 *
 * 1. **The two transcribed tables.** `ECC_CODEWORDS_PER_BLOCK` and `EC_BLOCKS`
 *    are copied numbers. The published byte-mode capacity figures below are a
 *    THIRD, independent transcription. `byteCapacity` derives its answer from
 *    the first two; if any one of the three is wrong, they disagree here.
 * 2. **The two BCH routines.** Format and version information are error-
 *    correcting codes over five and six bits; a wrong polynomial produces bits
 *    that look plausible and tell the decoder the wrong mask.
 * 3. **The function patterns.** Finders, timing and the always-dark module are
 *    what a scanner locks onto before it reads anything at all.
 */

/**
 * ISO/IEC 18004 table 7, byte mode, error-correction level M — versions 1–14.
 * Transcribed from the published capacity table, deliberately NOT derived from
 * anything in `qr.ts`. This array existing separately is the point of the test.
 */
const PUBLISHED_BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362];

describe('the capacity tables agree with the published figures', () => {
  PUBLISHED_BYTE_CAPACITY_M.forEach((published, i) => {
    const version = i + 1;
    test(`version ${version} carries ${published} bytes at level M`, () => {
      expect(byteCapacity(version)).toBe(published);
    });
  });
});

describe('the BCH routines match the published strings', () => {
  // ISO/IEC 18004 table 25. Level bits: L = 1, M = 0.
  test('format information for level L, mask 0', () => {
    expect(formatBits(1, 0).toString(2).padStart(15, '0')).toBe('111011111000100');
  });

  test('format information for level M, mask 0', () => {
    expect(formatBits(0, 0).toString(2).padStart(15, '0')).toBe('101010000010010');
  });

  // ISO/IEC 18004 table 26 — version information starts at version 7.
  test('version information for version 7', () => {
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
  });

  test('version information for version 14', () => {
    expect(versionBits(14).toString(2).padStart(18, '0')).toBe('001110011000001101');
  });
});

describe('encoding an otpauth URI', () => {
  // The real shape: `totpEngine.toURI` in apps/api/.../totp.ts, with the issuer
  // and label percent-encoded and a 32-character base32 seed.
  const URI =
    'otpauth://totp/Neo%20Accounting:priya@northgate-accounts.co.uk' +
    '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Neo%20Accounting&algorithm=SHA1&digits=6&period=30';

  test('produces a square whose side matches its version', () => {
    const qr = encodeQr(URI);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    for (const row of qr.modules) expect(row).toHaveLength(qr.size);
  });

  test('picks the smallest version that holds the payload', () => {
    const qr = encodeQr(URI);
    expect(byteCapacity(qr.version)).toBeGreaterThanOrEqual(URI.length);
    expect(byteCapacity(qr.version - 1)).toBeLessThan(URI.length);
  });

  test('draws all three finder patterns with their separators', () => {
    const qr = encodeQr(URI);
    const at = (x: number, y: number) => (qr.modules[y] as readonly boolean[])[x];
    for (const [ox, oy] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ] as const) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          // A finder is a 7×7: dark ring, light ring, dark 3×3 core.
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(at(ox + dx, oy + dy)).toBe(ring !== 2);
        }
      }
    }
  });

  test('draws the timing patterns and the always-dark module', () => {
    const qr = encodeQr(URI);
    const at = (x: number, y: number) => (qr.modules[y] as readonly boolean[])[x];
    for (let i = 8; i < qr.size - 8; i++) {
      expect(at(i, 6)).toBe(i % 2 === 0);
      expect(at(6, i)).toBe(i % 2 === 0);
    }
    expect(at(8, qr.size - 8)).toBe(true);
  });

  test('a different secret produces a different matrix', () => {
    // Two enrolments must not draw the same code — the guard against an
    // encoder that has quietly stopped reading its input.
    const other = URI.replace('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U');
    expect(encodeQr(other).modules).not.toEqual(encodeQr(URI).modules);
  });

  test('the same input twice produces the same matrix', () => {
    expect(encodeQr(URI).modules).toEqual(encodeQr(URI).modules);
  });

  test('roughly half the modules are dark', () => {
    // Not a spec rule — a smoke test that masking ran. An unmasked symbol over
    // a URI with long ASCII runs skews hard, and this is the cheapest signal
    // that it did not.
    const qr = encodeQr(URI);
    const dark = qr.modules.flatMap((row) => row).filter(Boolean).length;
    const ratio = dark / (qr.size * qr.size);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});

/**
 * The round trip: read the symbol back out and check it says what went in.
 *
 * This is the test that covers the parts no table can — the data zigzag, the
 * block interleave, the mask, and the format bits that tell a reader which
 * mask was used. It walks the encoder's steps backwards from the matrix alone,
 * so a payload that survives it is one whose placement is right.
 *
 * It reads only the DATA codewords and stops: verifying the Reed–Solomon
 * remainder would need a full syndrome decoder, and the generator polynomial
 * is already pinned by construction above. What this catches is the class of
 * bug that produces a symbol a scanner locks onto and then reads as rubbish.
 */
function decode(qr: ReturnType<typeof encodeQr>): string {
  const { size, modules, version } = qr;

  // 1. The format information, from the copy beside the top-left finder.
  const at = (x: number, y: number) => (modules[y] as readonly boolean[])[x] === true;
  const formatRead = [
    at(8, 0), at(8, 1), at(8, 2), at(8, 3), at(8, 4), at(8, 5), at(8, 7), at(8, 8),
    at(7, 8), at(5, 8), at(4, 8), at(3, 8), at(2, 8), at(1, 8), at(0, 8),
  ].reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << i), 0);
  // Recover the mask by matching against every level/mask the encoder can mint.
  let mask = -1;
  for (let candidate = 0; candidate < 8; candidate++) {
    if (formatBits(0, candidate) === formatRead) mask = candidate;
  }
  expect(mask).toBeGreaterThanOrEqual(0);

  // 2. Rebuild the function-pattern map, so the walk skips exactly what the
  //    encoder skipped. Derived here from the geometry rather than shared with
  //    the encoder — a map copied from `qr.ts` would test nothing.
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserve = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) (reserved[y] as boolean[])[x] = true;
  };
  for (let i = 0; i < size; i++) {
    reserve(6, i);
    reserve(i, 6);
  }
  for (const [ox, oy] of [[0, 0], [size - 8, 0], [0, size - 8]] as const) {
    for (let dy = 0; dy < 9; dy++) for (let dx = 0; dx < 9; dx++) reserve(ox + dx, oy + dy);
  }
  // Row 8 and column 8 hold the format information — but only at their two
  // ends. The middle of both is ordinary data, and reserving the whole line is
  // the mistake that makes every version above 1 read back as noise.
  for (let i = 0; i <= 8; i++) {
    reserve(i, 8);
    reserve(8, i);
  }
  for (let i = 0; i < 8; i++) {
    reserve(size - 1 - i, 8);
    reserve(8, size - 1 - i);
  }
  const centres = (() => {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const out: number[] = [];
    for (let pos = size - 7; out.length < count - 1; pos -= step) out.unshift(pos);
    out.unshift(6);
    return out;
  })();
  const last = centres.length - 1;
  centres.forEach((cx, i) =>
    centres.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) reserve(cx + dx, cy + dy);
    }),
  );
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      reserve(a, b);
      reserve(b, a);
    }
  }

  // 3. Walk the zigzag, undoing the mask as we go.
  const rule: readonly ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const unmask = rule[mask] as (x: number, y: number) => boolean;
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if ((reserved[y] as boolean[])[x]) continue;
        bits.push((at(x, y) !== unmask(x, y)) ? 1 : 0);
      }
    }
  }
  const interleaved: number[] = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    interleaved.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }

  // 4. De-interleave back into per-block data codewords, then concatenate.
  const raw = interleaved.length;
  const blocks = BLOCKS_M[version - 1] as number;
  const eccLength = ECC_M[version - 1] as number;
  const shortBlocks = blocks - (raw % blocks);
  const shortDataLength = Math.floor(raw / blocks) - eccLength;
  const perBlock: number[][] = Array.from({ length: blocks }, () => []);
  let k = 0;
  for (let i = 0; i <= shortDataLength; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < shortDataLength || b >= shortBlocks) (perBlock[b] as number[]).push(interleaved[k++] as number);
    }
  }
  const data = perBlock.flat();

  // 5. Mode, length, payload.
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (byte >>> s) & 1));
  const take = (n: number, from: number) => stream.slice(from, from + n).reduce((acc, b) => (acc << 1) | b, 0);
  expect(take(4, 0)).toBe(0b0100); // byte mode
  const countBits = version <= 9 ? 8 : 16;
  const length = take(countBits, 4);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8, 4 + countBits + i * 8);
  return new TextDecoder().decode(bytes);
}

// The decoder needs the same two tables. Transcribed AGAIN here on purpose:
// three independent copies is what makes the capacity cross-check above mean
// something, and a de-interleave written against the encoder's own constants
// would agree with it however wrong both were.
const ECC_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24];
const BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9];

describe('a symbol reads back as what went into it', () => {
  const CASES = [
    ['a single character', 'a'],
    ['a short URI', 'otpauth://totp/x?secret=JBSWY3DP'],
    ['a realistic enrolment URI',
      'otpauth://totp/Neo%20Accounting:priya@northgate-accounts.co.uk' +
      '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Neo%20Accounting&algorithm=SHA1&digits=6&period=30'],
    ['a payload that needs the 16-bit length field', 'x'.repeat(220)],
    ['a payload at the top of the supported range', 'y'.repeat(362)],
    ['non-ASCII in the label', 'otpauth://totp/Neo:aoífe@example.co.uk?secret=JBSWY3DPEHPK3PXP'],
  ] as const;

  CASES.forEach(([name, payload]) => {
    test(name, () => {
      expect(decode(encodeQr(payload))).toBe(payload);
    });
  });

  test('every version boundary round-trips', () => {
    // One payload sized exactly to each version's capacity, so every block
    // layout in the supported range — including the multi-block interleave
    // that starts at version 4 — is walked in both directions.
    PUBLISHED_BYTE_CAPACITY_M.forEach((capacity, i) => {
      const payload = 'z'.repeat(capacity);
      const qr = encodeQr(payload);
      expect(qr.version).toBe(i + 1);
      expect(decode(qr)).toBe(payload);
    });
  });
});

describe('the edges of the supported range', () => {
  test('the shortest payload still encodes', () => {
    expect(encodeQr('a').version).toBe(1);
  });

  test('a payload at the version-14 limit encodes', () => {
    expect(encodeQr('x'.repeat(362)).version).toBe(14);
  });

  test('a payload past the version-14 limit is refused, not truncated', () => {
    // The failure that matters: an encoder that quietly drops the tail hands
    // the user a QR that scans cleanly into a broken secret.
    expect(() => encodeQr('x'.repeat(363))).toThrow(QrPayloadTooLargeError);
  });

  test('multi-byte characters are counted as UTF-8 bytes', () => {
    // A label is a user's own email address, so ASCII is an assumption, not a
    // fact. 121 three-byte characters is 363 bytes — one past the limit.
    expect(() => encodeQr('あ'.repeat(121))).toThrow(QrPayloadTooLargeError);
  });
});
