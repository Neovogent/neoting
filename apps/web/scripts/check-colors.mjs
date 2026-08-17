/**
 * The colour-literal gate — issue #86.
 * Zero rgb()/rgba() literals under src/: colours derive from the @theme
 * tokens in src/index.css (via color-mix for alpha steps), so grep-able
 * literals cannot drift from the palette. This lives here rather than in
 * ESLint because eslint.config.js only sees src ts/tsx — index.css, where
 * most literals used to hide, would be invisible to a lint rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
// Binary assets are skipped by extension, not content-sniffed: a false skip
// of a new text format shows up as a gap in review, a false scan of a PNG
// shows up as noise nobody can act on.
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf)$/i;
const LITERAL = /(?<![\w-])rgba?\(/;

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (!BINARY.test(entry.name)) files.push(p);
  }
})(SRC);

const hits = [];
for (const file of files) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (LITERAL.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}

if (hits.length > 0) {
  console.error('rgb()/rgba() literals are banned under src/ — derive from the @theme tokens in index.css (issue #86):');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-colors: ${files.length} files scanned, zero rgb()/rgba() literals.`);
