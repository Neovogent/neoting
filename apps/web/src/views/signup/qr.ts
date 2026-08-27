/**
 * A QR encoder, in the repo rather than from npm.
 *
 * The enrolment screen has to draw `otpauth://totp/…` as something a phone
 * camera can read. Every other option was worse:
 *
 * - **A dependency.** `CLAUDE.md` puts "adding a dependency" on the stop-and-ask
 *   list, and this stage has no contract-change issue behind it. The repo's own
 *   precedent is the answer it keeps giving: the router, the ESLint literal
 *   rule, the legal-markdown transform and the i18n checker are all hand-rolled
 *   for the same reason. If Shakib would rather take `qrcode`, this module is
 *   one import and one component call — swap it and delete the file.
 * - **A server-rendered image.** The URI is secret material. Round-tripping it
 *   through an image endpoint puts a TOTP seed in a URL, an access log and a
 *   CDN, which is the one thing M9 says not to do.
 * - **A third-party chart URL.** That is the same disclosure, to somebody else.
 *
 * ⚠ **SCOPE: byte mode, error-correction level M, versions 1–14.** That is
 * everything an `otpauth://` URI needs (v14-M holds 362 bytes; the longest URI
 * this product can mint is around 160) and nothing else. It is not a general
 * QR library and should not grow into one — a payload it cannot hold throws
 * rather than silently truncating.
 *
 * ⚠ **HOW THE TABLES WERE VERIFIED, because two hand-copied number tables are
 * exactly where an encoder like this goes wrong.** `ECC_CODEWORDS_PER_BLOCK`
 * and `EC_BLOCKS` are transcribed; the published byte-mode *capacity* figures
 * are a third, independent transcription. `qr.test.ts` derives capacity from
 * the first two and asserts it equals the third for all fourteen versions — so
 * a slip in any one of them fails the build rather than shipping a code that
 * scans as noise. The two BCH routines are likewise pinned against the
 * published format and version strings. Read `qr.test.ts` before editing any
 * number in this file.
 *
 * The structure follows Nayuki's reference decomposition (public domain), which
 * is the clearest published statement of the ISO/IEC 18004 encoding steps.
 */

/** Error-correction level M — the otpauth convention, and ~15% recoverable. */
const ECC_LEVEL_BITS = 0;

const MIN_VERSION = 1;
const MAX_VERSION = 14;

/**
 * Error-correction codewords per block, level M, versions 1–14.
 * Cross-checked against the published capacity table by `qr.test.ts`.
 */
const ECC_CODEWORDS_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24] as const;

/** Error-correction blocks, level M, versions 1–14. Same cross-check. */
const EC_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9] as const;

/** What `encodeQr` returns: a square of dark/light modules, quiet zone excluded. */
export interface QrMatrix {
  /** Modules per side, `21 + 4 * (version - 1)`. */
  readonly size: number;
  /** `true` is a dark module. Indexed `[y][x]`, origin top-left. */
  readonly modules: readonly (readonly boolean[])[];
  /** Which version was chosen — surfaced for tests, not for the UI. */
  readonly version: number;
}

/** Thrown for a payload no supported version can hold. */
export class QrPayloadTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`QR payload of ${byteLength} bytes exceeds version ${MAX_VERSION} at level M`);
    this.name = 'QrPayloadTooLargeError';
  }
}

/**
 * Encode `text` as a QR matrix.
 *
 * UTF-8 byte mode throughout. An `otpauth://` URI is percent-encoded by the
 * server before it reaches here, so in practice every byte is ASCII — but the
 * encoder does not assume it, because the label inside the URI is a user's own
 * email address and assuming ASCII about user input is how this breaks later.
 */
export function encodeQr(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  const version = smallestVersionFor(data.length);
  const codewords = addEccAndInterleave(buildDataCodewords(data, version), version);

  const size = moduleCount(version);
  // `modules` carries the drawing; `reserved` marks every module the function
  // patterns own, so the data zigzag and the mask both know to leave them be.
  const modules = emptyGrid(size);
  const reserved = emptyGrid(size);

  drawFunctionPatterns(modules, reserved, version);
  drawCodewords(modules, reserved, codewords);

  const mask = bestMask(modules, reserved);
  applyMask(modules, reserved, mask);
  drawFormatBits(modules, reserved, mask);

  return { size, modules, version };
}

/* ── sizing ──────────────────────────────────────────────────────────────── */

const moduleCount = (version: number): number => version * 4 + 17;

/**
 * Total modules a version has available for data and error correction, before
 * the format and version information is deducted (ISO/IEC 18004 §6.4.10).
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const rawCodewords = (version: number): number => Math.floor(rawDataModules(version) / 8);

const eccPerBlock = (version: number): number => ECC_CODEWORDS_PER_BLOCK[version - 1] as number;
const blockCount = (version: number): number => EC_BLOCKS[version - 1] as number;

/** Data codewords available to the payload, error correction already removed. */
export function dataCodewords(version: number): number {
  return rawCodewords(version) - eccPerBlock(version) * blockCount(version);
}

/**
 * The byte-mode character-count field is 8 bits up to version 9 and 16 bits
 * from version 10 (ISO/IEC 18004 table 3). Getting this boundary wrong shifts
 * every bit after it, which is why it is a named function rather than an
 * inline ternary at the one call site.
 */
const charCountBits = (version: number): number => (version <= 9 ? 8 : 16);

/** Bytes a version can carry in byte mode: the published capacity figure. */
export function byteCapacity(version: number): number {
  const bits = dataCodewords(version) * 8 - 4 - charCountBits(version);
  return Math.floor(bits / 8);
}

function smallestVersionFor(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteCapacity(version) >= byteLength) return version;
  }
  throw new QrPayloadTooLargeError(byteLength);
}

/* ── the bitstream ───────────────────────────────────────────────────────── */

/**
 * Mode indicator, length, payload, terminator, pad — then the alternating pad
 * bytes that fill the rest of the capacity (ISO/IEC 18004 §7.4.10).
 */
function buildDataCodewords(data: Uint8Array, version: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(data.length, charCountBits(version));
  for (const byte of data) push(byte, 8);

  const capacityBits = dataCodewords(version) * 8;
  // Terminator: up to four zero bits, fewer if the stream is nearly full.
  push(0, Math.min(4, capacityBits - bits.length));
  // Then to a byte boundary.
  push(0, (8 - (bits.length % 8)) % 8);

  const out = new Uint8Array(dataCodewords(version));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === 1) out[i >>> 3] = (out[i >>> 3] as number) | (0x80 >>> (i & 7));
  }
  // The two prescribed pad codewords, alternating, for whatever is left.
  for (let i = bits.length / 8, pad = 0xec; i < out.length; i++, pad ^= 0xec ^ 0x11) {
    out[i] = pad;
  }
  return out;
}

/* ── Reed–Solomon over GF(256) ───────────────────────────────────────────── */

/**
 * The field's exp/log tables, built once at module load rather than
 * transcribed. `0x11d` is the QR primitive polynomial x⁸+x⁴+x³+x²+1.
 */
const { EXP, LOG } = (() => {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Doubled so a product of two logs never needs a modulo.
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255] as number;
  return { EXP: exp, LOG: log };
})();

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

/** The degree-`n` generator polynomial, (x−α⁰)(x−α¹)…(x−αⁿ⁻¹). */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data` divided by the generator — the error-correction codewords. */
function eccFor(data: Uint8Array, eccLength: number): Uint8Array {
  const gen = generatorPoly(eccLength);
  const remainder = new Uint8Array(eccLength);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.copyWithin(0, 1);
    remainder[eccLength - 1] = 0;
    for (let i = 0; i < eccLength; i++) {
      remainder[i] = (remainder[i] as number) ^ gfMul(gen[i + 1] as number, factor);
    }
  }
  return remainder;
}

/**
 * Split into blocks, error-correct each, then interleave (ISO/IEC 18004 §7.6).
 *
 * The interleave is the part worth reading twice. Blocks are not all the same
 * length: the short ones come first, and the long ones carry exactly one extra
 * data codeword. That extra codeword sits at the index a short block does not
 * have, so the column at `shortDataLength` is skipped for every short block —
 * which is what the condition in the first loop says.
 */
function addEccAndInterleave(data: Uint8Array, version: number): Uint8Array {
  const blocks = blockCount(version);
  const eccLength = eccPerBlock(version);
  const raw = rawCodewords(version);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const shortDataLength = shortLength - eccLength;

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i++) {
    const length = shortDataLength + (i < shortBlocks ? 0 : 1);
    const block = data.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(eccFor(block, eccLength));
  }

  const out = new Uint8Array(raw);
  let k = 0;
  for (let i = 0; i <= shortDataLength; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < shortDataLength || b >= shortBlocks) out[k++] = (dataBlocks[b] as Uint8Array)[i] as number;
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (let b = 0; b < blocks; b++) out[k++] = (eccBlocks[b] as Uint8Array)[i] as number;
  }
  return out;
}

/* ── the grid ────────────────────────────────────────────────────────────── */

type Grid = boolean[][];

const emptyGrid = (size: number): Grid => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

function setModule(modules: Grid, reserved: Grid, x: number, y: number, dark: boolean): void {
  (modules[y] as boolean[])[x] = dark;
  (reserved[y] as boolean[])[x] = true;
}

/**
 * Alignment-pattern centres for a version (ISO/IEC 18004 §6.3.5), computed
 * rather than tabled — one formula is less to get wrong than forty rows.
 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions: number[] = [];
  for (let pos = moduleCount(version) - 7; positions.length < count - 1; pos -= step) positions.unshift(pos);
  positions.unshift(6);
  return positions;
}

function drawFunctionPatterns(modules: Grid, reserved: Grid, version: number): void {
  const size = moduleCount(version);

  // Timing patterns, drawn first so the finders can overwrite their ends.
  for (let i = 0; i < size; i++) {
    setModule(modules, reserved, 6, i, i % 2 === 0);
    setModule(modules, reserved, i, 6, i % 2 === 0);
  }

  // The three finders, each with its separator — drawn as a 9×9 block centred
  // on the finder so the white separator ring is reserved too.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        setModule(modules, reserved, x, y, ring !== 2 && ring <= 3);
      }
    }
  }

  // Alignment patterns, skipping the three corners the finders already own.
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = positions[i] as number;
      const cy = positions[j] as number;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setModule(modules, reserved, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format information is reserved now and written after masking, because the
  // mask is one of the things it encodes. The lone dark module below the
  // top-left finder is fixed and always set.
  reserveFormatArea(modules, reserved, size);

  if (version >= 7) drawVersionBits(modules, reserved, version);
}

function reserveFormatArea(modules: Grid, reserved: Grid, size: number): void {
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setModule(modules, reserved, i, 8, false);
      setModule(modules, reserved, 8, i, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setModule(modules, reserved, size - 1 - i, 8, false);
    setModule(modules, reserved, 8, size - 1 - i, false);
  }
  setModule(modules, reserved, 8, size - 8, true); // the always-dark module
}

/**
 * BCH(15,5) over the format data, masked with `0x5412` (ISO/IEC 18004 §8.9).
 * Pinned in `qr.test.ts` against the published strings for (L,0) and (M,0).
 */
export function formatBits(eccLevelBits: number, mask: number): number {
  const data = (eccLevelBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6) over the version number (ISO/IEC 18004 §8.10). Pinned likewise. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormatBits(modules: Grid, reserved: Grid, mask: number): void {
  const size = modules.length;
  const bits = formatBits(ECC_LEVEL_BITS, mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;

  // The first copy, wrapped around the top-left finder.
  for (let i = 0; i <= 5; i++) setModule(modules, reserved, 8, i, bit(i));
  setModule(modules, reserved, 8, 7, bit(6));
  setModule(modules, reserved, 8, 8, bit(7));
  setModule(modules, reserved, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setModule(modules, reserved, 14 - i, 8, bit(i));

  // The second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) setModule(modules, reserved, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setModule(modules, reserved, 8, size - 15 + i, bit(i));
  setModule(modules, reserved, 8, size - 8, true);
}

function drawVersionBits(modules: Grid, reserved: Grid, version: number): void {
  const size = moduleCount(version);
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setModule(modules, reserved, a, b, dark);
    setModule(modules, reserved, b, a, dark);
  }
}

/**
 * The data zigzag: two-module columns walked right to left, alternating
 * upward and downward, skipping the vertical timing column at x = 6
 * (ISO/IEC 18004 §7.7.3). Anything already reserved is stepped over.
 */
function drawCodewords(modules: Grid, reserved: Grid, codewords: Uint8Array): void {
  const size = modules.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if ((reserved[y] as boolean[])[x]) continue;
        if (i >= codewords.length * 8) continue;
        (modules[y] as boolean[])[x] = ((codewords[i >>> 3] as number) >>> (7 - (i & 7)) & 1) === 1;
        i++;
      }
    }
  }
}

const MASK_RULES: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** XOR the mask over every non-function module. Its own inverse. */
function applyMask(modules: Grid, reserved: Grid, mask: number): void {
  const rule = MASK_RULES[mask] as (x: number, y: number) => boolean;
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (!(reserved[y] as boolean[])[x] && rule(x, y)) {
        (modules[y] as boolean[])[x] = !(modules[y] as boolean[])[x];
      }
    }
  }
}

/**
 * Try all eight masks and keep the lowest-penalty one (ISO/IEC 18004 §7.8.3).
 *
 * A suboptimal mask still scans, so a bug here degrades rather than breaks —
 * but the penalty rules exist because some payload-and-mask pairs produce
 * patterns a decoder mistakes for a finder, and a random base32 seed is
 * exactly the kind of payload that can hit one.
 */
function bestMask(modules: Grid, reserved: Grid): number {
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, reserved, mask);
    drawFormatBits(modules, reserved, mask);
    const penalty = penaltyScore(modules);
    // Undo — the mask is its own inverse, and the format bits are rewritten
    // by the next iteration or by the caller.
    applyMask(modules, reserved, mask);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = mask;
    }
  }
  return best;
}

function penaltyScore(modules: Grid): number {
  const size = modules.length;
  let score = 0;

  // Rules 1 and 3, run over rows and then columns.
  for (const transposed of [false, true]) {
    for (let a = 0; a < size; a++) {
      const at = (b: number) => ((transposed ? modules[b] : modules[a]) as boolean[])[transposed ? a : b] as boolean;
      let runColour = at(0);
      let runLength = 1;
      // The finder-lookalike rule is checked over a sliding window of the last
      // eleven modules, which is what "1:1:3:1:1 with four light either side"
      // reduces to when written as a bit pattern.
      let window = 0;
      const consider = (dark: boolean) => {
        window = ((window << 1) & 0x7ff) | (dark ? 1 : 0);
        if (window === 0b00001011101 || window === 0b10111010000) score += 40;
      };
      // The quiet zone counts on both sides of the line: the finder-lookalike
      // pattern is "four light, 1:1:3:1:1, four light", and at the edge of the
      // symbol those four light modules are the margin rather than data.
      for (let i = 0; i < 4; i++) consider(false);
      consider(at(0));
      for (let b = 1; b < size; b++) {
        const dark = at(b);
        consider(dark);
        if (dark === runColour) {
          runLength++;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColour = dark;
          runLength = 1;
        }
      }
      // The window has to run off the end too: four light modules of quiet
      // zone follow the last real one.
      for (let i = 0; i < 4; i++) consider(false);
    }
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = (modules[y] as boolean[])[x];
      if (
        c === (modules[y] as boolean[])[x + 1] &&
        c === (modules[y + 1] as boolean[])[x] &&
        c === (modules[y + 1] as boolean[])[x + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 4 — how far the dark proportion strays from half.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

  return score;
}
