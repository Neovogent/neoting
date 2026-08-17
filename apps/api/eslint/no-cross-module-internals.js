/**
 * The module boundary, as a lint rule (CI family `module-boundary`, §14.3).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `apps/api/CLAUDE.md` says a module exposes its public providers only, and
 * `modules/ingestion-routing/CLAUDE.md` goes further: "Import rules are
 * lint-enforced, because this boundary is also the parallel-agent lane map."
 * Until this rule, that sentence was a promise, not a fact. The boundary is
 * what lets two agents work two modules in parallel without merging each
 * other's refactors: if module A types against a file deep inside module B,
 * renaming that file inside B is no longer B's own business.
 *
 * No stock rule can say this. `no-restricted-imports` matches the *specifier
 * string*, and the specifiers here are relative — from `modules/documents/x.ts`
 * the crossing import reads `../ingestion-routing/…`, but from
 * `modules/ingestion-routing/web-upload/x.ts` the same shape (`../storage/…`)
 * stays inside the module. Whether an import crosses depends on where the
 * importing file sits, which the pattern cannot see. So the rule is written
 * here, ~40 lines, in the same spot the web app keeps its own custom gate
 * (`apps/web/eslint/no-literal-string-in-jsx.js`).
 *
 * ── What it enforces, exactly ───────────────────────────────────────────────
 *
 * For a file under `src/modules/<A>/`, any import (static, re-export, or
 * dynamic with a literal specifier) that resolves under `src/modules/<B>/`
 * with B ≠ A must land on B's public seam — `modules/<B>/index.ts` — and
 * nowhere deeper. `import type` counts: a type-only import is still a build
 * dependency on another module's internal file layout, and the fix costs one
 * re-export line in the seam.
 *
 * What it deliberately does not police:
 *   · files outside `src/modules/` — `app.module.ts` and `worker/` are the
 *     composition roots; wiring internals together is their whole job;
 *   · imports into `common/` and `config/` — shared infrastructure, not a
 *     module; the tenancy gate on those lives in `no-restricted-imports`;
 *   · package specifiers — a bare specifier cannot reach into `src/modules/`;
 *   · `require()` — this app is ESM ("type": "module"); a require of a .ts
 *     module would fail long before lint mattered.
 *
 * A specifier this rule cannot resolve (non-literal dynamic import) is not
 * reported — but it is also not how anyone imports a module in this codebase,
 * and the typecheck would demand a literal path to type it anyway.
 */
import path from 'node:path';

const MODULES_SEGMENT = '/src/modules/';

/** `{ module, remainder }` for a path under `src/modules/`, else null. */
function locate(posixPath) {
  const at = posixPath.indexOf(MODULES_SEGMENT);
  if (at === -1) return null;
  const rest = posixPath.slice(at + MODULES_SEGMENT.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return { module: rest, remainder: '' };
  return { module: rest.slice(0, slash), remainder: rest.slice(slash + 1).replace(/\/+$/, '') };
}

/** The seam, or the bare module directory (Bundler resolution finds index.ts). */
const isSeam = (remainder) => remainder === '' || remainder === 'index.js' || remainder === 'index.ts';

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Cross-module imports must go through the target module\'s public seam ' +
        '(modules/<name>/index.ts), never into its internals.',
    },
    schema: [],
    messages: {
      internals:
        "'{{specifier}}' reaches into modules/{{target}}'s internals. A module exposes " +
        'its public seam only (apps/api/CLAUDE.md): import from ' +
        "'modules/{{target}}/index.js' and re-export the name there if it belongs to " +
        "the module's public surface — or go through providers / domain events if it does not.",
    },
  },
  create(context) {
    const file = context.filename.replace(/\\/g, '/');
    const own = locate(file);
    if (!own) return {}; // Not module code: composition roots wire internals freely.

    const check = (sourceNode) => {
      if (!sourceNode || typeof sourceNode.value !== 'string') return;
      const specifier = sourceNode.value;
      if (!specifier.startsWith('.')) return; // Bare specifiers cannot reach src/modules.
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const target = locate(resolved);
      if (!target || target.module === own.module || isSeam(target.remainder)) return;
      context.report({
        node: sourceNode,
        messageId: 'internals',
        data: { specifier, target: target.module },
      });
    };

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};

export default { rules: { 'no-cross-module-internals': rule } };
