import { expect, test } from 'vitest';

import { createQpdfDocumentGuard, type QpdfRunner, stripArgs } from './qpdf-document-guard.js';

/**
 * The decision logic — qpdf's exit code to a verdict — tested with a fake
 * runner, so it is covered on every machine rather than only where the binary
 * happens to be installed.
 *
 * The exit codes below are qpdf's documented contract, verified against
 * qpdf 11.9.1: `--is-encrypted` exits 0 for an encrypted file and 2 for a clean
 * one, and a conversion "succeeded with warnings" exits 3.
 */
const STRIPPED = Buffer.from('%PDF-1.7 rebuilt from pages, no javascript %%EOF');

function fakeRunner(
  encryptedCode: number,
  stripCode = 0,
  stderr = '',
): { runner: QpdfRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async isEncrypted() {
        calls.push('isEncrypted');
        return { code: encryptedCode, stderr };
      },
      async stripActiveContent() {
        calls.push('stripActiveContent');
        return stripCode === 0 || stripCode === 3
          ? { code: stripCode, stderr, output: STRIPPED }
          : { code: stripCode, stderr };
      },
    },
  };
}

const PDF = Buffer.from('%PDF-1.7\nnot really, the runner is faked\n%%EOF');

test('an encrypted PDF is refused with the password reason', async () => {
  const { runner } = fakeRunner(0); // --is-encrypted: 0 means encrypted
  const guard = createQpdfDocumentGuard({ runner });

  const result = await guard.inspect(PDF, 'pdf');
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.rejection.kind).toBe('password_protected');
    expect(result.rejection.message).toMatch(/password/i);
  }
});

test('a clean PDF proceeds to the stripping pass', async () => {
  const { runner, calls } = fakeRunner(2, 0); // not encrypted, then a clean rewrite
  const guard = createQpdfDocumentGuard({ runner });

  const result = await guard.inspect(PDF, 'pdf');

  expect(calls).toEqual(['isEncrypted', 'stripActiveContent']);
  // The bytes that continue down the pipeline are the REWRITTEN ones — that is
  // what makes the stripping real rather than advisory.
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.bytes.equals(STRIPPED)).toBe(true);
});

test('"succeeded with warnings" is accepted, because real PDFs are not byte-perfect', async () => {
  // Exit 3 is the NORMAL outcome for genuine invoices from accounting software.
  // Treating it as failure would refuse most of the real corpus.
  const { runner } = fakeRunner(2, 3);
  const guard = createQpdfDocumentGuard({ runner });
  const result = await guard.inspect(PDF, 'pdf');
  expect(result.ok).toBe(true);
});

test('an unreadable PDF is a visible refusal, not a thrown error', async () => {
  const { runner } = fakeRunner(2, 2, 'qpdf: damaged beyond repair');
  const guard = createQpdfDocumentGuard({ runner });

  const result = await guard.inspect(PDF, 'pdf');
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.rejection.message).toMatch(/could not read/i);
    // qpdf's stderr derives from attacker-controlled bytes: kept for our logs,
    // never put in front of a submitter or a model.
    expect(result.rejection.message).not.toMatch(/damaged beyond repair/);
    expect(result.rejection.detail?.['reason']).toMatch(/damaged beyond repair/);
  }
});

test('the strip invocation starts from an empty document, or it does nothing', () => {
  // A REAL mistake made while writing this, caught only by running qpdf.
  //
  // qpdf is a CONTENT-PRESERVING transformer: given an input document it keeps
  // that document's catalog, so `qpdf in.pdf --pages . 1-z -- out.pdf` copies
  // the JavaScript name tree, OpenAction and embedded files straight through.
  // Verified against qpdf 11.9.1 — a fixture carrying two JavaScript actions
  // and an embedded payload.exe came out with every one of them intact, exit 3,
  // no warning that anything had been skipped.
  //
  // `--empty` starts from a BLANK document and pulls only pages into it. Same
  // fixture: all five hits gone, both pages preserved, payload.exe absent.
  //
  // Its absence fails nothing loudly, which is exactly why it is pinned here.
  const args = stripArgs('/tmp/in.pdf', '/tmp/out.pdf');

  expect(args[0]).toBe('--empty');
  expect(args).toEqual(['--empty', '--pages', '/tmp/in.pdf', '1-z', '--', '/tmp/out.pdf']);
  // `1` instead of `1-z` would keep only the first page and quietly truncate
  // every multi-page invoice.
  expect(args).toContain('1-z');
});

test('a non-PDF is passed through untouched — qpdf is not asked about it', async () => {
  // Encrypted Office documents are a different container with a different
  // scheme. Running qpdf over one would report clean because it never looked,
  // which is worse than admitting the gap.
  const { runner, calls } = fakeRunner(0);
  const guard = createQpdfDocumentGuard({ runner });

  const docx = Buffer.from('PK fake docx');
  const result = await guard.inspect(docx, 'docx');

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.bytes.equals(docx)).toBe(true);
  expect(calls).toHaveLength(0);
});
