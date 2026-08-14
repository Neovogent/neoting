import { bootstrapDocumentGuard, type DocumentGuard } from './guards.js';
import { createQpdfDocumentGuard } from './qpdf-document-guard.js';

export type DocumentGuardMode = 'fixture' | 'qpdf';

/**
 * Config-selected, not import-selected (#22), so a machine without the qpdf
 * binary still runs the suite — and so the choice is visible in configuration
 * rather than buried in an import graph.
 *
 * The fixture is NOT equivalent. It greps the first and last 8 KB for
 * `/Encrypt` and misses a mid-file trailer in an incrementally-updated PDF,
 * which is most signed or form-filled accounting paperwork. Anything relying on
 * password detection being correct must run `qpdf`.
 */
export function selectDocumentGuard(mode: DocumentGuardMode): DocumentGuard {
  return mode === 'qpdf' ? createQpdfDocumentGuard() : bootstrapDocumentGuard;
}
