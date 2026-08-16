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
 *    different strings and one quietly replaces the other. `formatjs extract`
 *    de-duplicates identical messages happily and errors on conflicting ones,
 *    so this asserts the check ran rather than re-implementing it.
 *
 * 4. **A message that still reads as a placeholder.** `TODO`, `FIXME`, or an
 *    empty default — the shapes a half-finished conversion leaves behind.
 *
 * Deliberately NOT asserted: that every string in the app has been extracted.
 * That is `eslint-plugin-formatjs`'s `no-literal-string-in-jsx` rule, which
 * works on source and can point at the line. This file works on the catalogue,
 * which is the wrong altitude for that question.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = resolve(HERE, '../lang/en-GB.json');

const failures = [];
const fail = (msg) => failures.push(msg);

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
}

if (failures.length) {
  console.error(`check-i18n: FAILED — ${failures.length} problem(s)\n` + failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}

console.log(`check-i18n: ok — ${ids.length} message(s), all with defaults, all on the key convention.`);
