/**
 * Post-generation step: mark every generated Zod schema as side-effect-free, so
 * a bundler may drop the ones a route does not use.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/generated/zod/index.ts` is a barrel of `export *`, and `apps/web` has
 * twenty-odd modules that import from `@neoting/contracts/zod` — several of
 * them floor-resident. Rollup pulls the barrel in, and then cannot remove a
 * single unused schema, because every one of them is a top-level CALL:
 *
 *     export const listRulesResponse = zod.object({ … }).strict()
 *
 * A call expression is potentially side-effectful, so tree-shaking is not
 * allowed to drop it. The consequence is the rule `apps/web/CLAUDE.md` states
 * as "the reachability rule": adding operations to the contract costs floor
 * bytes on EVERY route in the product, whether or not any route uses them.
 * Review package H measured it — six operations and ten schemas, in a tag
 * directory nothing on the floor imports, cost **+856 B of floor** and put the
 * worst route 412 B over the 250 kB budget.
 *
 * `/*#__PURE__*\/` is the standard annotation that tells Rollup, esbuild and
 * Terser the call may be removed if its result is unused. It is true here:
 * building a Zod schema allocates an object and does nothing else.
 *
 * ⚠ **Only the leading `zod.` call is annotated, and that is not the whole
 * theoretical win.** A `zod.object({…}).strict()` declaration is an outer
 * `.strict()` call over an annotated inner one, and Rollup treats the outer as
 * impure, so `.strict()` schemas — the request bodies, mostly — are still
 * pinned. The response schemas are not chained and they are the bulk, which is
 * why this measures the way it does. Annotating chain links too is the obvious
 * next reclaim if the floor ever needs it again; it was left out because the
 * measured 3.6 kB was already more than the change that prompted it spent, and
 * a regex that has to understand a call chain is a different class of script.
 *
 * MEASURED, on review package H's branch, `apps/web` built with `--manifest`
 * and walked with the closure script: floor 208,060 → 204,255 B gzip, worst
 * route (InboxesView) 249,540 → 246,019 B. The package's own contract
 * additions cost +856 B of that — six operations in a tag directory nothing on
 * the floor imports, which alone had put InboxesView 412 B OVER budget — so the
 * net to the product is a **~3.8 kB reclaim on every route**.
 *
 * Sibling of `strip-zod-describe.mjs`, which reclaimed ~10 kB of floor from
 * orval copying the spec's prose into the runtime — same seam, same reason.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZOD_DIR = resolve(HERE, '../src/generated/zod');

/**
 * A top-level `export const NAME = ` whose initializer starts a `zod.` chain.
 * Anchored to the line start so nothing nested inside an object literal is
 * touched — those are already inside an annotated outer call.
 */
const SCHEMA_DECL = /^(export const [A-Za-z0-9_]+ = )(zod\.)/gm;

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

let marked = 0;
let filesTouched = 0;

for (const file of walkFiles(ZOD_DIR)) {
  const before = readFileSync(file, 'utf8');
  if (before.includes('/*#__PURE__*/')) continue;
  let count = 0;
  const after = before.replace(SCHEMA_DECL, (_, head, tail) => {
    count += 1;
    return `${head}/*#__PURE__*/ ${tail}`;
  });
  if (count > 0) {
    writeFileSync(file, after);
    marked += count;
    filesTouched += 1;
  }
}

console.log(`mark-zod-pure: annotated ${marked} schema(s) across ${filesTouched} file(s)`);
