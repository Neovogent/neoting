import { expect, test } from 'vitest';

import { safeBasename } from './safe-basename.js';

// safeBasename is a SECURITY reduction, not a formatting nicety: every channel
// (an email Content-Disposition, a WhatsApp document.filename, a portal upload)
// takes a name from someone outside the system, and a name that survives as a
// path is a path-traversal write. It is shared rather than copied precisely so
// two channels cannot reduce it two different ways — these tests pin the one
// behaviour both rely on.

test('strips a POSIX traversal to its basename', () => {
  expect(safeBasename('../../etc/passwd')).toBe('passwd');
  expect(safeBasename('/absolute/path/receipt.pdf')).toBe('receipt.pdf');
});

test('strips a Windows traversal to its basename', () => {
  expect(safeBasename('C:\\evil\\x.pdf')).toBe('x.pdf');
  expect(safeBasename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
});

test('with mixed separators, keeps only what follows the last one', () => {
  expect(safeBasename('a/b\\c.pdf')).toBe('c.pdf');
  expect(safeBasename('dir\\sub/file.png')).toBe('file.png');
});

test('a plain filename is returned unchanged', () => {
  expect(safeBasename('receipt.pdf')).toBe('receipt.pdf');
});

test('surrounding whitespace is trimmed', () => {
  expect(safeBasename('  receipt.pdf  ')).toBe('receipt.pdf');
});

test('a leading-dot name is a filename, not a traversal, and is kept', () => {
  // '.env' has no separator, so there is nothing to strip; it must not be
  // mistaken for '.' or '..' and collapsed to the fallback.
  expect(safeBasename('.env')).toBe('.env');
  expect(safeBasename('.gitignore')).toBe('.gitignore');
});

test('names that reduce to nothing usable fall back to a safe constant', () => {
  // Each of these would otherwise leave an empty or dot-only string that a caller
  // could treat as a directory or as the current/parent dir.
  for (const degenerate of ['', '   ', '.', '..', '/', '\\', 'a/']) {
    expect(safeBasename(degenerate)).toBe('attachment');
  }
});
