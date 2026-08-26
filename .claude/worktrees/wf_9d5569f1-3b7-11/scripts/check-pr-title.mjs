#!/usr/bin/env node
/**
 * Validate a PR title against commitlint BEFORE the PR exists.
 *
 *   pnpm pr:title "feat(api): add the thing"
 *
 * WHY THIS FILE EXISTS
 *
 * The squash commit takes the PR title (Guideline G4), so the title — not the
 * branch's commit messages — is the thing that must be a valid conventional
 * commit. Commit messages are already checked locally by the husky `commit-msg`
 * hook; the title was checked only by CI, which meant the feedback loop for a
 * bad title was: open PR, wait ~90s for the pipeline, read a failure buried in a
 * log, rename, wait again.
 *
 * That loop cost four separate round-trips in one day — `NT-SRV-001`,
 * `IngestQueue`/`DLQ`, `scopedDb`, `S3/MinIO`. Every one was the same rule
 * (`subject-case`, lower-case) and every one was an identifier that is correctly
 * capitalised everywhere else in the codebase, which is exactly why the mistake
 * is so easy to repeat. Four identical failures is a missing tool, not four
 * lapses of attention.
 *
 * On failure this prints a title that WOULD pass, so the fix is a copy rather
 * than a puzzle.
 */
import { execFileSync } from 'node:child_process';

const title = process.argv.slice(2).join(' ').trim();

if (title === '') {
  console.error('usage: pnpm pr:title "<the PR title>"');
  process.exit(2);
}

let failed = false;
try {
  execFileSync('npx', ['commitlint'], { input: title, stdio: ['pipe', 'inherit', 'inherit'], shell: true });
} catch {
  failed = true;
}

if (!failed) {
  console.log(`✔ "${title}" is a valid conventional commit — safe to use as a PR title.`);
  process.exit(0);
}

// Build a suggestion. The subject is everything after the first ": ", and the
// rule that keeps biting is that it must be entirely lower-case — identifiers
// included. They belong in the PR body, where their real casing survives.
const match = /^([a-z]+(?:\([^)]+\))?!?): (.+)$/.exec(title);
if (match) {
  const [, prefix, subject] = match;
  const suggestion = `${prefix}: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`.replace(
    /\b[A-Z][A-Za-z0-9/_-]*/g,
    (identifier) => identifier.toLowerCase(),
  );
  console.error('\n─────────────────────────────────────────────');
  console.error('A title that passes:\n');
  console.error(`  ${suggestion}\n`);
  console.error('Identifiers, error codes and product names keep their real casing');
  console.error('in the PR BODY. The title is prose, and prose is lower-case.');
  console.error('─────────────────────────────────────────────');
}

process.exit(1);
