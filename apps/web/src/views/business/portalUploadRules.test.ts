import { describe, expect, test } from 'vitest';

import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import {
  PORTAL_ACCEPT,
  extensionOf,
  mimeTypeFor,
  screenPortalFile,
  screenPortalFiles,
} from './portalUploadRules';

/**
 * What the portal refuses, and why it says so.
 *
 * The rule this suite defends is that **no file is ever dropped silently**. A
 * business that believes a receipt went through and has not is exactly how
 * paperwork goes missing, and it is invisible until a VAT return is wrong.
 *
 * It also pins what this screening got wrong before it existed: the declared
 * MIME was taken from the browser alone, which hands over an empty string for
 * the commonest phone photograph on earth. (This suite's other original pin —
 * `.csv`/`.xlsx` refused — REVERSED on 5 Sep 2026: the server's allowlist was
 * widened for D40's statement upload back in August, this mirror was never
 * re-widened, and a client whose bank exports only CSV could not send it.)
 */

const file = (name: string, size = 1024, type = '') => ({ name, size, type });

describe('extensionOf', () => {
  test('is case-insensitive, and a dotfile has no extension', () => {
    expect(extensionOf('receipt.HEIC')).toBe('heic');
    expect(extensionOf('a.b.pdf')).toBe('pdf');
    expect(extensionOf('receipt')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});

describe('mimeTypeFor', () => {
  test('the browser wins when it has an opinion', () => {
    expect(mimeTypeFor({ name: 'x.pdf', type: 'application/pdf' })).toBe('application/pdf');
  });

  // ⚠ iOS routinely hands over a `.heic` with an empty `type`. Trusting the
  // browser alone turned the commonest phone photograph into a 400 from the
  // server's declared-MIME allowlist.
  test('the extension answers when the browser does not', () => {
    expect(mimeTypeFor({ name: 'IMG_0001.HEIC', type: '' })).toBe('image/heic');
    expect(mimeTypeFor({ name: 'scan.pdf', type: '' })).toBe('application/pdf');
    expect(mimeTypeFor({ name: 'mystery', type: '' })).toBe('');
  });
});

describe('screenPortalFile', () => {
  test('accepts what the server accepts', () => {
    expect(screenPortalFile(file('receipt.jpg'))).toBeNull();
    expect(screenPortalFile(file('invoice.pdf'))).toBeNull();
    expect(screenPortalFile(file('IMG.HEIC'))).toBeNull();
    expect(screenPortalFile(file('letter.docx'))).toBeNull();
  });

  // ⚠ The picker used to offer these two. The server's allowlist is the
  // sanitiser's accepted formats and neither is on it, so offering them meant
  // a refusal AFTER the client had spent their data uploading.
  test('accepts the spreadsheet formats the server takes — a bank that exports only CSV is not a refusal (5 Sep 2026)', () => {
    expect(screenPortalFile(file('statement.csv'))).toBeNull();
    expect(screenPortalFile(file('statement.xlsx'))).toBeNull();
    expect(screenPortalFile(file('statement.xls'))).toBeNull();
    expect(PORTAL_ACCEPT).toContain('.csv');
    expect(PORTAL_ACCEPT).toContain('.xlsx');
  });

  test('refuses an unknown type and names the extension it was refused for', () => {
    const refusal = screenPortalFile(file('holiday.mov'));
    expect(refusal).toEqual({ name: 'holiday.mov', reason: 'unsupported-type', extension: 'mov' });
  });

  test('a name with no extension is refused as unreadable, not as empty', () => {
    expect(screenPortalFile(file('receipt'))).toEqual({
      name: 'receipt',
      reason: 'unsupported-type',
      extension: '',
    });
  });

  // A zero-byte file is a picker that failed or a photo still syncing from
  // iCloud. The contract's own `byteSize` minimum is 1, so this only decides
  // which file is named — and it is checked before the size cap so the client
  // is told the true reason.
  test('an empty file is its own reason', () => {
    expect(screenPortalFile(file('receipt.jpg', 0))?.reason).toBe('empty');
  });

  test('the size cap is the portal cap, and the boundary is inclusive', () => {
    expect(screenPortalFile(file('big.pdf', PORTAL_UPLOAD_LIMIT))).toBeNull();
    expect(screenPortalFile(file('big.pdf', PORTAL_UPLOAD_LIMIT + 1))?.reason).toBe('too-large');
  });
});

describe('screenPortalFiles', () => {
  test('splits a pick and keeps every refusal, in order', () => {
    const { accepted, refused } = screenPortalFiles([
      file('a.jpg'),
      file('b.xyz'),
      file('c.pdf', PORTAL_UPLOAD_LIMIT + 1),
      file('d.png', 0),
    ]);

    expect(accepted.map((f) => f.name)).toEqual(['a.jpg']);
    // ⚠ THREE refusals for three files. Not one summary, not a silent drop —
    // each one is named with its own reason so the client knows which of the
    // four they still have to deal with.
    expect(refused.map((r) => [r.name, r.reason])).toEqual([
      ['b.xyz', 'unsupported-type'],
      ['c.pdf', 'too-large'],
      ['d.png', 'empty'],
    ]);
  });

  test('an empty pick refuses nothing and accepts nothing', () => {
    expect(screenPortalFiles([])).toEqual({ accepted: [], refused: [] });
  });
});
