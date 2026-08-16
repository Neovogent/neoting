/**
 * Assert that the built package can actually be imported and used by Node.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ------------------------------------
 * This package spent its first week consumable only as `.ts` source: the
 * exports map pointed at src/, which Vite could bundle and `import type` could
 * erase, but which Node cannot execute. Nothing caught it, because nothing
 * imported a VALUE from here — `apps/api` used types alone, and types vanish at
 * emit. The bug was invisible until the first controller needed a Zod schema at
 * runtime, at which point it would have been a green build that crashed on
 * first request.
 *
 * Everything about that failure is easy to reintroduce by accident: an exports
 * map edited back to src/, a `build` script that stops running tsc, an orval
 * upgrade that reverts the specifier rewrite. Each one typechecks. Each one
 * passes lint. Each one ships.
 *
 * So the guarantee is asserted the only way it can be — by doing the thing:
 * import the built artefact the way Node will, and use it.
 *
 * Deliberately runs in THIS process rather than spawning one: `node --input-type
 * =module` resolves bare specifiers against its own cwd, which on a workspace
 * with hoisting is not the same resolution a consumer gets. Importing the built
 * entry by its real path exercises the emitted specifiers, which is the part
 * that actually broke.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../dist');

const failures = [];
const check = (name, condition, detail = '') => {
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

if (!existsSync(DIST)) {
  // A fresh clone can run the suite before its first build. Say so rather than
  // passing silently, which would read as "the guarantee holds".
  console.log('verify-runtime-import: SKIPPED — no dist/. Run `pnpm --filter @neoting/contracts build` first.');
  process.exit(0);
}

const zodEntry = resolve(DIST, 'generated/zod/index.js');
const modelEntry = resolve(DIST, 'generated/model/index.js');

check('dist/generated/zod/index.js exists', existsSync(zodEntry));
check('dist/generated/model/index.js exists', existsSync(modelEntry));

if (failures.length === 0) {
  // The import itself is the assertion: an extensionless specifier anywhere in
  // the emitted graph throws ERR_MODULE_NOT_FOUND right here.
  const zod = await import(pathToFileURL(zodEntry).href);
  await import(pathToFileURL(modelEntry).href);

  check('the zod subpath exports schemas', Object.keys(zod).length > 0, 'the module loaded but is empty');

  const body = zod.createDocumentUploadBody;
  check('createDocumentUploadBody is exported', body !== undefined);

  if (body) {
    const valid = body.safeParse({
      businessId: 'biz_probe',
      channel: 'WEB_UPLOAD',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
    });
    check('a valid upload body parses', valid.success, valid.success ? '' : JSON.stringify(valid.error?.issues?.[0]));

    const missing = body.safeParse({ businessId: 'biz_probe' });
    check('an invalid upload body is rejected', !missing.success, 'the schema accepted a body missing required fields');
  }
}

if (failures.length) {
  console.error('verify-runtime-import: FAILED\n' + failures.map((f) => `  ✗ ${f}`).join('\n'));
  console.error(
    '\nThe built package is not importable by Node. See packages/contracts/tsconfig.build.json\n' +
      'and scripts/add-js-extensions.mjs — this is the failure apps/api/tsconfig.build.json predicted.',
  );
  process.exit(1);
}

console.log('verify-runtime-import: ok — dist/ imports under Node and its schemas parse.');
