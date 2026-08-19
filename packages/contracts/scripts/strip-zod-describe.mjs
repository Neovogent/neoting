/**
 * Post-generation step: strip `.describe('…')` from the generated Zod schemas.
 *
 * WHY THIS EXISTS
 * ---------------
 * orval copies every `description:` in the spec into the generated Zod as
 * `.describe('…')` — unconditionally; v7.21 has no option for it (measured in
 * @orval/zod's `parseZodValidationSchemaDefinition`). The descriptions are the
 * contract's PROSE — multi-paragraph design notes on `ProposalKind`,
 * `renderedSummaryHash` and the rest — and Zod's `.describe()` only stows them
 * as `_def.description`, which nothing in this repo reads (the `_def` readers
 * are `query-coercion.ts` on `typeName`/`innerType` and `proposal-body.ts` on
 * intersection halves; behaviour is untouched by stripping).
 *
 * What they DID do is ship to users: `apps/web` bundles the Zod schemas it
 * parses responses with, and the schemas its bundle-floor modules pull in
 * carried ~10 kB gzip of spec prose into the shared chunk of every route —
 * measured against the 250 kB route budget when METH S12 wired the proposals
 * queue and the floor went over. Stripping here bought the floor back
 * (188.6 → ~179 kB gzip) for every route at once.
 *
 * The docs are not lost: `openapi.yaml` is the source of truth and the
 * generated `model/` .ts files keep them as JSDoc, where an editor shows them.
 * check-contract.mjs verifies this ran, so it cannot be skipped silently.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZOD_DIR = resolve(HERE, '../src/generated/zod');

/**
 * `.describe('…')` exactly as orval emits it: single-quoted, one line, inner
 * quotes and backslashes escaped by jsStringEscape (newlines arrive as `\n`
 * escapes, never raw). The alternation consumes escaped pairs atomically so an
 * escaped quote cannot end the match early.
 */
const DESCRIBE = /\.describe\('(?:[^'\\]|\\.)*'\)/g;

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

let stripped = 0;
let filesTouched = 0;

for (const file of walkFiles(ZOD_DIR)) {
  const before = readFileSync(file, 'utf8');
  let count = 0;
  const after = before.replace(DESCRIBE, () => {
    count += 1;
    return '';
  });
  if (count > 0) {
    writeFileSync(file, after);
    stripped += count;
    filesTouched += 1;
  }
}

console.log(`strip-zod-describe: removed ${stripped} describe(s) across ${filesTouched} file(s)`);
