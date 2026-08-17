/**
 * The gate on the boundary gate — same reasoning as the web app's
 * `no-literal-string-in-jsx.test.js`: a custom rule that silently stops
 * matching turns a blocking check into a green tick, so both halves are
 * asserted. Crossing imports still fail; intra-module, common/, seam and
 * composition-root imports still pass.
 *
 * The positive cases are the real shapes this rule was written against — the
 * `documents → ingestion-routing/storage` deep imports it made illegal — and
 * the negative cases are the imports the codebase actually relies on staying
 * legal.
 */
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import neoting from './no-cross-module-internals.js';

const linter = new Linter();

const lint = (code, filename) =>
  linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
        },
        plugins: { neoting },
        rules: { 'neoting/no-cross-module-internals': 'error' },
      },
    ],
    { filename },
  );

const messagesFor = (code, filename) => {
  const found = lint(code, filename);
  // A parse error would read as "no violations" and pass every negative case.
  const fatal = found.filter((f) => f.fatal);
  expect(fatal, JSON.stringify(fatal)).toHaveLength(0);
  return found;
};

// Relative to the Linter's cwd — an absolute path outside it gets no config at
// all ("No matching configuration found"), which would pass every negative
// case here for the wrong reason. One filename keeps Windows separators
// because that is what a real `context.filename` carries on this machine, and
// the rule's first move is to normalise them.
const IN_DOCUMENTS = 'apps\\api\\src\\modules\\documents\\documents.module.ts';
const IN_INGESTION = 'apps/api/src/modules/ingestion-routing/web-upload/web-upload.service.ts';
const IN_WORKER = 'apps/api/src/worker/main.ts';

describe('neoting/no-cross-module-internals — crossing imports fail', () => {
  it.each([
    [
      'a deep static import (the shape this rule was written against)',
      "import { selectDocumentStore } from '../ingestion-routing/storage/select-document-store.js';",
    ],
    [
      'a deep type-only import — type coupling is still coupling',
      "import type { DocumentStore } from '../ingestion-routing/storage/document-store.js';",
    ],
    [
      'a deep re-export',
      "export { selectDocumentStore } from '../ingestion-routing/storage/select-document-store.js';",
    ],
    ['a deep export-all', "export * from '../ingestion-routing/storage/document-store.js';"],
    [
      'a deep dynamic import',
      "const m = import('../ingestion-routing/queue/duplicate-detector.js');",
    ],
    [
      'a dotted path that climbs out and back in',
      "import { x } from '../../modules/ingestion-routing/storage/document-store.js';",
    ],
  ])('reports %s', (_what, code) => {
    const found = messagesFor(code, IN_DOCUMENTS);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].message).toContain('ingestion-routing');
  });
});

describe('neoting/no-cross-module-internals — everything else passes', () => {
  it.each([
    ['the seam itself', "import { selectDocumentStore } from '../ingestion-routing/index.js';", IN_DOCUMENTS],
    ['the bare module directory', "import { selectDocumentStore } from '../ingestion-routing';", IN_DOCUMENTS],
    ["the module's own files", "import { DocumentsService } from './documents.service.js';", IN_DOCUMENTS],
    [
      'an intra-module import that looks like the crossing shape',
      "import { DOCUMENT_STORE } from '../storage/document-store.js';",
      IN_INGESTION,
    ],
    ['shared infrastructure', "import { getPrismaClient } from '../../common/db/prisma.js';", IN_DOCUMENTS],
    ['config', "import type { Env } from '../../config/env.js';", IN_DOCUMENTS],
    ['a package specifier', "import { Module } from '@nestjs/common';", IN_DOCUMENTS],
    [
      'a composition root wiring internals (its whole job)',
      "import { documentSink } from '../modules/ingestion-routing/queue/document-sink.js';",
      IN_WORKER,
    ],
  ])('ignores %s', (_what, code, filename) => {
    expect(messagesFor(code, filename)).toHaveLength(0);
  });
});
