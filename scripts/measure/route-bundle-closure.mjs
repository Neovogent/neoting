#!/usr/bin/env node
/**
 * What a route ACTUALLY costs: the transitive static-import closure, in gzip bytes.
 *
 * ## Why this script exists — the four-chunk shorthand is wrong
 *
 * Every bundle figure in `apps/web/CLAUDE.md` before 2 Sep 2026 was taken as
 *
 *     index + query + react + <the view's own chunk>
 *
 * and that shorthand UNDERCOUNTS the client routes by ~40 kB. It is not a
 * rounding error, it is the wrong quantity. A `React.lazy` route chunk is not a
 * leaf: Rollup emits it with its own list of STATIC `import` statements, and the
 * browser must fetch every one of them — transitively — before the route can
 * render. `ClientDetailView` statically imports `ApprovalsView`,
 * `DocumentPreview`, `ChaseComposer`, `LiveProposalCard`, `DataTable`,
 * `ReviewGate`, `Tooltip` and ~20 icon chunks; `BankView` statically imports
 * `ClientDetailView` on top of all of that. None of those four names cover it.
 *
 * The number SoT §14 / D37 actually budgets (< 250,000 B gzipped JS per route,
 * and a route over budget is a REJECT, not a warning) is the closure. So:
 *
 *   closure(route) = { route chunk } ∪ transitive static imports of it
 *   cost(route)    = Σ gzip size of that set, DEDUPLICATED
 *
 * Dynamic imports (`import()` — i.e. anything behind a `lazy()`) are deliberately
 * NOT followed: not fetching them on arrival is the entire point of the lazy
 * boundary, and counting them would make lazy-loading look free of benefit. That
 * exclusion is also what makes this script able to detect the bug class it was
 * written for: when someone imports a small thing (`Modal`, `Field`, `Toggle`)
 * from a big view module, Rollup cannot tree-shake a whole module down to one
 * re-export, so it emits a bare side-effect import of the ENTIRE view chunk. The
 * `lazy()` is silently defeated and the chunk moves from `dynamicImports` into
 * `imports`, where this script will see it and the shorthand never would.
 *
 * ## Where the graph comes from
 *
 * Vite's build manifest (`dist/.vite/manifest.json`, produced by `--manifest`),
 * which is Rollup's own output-chunk metadata: `imports` are the static edges and
 * `dynamicImports` are the lazy ones. That is authoritative. Do not replace it
 * with a regex over the emitted JS — minified output makes `import"./x.js"` and
 * `import("./x.js")` hard to tell apart, and mistaking one for the other is
 * exactly the error this file is here to stop.
 *
 * ## gzip convention
 *
 * The repo convention is `gzip -c | wc -c` on the built chunk. Note that
 * `gzip -c FILE` stores the FILENAME in the gzip header, so it charges each chunk
 * an extra ~18 bytes that depend on the length of a content hash — nonsense for a
 * budget, and ~1 kB of phantom weight across a 50-chunk route. `gzip -c < FILE`
 * (identical to `gzip -nc FILE`) does not. This script reports the piped form as
 * canonical and also prints the filename-header form, so older figures in
 * `CLAUDE.md` remain comparable rather than merely puzzling. Node's `zlib` is NOT
 * used: it disagrees with the `gzip` binary by ~0.3 %.
 *
 * ## Running it
 *
 *   node scripts/measure/route-bundle-closure.mjs                 # build, then measure
 *   node scripts/measure/route-bundle-closure.mjs --dist path/to/dist   # measure an existing build
 *   node scripts/measure/route-bundle-closure.mjs --json out.json       # machine-readable too
 *
 * ⚠ MEASURE PAIRED, IN ONE SESSION. Two builds taken minutes apart on this repo
 * measure other agents' concurrent commits as much as your own; drift of ~1,374 B
 * over forty minutes has been observed. A before/after pair means two builds back
 * to back, from the same working tree, with only the change under test between.
 *
 * ⚠ MEASURE WITH A CLEAN ENVIRONMENT. Sourcing the repo `.env` into the shell
 * before a build sets `NODE_ENV` and Vite quietly emits a development-flavoured
 * bundle ~25 % larger, which reads as a regression that is not there.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../apps/web');

/** SoT §14 / D37. A route over this is a reject, not a warning. */
const BUDGET = 250_000;

function parseArgs(argv) {
  const opts = { dist: null, json: null, build: true, only: [], unions: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dist') opts.dist = resolve(argv[(i += 1)]);
    else if (a === '--json') opts.json = resolve(argv[(i += 1)]);
    else if (a === '--no-build') opts.build = false;
    else if (a === '--only') opts.only = argv[(i += 1)].split(',');
    else if (a === '--union') opts.unions.push(argv[(i += 1)].split('+'));
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: route-bundle-closure.mjs [--dist DIR] [--json FILE] [--no-build]\n' +
          '                               [--only NameA,NameB] [--union NameA+NameB]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/**
 * The route set is DISCOVERED, not hard-coded, so a screen added tomorrow is
 * measured tomorrow without anyone remembering to edit this file.
 *
 * A route is any `lazy(() => import('…'))` that is either registered in `App.tsx`
 * (the hand-rolled router — D37 left no framework to ask) or resolves under
 * `src/views/`, which is where a screen lives. That second clause is not padding:
 * `BankView` and `ClientInbox` are `lazy()` from `ClientDetailView`, not from
 * `App.tsx`, so a route list read from `App.tsx` alone MISSES the heaviest route
 * in the product. Leaf dialogs and pickers under `components/` are excluded by
 * default (they are not arrival points); reach one with `--only Name` if needed.
 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function readRouteNames() {
  const srcRoot = join(WEB, 'src');
  const appFile = join(srcRoot, 'App.tsx');
  const names = [];
  for (const file of walk(srcRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      const resolved = spec.startsWith('.') ? resolve(dirname(file), spec) : spec;
      const isScreen = resolved.includes(`${join(srcRoot, 'views')}/`);
      if (file === appFile || isScreen) names.push(spec.split('/').pop());
    }
  }
  return [...new Set(names)];
}

function gzipBytes(file, { storeName }) {
  // Shell out to the same `gzip` the repo's figures were always taken with.
  // Node's zlib produces a different number and would silently rebase history.
  const out = storeName
    ? execFileSync('/bin/sh', ['-c', `gzip -c "${file}" | wc -c`])
    : execFileSync('/bin/sh', ['-c', `gzip -c < "${file}" | wc -c`]);
  return Number(String(out).trim());
}

/**
 * Closure over STATIC edges only. `dynamicImports` are not followed — see the
 * header. `index.html` appears as a manifest key whose `file` is the entry chunk;
 * it is a real static edge (every route chunk imports the shared entry) and is
 * counted like any other.
 */
function staticClosure(manifest, startKey) {
  const seen = new Set();
  const queue = [startKey];
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    const node = manifest[key];
    if (!node) continue; // an asset/css key with no chunk of its own
    seen.add(key);
    for (const dep of node.imports ?? []) queue.push(dep);
  }
  return seen;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let dist = opts.dist;

  if (!dist) {
    dist = join(WEB, 'dist');
    if (opts.build) {
      process.stderr.write('building (vite build --manifest)…\n');
      // A clean env: NODE_ENV leaking in from a sourced .env produces a
      // development-flavoured bundle ~25 % larger.
      const env = { ...process.env };
      delete env.NODE_ENV;
      execFileSync('npx', ['vite', 'build', '--manifest'], { cwd: WEB, env, stdio: 'inherit' });
    }
  }

  const manifestPath = join(dist, '.vite/manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `no manifest at ${manifestPath} — the build must be run with --manifest ` +
        '(this script does that for you unless you passed --dist).',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // name -> manifest key. A chunk that is shared (because something statically
  // imports it) loses its `src` key and is filed under `_Name-hash.js` instead,
  // so match on the chunk NAME, which survives both shapes.
  const byName = new Map();
  for (const [key, node] of Object.entries(manifest)) {
    if (node.file?.endsWith('.js') && node.name) byName.set(node.name, key);
  }

  const sizes = new Map();
  const sizeOf = (file, storeName) => {
    const cacheKey = `${storeName ? 'n' : 'p'}:${file}`;
    if (!sizes.has(cacheKey)) sizes.set(cacheKey, gzipBytes(join(dist, file), { storeName }));
    return sizes.get(cacheKey);
  };

  let routeNames = readRouteNames();
  if (opts.only.length) routeNames = opts.only;

  /** Sum the deduplicated closure of one or more start chunks. */
  const measure = (label, names) => {
    const keys = names.map((n) => byName.get(n));
    if (keys.some((k) => !k)) return { route: label, missing: true };
    const closure = new Set();
    for (const k of keys) for (const c of staticClosure(manifest, k)) closure.add(c);
    const uniqueFiles = [...new Set([...closure].map((k) => manifest[k].file).filter((f) => f.endsWith('.js')))];
    let piped = 0;
    let named = 0;
    const parts = [];
    for (const f of uniqueFiles) {
      const p = sizeOf(f, false);
      piped += p;
      named += sizeOf(f, true);
      parts.push({ file: f, gzip: p });
    }
    parts.sort((a, b) => b.gzip - a.gzip);
    return { route: label, chunks: uniqueFiles.length, gzip: piped, gzipWithFilenameHeader: named, parts };
  };

  const rows = routeNames.map((name) => measure(name, [name]));
  rows.sort((a, b) => (b.gzip ?? -1) - (a.gzip ?? -1));

  /**
   * `--union A+B` — what a SESSION costs, not what an arrival costs.
   *
   * A route with lazy sub-tabs is under-described by its arrival closure alone:
   * `/clients/:id` loads `ClientDetailView`, and the moment the user clicks the
   * Bank tab the browser additionally fetches `BankView`'s whole closure. The
   * budget question for that user is the UNION of the two, deduplicated — the
   * shared floor is paid once, everything else adds. Report both: the arrival
   * number is what the budget formally governs, the union is what the user
   * actually ends up holding, and a route can pass the first and fail the second.
   */
  const unionRows = opts.unions.map((names) => measure(names.join(' + '), names));

  const w = (s, n) => String(s).padEnd(n);
  const r = (s, n) => String(s).padStart(n);
  const lines = [];
  lines.push(`budget ${BUDGET.toLocaleString('en-GB')} B gzipped JS per route (SoT §14 / D37 — over is a reject)`);
  lines.push(`dist   ${dist}`);
  lines.push('');
  const header = `${w('route', 34)} ${r('chunks', 6)} ${r('gzip B', 10)} ${r('vs budget', 11)}  ${r('(w/ fname hdr)', 14)}`;
  const emit = (row) => {
    if (row.missing) {
      lines.push(`${w(row.route, 34)} ${r('—', 6)} ${r('not built', 10)} ${r('', 11)}`);
      return;
    }
    const delta = BUDGET - row.gzip;
    const verdict = delta < 0 ? `${r(`${(-delta).toLocaleString('en-GB')} OVER`, 11)}` : r(delta.toLocaleString('en-GB'), 11);
    lines.push(
      `${w(row.route, 34)} ${r(row.chunks, 6)} ${r(row.gzip.toLocaleString('en-GB'), 10)} ${verdict}  ${r(row.gzipWithFilenameHeader.toLocaleString('en-GB'), 14)}`,
    );
  };
  lines.push(header);
  lines.push('-'.repeat(82));
  for (const row of rows) emit(row);
  if (unionRows.length) {
    lines.push('');
    lines.push('cumulative — a route PLUS a lazy sub-tab the user then opens (deduplicated):');
    lines.push('-'.repeat(82));
    for (const row of unionRows) emit(row);
  }
  const over = [...rows, ...unionRows].filter((x) => !x.missing && x.gzip > BUDGET);
  lines.push('');
  lines.push(over.length ? `OVER BUDGET: ${over.map((x) => x.route).join(', ')}` : 'All routes under budget.');
  const text = lines.join('\n');
  console.log(text);

  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify({ budget: BUDGET, dist, rows, unionRows }, null, 2));
    process.stderr.write(`wrote ${opts.json}\n`);
  }
  return over.length ? 1 : 0;
}

process.exitCode = main();
