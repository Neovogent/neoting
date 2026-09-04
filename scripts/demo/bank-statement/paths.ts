// Where the artifacts live. Its own module so `verify.ts` can name the same
// files without importing `generate.ts` — importing that would RUN it, and a
// verifier that regenerates what it is about to verify proves nothing.
//
// `out/` is already covered by the repo's root `.gitignore` (the `out/` build
// pattern), so nothing under it is ever committed.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const OUT_DIR = join(HERE, 'out');
export const PLAN_PATH = join(OUT_DIR, 'plan.json');
/** Fable's answer verbatim, before the boundary touched it. Audit only. */
export const PLAN_RAW_PATH = join(OUT_DIR, 'plan.raw.txt');
export const CSV_PATH = join(OUT_DIR, 'statement.csv');
export const HTML_PATH = join(OUT_DIR, 'statement.html');
export const PDF_PATH = join(OUT_DIR, 'statement.pdf');
export const META_PATH = join(OUT_DIR, 'ledger-meta.json');
