/**
 * The message-catalogue gate — Governance §12.6, which requires missing keys to
 * FAIL the build rather than warn.
 *
 * Runs against `lang/en-GB.json`, the artefact `pnpm i18n:extract` produces from
 * source. Four assertions, each for a failure this codebase can actually
 * produce:
 *
 * 1. **A message with no `defaultMessage`.** Renders as its own id — the user
 *    sees `inboxes.header.heading`. Extraction cannot catch it; only this can.
 *
 * 2. **A key off the `domain.component.purpose` convention.** §12.6 fixes the
 *    shape. It is not decoration: a flat namespace across ~800 messages
 *    collides, and it collides silently, because the second definition simply
 *    wins.
 *
 * 3. **Two different messages under one id.** The real risk of extracting a
 *    large codebase in parallel: two files pick `clients.table.name` for
 *    different strings and one quietly replaces the other.
 *
 *    This used to be delegated to `formatjs extract` on the belief that it
 *    "errors on conflicting ones". It does not. Verified against
 *    @formatjs/cli 6.7.2: two files declaring one id with different
 *    defaultMessages print `Duplicate message id: "x"` to stdout, exit **0**,
 *    and emit a catalogue containing only the last definition. The earlier
 *    string is gone by the time this file reads the catalogue, so no
 *    catalogue-level assertion can recover it. That is why this script now
 *    runs the extraction itself and treats that warning as fatal — a warning
 *    nobody reads, in a step whose exit code was the only thing gating CI, is
 *    indistinguishable from no check at all.
 *
 * 4. **A message that still reads as a placeholder.** `TODO`, `FIXME`, or an
 *    empty default — the shapes a half-finished conversion leaves behind.
 *
 * 5. **A message that is not valid ICU.** An unclosed plural arm extracts
 *    silently — `formatjs extract` does not parse defaultMessage — lands in the
 *    catalogue verbatim, and fails at runtime in front of a user. Parsed here
 *    with react-intl's own parser so the gate and the renderer agree.
 *
 * Deliberately NOT asserted: that every string in the app has been extracted.
 * That is `eslint-plugin-formatjs`'s `no-literal-string-in-jsx` rule, which
 * works on source and can point at the line. This file works on the catalogue,
 * which is the wrong altitude for that question.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = resolve(HERE, '../lang/en-GB.json');
const APP = resolve(HERE, '..');

const failures = [];
const fail = (msg) => failures.push(msg);

// ── Extraction, run here so its output is inspectable ───────────────────────
//
// `i18n:check` used to be `i18n:extract && check-i18n`, which only ever tested
// the extractor's exit code. That code is 0 for a conflicting duplicate id, so
// the `&&` sailed through and the collision reached the catalogue as a silent
// overwrite. Running it here keeps the command definition in package.json — one
// source of truth for the glob and flags — while making its output a gate.
//
// Two details this depends on, both verified against @formatjs/cli 6.7.2:
//   · the duplicate warning goes to STDERR, not stdout, so both streams are
//     read and concatenated;
//   · it is a warning, so the output is read regardless of exit status.
//
// A single command string rather than an args array: with shell:true Node
// deprecates the array form (DEP0190). shell:true because `pnpm` is a shim on
// Windows.
const extract = spawnSync('pnpm run i18n:extract', {
  cwd: APP,
  encoding: 'utf8',
  shell: true,
});

const extractOutput = `${extract.stdout ?? ''}${extract.stderr ?? ''}`;

if (extract.status !== 0) {
  console.error(`check-i18n: FAILED — extraction did not complete.\n${extractOutput}`);
  process.exit(1);
}

const duplicates = [...extractOutput.matchAll(/Duplicate message id:\s*"?([^"\n]+)"?/g)].map((m) =>
  m[1].trim(),
);
for (const id of new Set(duplicates)) {
  fail(
    `"${id}" is declared in more than one place with a different message — ` +
      'the catalogue kept only the last one and the other string is silently gone',
  );
}

if (!existsSync(CATALOGUE)) {
  console.error(
    `check-i18n: FAILED — ${CATALOGUE} does not exist.\n` +
      'Run `pnpm --filter @neoting/web i18n:extract` first. The catalogue is generated from source,\n' +
      'so a missing one means extraction never ran, not that there are no messages.',
  );
  process.exit(1);
}

const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
const ids = Object.keys(catalogue);

// `domain.component.purpose` — three or more lowerCamel segments. Four is
// allowed: a nested surface (`clients.detail.costs.emptyState`) is still the
// convention, not an exception to it.
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2,}$/;

const PLACEHOLDER = /\b(TODO|FIXME|XXX|lorem ipsum)\b/i;

// react-intl parses every message with @formatjs/icu-messageformat-parser, so
// reaching it through react-intl's own resolution asks the renderer's parser
// rather than adding a direct dependency for a build script (CLAUDE.md routes
// dependency additions past a human). If a future hoisting change hides it, say
// so out loud and fall back to brace balance — a quieter check, never a silent
// one.
const require = createRequire(import.meta.url);
let parseIcu = null;
try {
  const parserPath = require.resolve('@formatjs/icu-messageformat-parser', {
    paths: [require.resolve('react-intl', { paths: [APP] })],
  });
  parseIcu = require(parserPath).parse;
} catch {
  console.warn(
    'check-i18n: WARNING — @formatjs/icu-messageformat-parser is not resolvable; ' +
      'ICU validation degraded to a brace-balance check. Malformed plurals may pass.',
  );
}

const bracesBalanced = (message) => {
  let depth = 0;
  for (const ch of message) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
};

for (const id of ids) {
  const entry = catalogue[id];
  const message = typeof entry === 'string' ? entry : entry?.defaultMessage;

  if (!message || !String(message).trim()) {
    fail(`"${id}" has no defaultMessage — it would render as its own id`);
    continue;
  }
  if (!KEY_SHAPE.test(id)) {
    fail(`"${id}" is off the domain.component.purpose convention (§12.6)`);
  }
  if (PLACEHOLDER.test(String(message))) {
    fail(`"${id}" still reads as a placeholder: ${JSON.stringify(message)}`);
  }

  const text = String(message);
  if (parseIcu) {
    try {
      parseIcu(text);
    } catch (err) {
      fail(`"${id}" is not valid ICU — ${String(err.message).split('\n')[0]}: ${JSON.stringify(text)}`);
    }
  } else if (!bracesBalanced(text)) {
    fail(`"${id}" has unbalanced braces, so it is not valid ICU: ${JSON.stringify(text)}`);
  }
}

if (failures.length) {
  console.error(`check-i18n: FAILED — ${failures.length} problem(s)\n` + failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}

console.log(
  `check-i18n: ok — ${ids.length} message(s), all with defaults, all on the key convention, ` +
    `no conflicting duplicate ids, all valid ICU${parseIcu ? '' : ' (brace check only)'}.`,
);
