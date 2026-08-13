/**
 * Post-generation step: put `.int()` back on every money field in the generated
 * Zod schemas.
 *
 * WHY THIS EXISTS
 * ---------------
 * TypeScript has no integer type, so `type: integer` in the spec becomes
 * `number` in the generated TS — unavoidable, and harmless, because TS is not a
 * runtime gate. The runtime gate is Zod, and orval v7 emits plain
 * `zod.number()` for `type: integer`, with or without `format: int32`
 * (measured, not assumed).
 *
 * That would leave `totalPence: 12.34` passing validation at a boundary, which
 * is R5 — "money is integer pence, no floats, anywhere, ever" (Governance §1.7)
 * — the single most-guarded invariant in this codebase. A float that reaches a
 * VAT calculation is a wrong number published into a client's books.
 *
 * So this runs from orval's afterAllFilesWrite hook and adds `.int()` to every
 * field whose name ends in `Pence`. The naming convention is not incidental: it
 * is enforced on the spec side by check-contract.mjs, which also verifies this
 * script's output, so the two cannot drift apart silently. If orval ever learns
 * to honour `type: integer`, this becomes a no-op and can be deleted — the
 * verification in check-contract.mjs is what makes that safe to notice.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZOD_DIR = resolve(HERE, '../src/generated/zod');

/** `"somethingPence": zod.number()` — not already followed by `.int()`. */
const MONEY_FIELD = /("(?:[A-Za-z0-9_]*)Pence":\s*zod\.number\(\))(?!\.int\(\))/g;

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

let patched = 0;
let filesTouched = 0;

for (const file of walkFiles(ZOD_DIR)) {
  const before = readFileSync(file, 'utf8');
  let count = 0;
  const after = before.replace(MONEY_FIELD, (_, head) => {
    count += 1;
    return `${head}.int()`;
  });
  if (count > 0) {
    writeFileSync(file, after);
    patched += count;
    filesTouched += 1;
  }
}

console.log(`enforce-money-int: added .int() to ${patched} money field(s) across ${filesTouched} file(s)`);
