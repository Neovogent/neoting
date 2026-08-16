/**
 * Post-generation step: give every relative import in the generated tree an
 * explicit `.js` extension.
 *
 * WHY THIS EXISTS
 * ---------------
 * orval emits extensionless relative specifiers — `export * from
 * './documents/documents'`. Under `moduleResolution: "Bundler"` that
 * typechecks fine, and for a long time nothing more was needed, because
 * `apps/api` imported only TYPES from this package and types are erased at
 * emit. `apps/api/tsconfig.build.json` says so in as many words, and predicts
 * this exact moment:
 *
 *     "The day a VALUE is imported from contracts, this build breaks at
 *      runtime with ERR_UNKNOWN_FILE_EXTENSION, not at compile time. At that
 *      point the answer is to give contracts a real build output and point its
 *      exports map at the JS — not to reach for a bundler."
 *
 * That day is here: the ingestion and documents controllers parse their
 * boundaries with the generated Zod schemas, which is a RUNTIME import, and
 * "Zod at every boundary" is not negotiable (Governance §1.7).
 *
 * A real build means `tsc` emitting ESM that Node can run, and Node ESM does
 * not do extension resolution. `tsc` copies specifiers through verbatim, so an
 * extensionless import in the source is an unresolvable import in `dist/`.
 *
 * WHY REWRITE THE SOURCE RATHER THAN THE OUTPUT
 * ---------------------------------------------
 * Rewriting `dist/` would need the same pass over `.js` AND `.d.ts`, and would
 * leave the source in a state that only works because something fixes it
 * later. Writing `.js` specifiers into the `.ts` source is the standard
 * TypeScript ESM idiom — TS resolves a `./x.js` specifier to `./x.ts` at
 * typecheck time — so source and output are correct by the same rule, and
 * `moduleResolution: "Bundler"` keeps working unchanged for `apps/web`.
 *
 * The hand-written `src/index.ts` already does this (`'./http-client.js'`).
 * This makes the generated tree agree with it.
 *
 * Like enforce-money-int.mjs, this is verified by check-contract.mjs rather
 * than trusted, so the step cannot be silently skipped. If orval ever learns to
 * emit extensions, this becomes a no-op and can be deleted — the verification
 * is what makes that safe to notice.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = resolve(HERE, '../src/generated');

/**
 * `from './x'` / `from '../x/y'` in an import or export, where the specifier
 * has no extension yet.
 *
 * The negative lookahead on a trailing `.js` is what makes this idempotent —
 * `pnpm generate` runs it on every build, and a second pass must not produce
 * `./x.js.js`.
 */
const RELATIVE_SPECIFIER = /(\bfrom\s+['"])(\.[^'"]*?)(['"])/g;

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

for (const file of walkFiles(GENERATED)) {
  const before = readFileSync(file, 'utf8');
  let count = 0;
  const after = before.replace(RELATIVE_SPECIFIER, (whole, head, spec, tail) => {
    // Already carries an extension — leave it exactly as it is.
    if (/\.(js|json|css)$/.test(spec)) return whole;
    count += 1;
    // Resolved against the filesystem, not guessed from the string. orval emits
    // both forms: './documents/documents' is a FILE, '../model' is a DIRECTORY
    // whose index is wanted. Node ESM does directory resolution for neither, and
    // a rule based on trailing slashes gets '../model' wrong — it has none.
    const onDisk = resolve(dirname(file), spec);
    const isDirectory = existsSync(onDisk) && statSync(onDisk).isDirectory();
    const target = isDirectory ? `${spec}/index.js` : `${spec}.js`;
    return `${head}${target}${tail}`;
  });
  if (count > 0) {
    writeFileSync(file, after);
    patched += count;
    filesTouched += 1;
  }
}

console.log(`add-js-extensions: rewrote ${patched} relative specifier(s) across ${filesTouched} file(s)`);
