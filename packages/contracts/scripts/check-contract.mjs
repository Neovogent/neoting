/**
 * Contract checker — runs inside `pnpm lint` for this package.
 *
 * The OpenAPI spec is LAW (G7/D15), which means the invariants it encodes have
 * to be enforced by something other than a reviewer's attention. Everything
 * asserted here is a rule from the source-of-truth pair, and every one of them
 * has a cheap failure now and an expensive failure later:
 *
 *   - enum drift against prisma/schema.prisma        -> a frontend bug in week 6
 *   - a float in a money field                       -> R5, Governance §1.7
 *   - a mutation with no Idempotency-Key             -> a double-posted bill
 *   - offset pagination                              -> Governance §3
 *   - a second `x-nt-side-effect: execute` operation -> a side-effect endpoint
 *     outside the Review → Approve contract, which is the architectural test
 *     Governance §10.6 requires
 *
 * Deliberately dependency-light: js-yaml and nothing else. This runs before the
 * codegen toolchain does, so it cannot depend on it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolvePath(HERE, '../openapi.yaml');
const PRISMA_PATH = resolvePath(HERE, '../../../prisma/schema.prisma');

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'];
const SIDE_EFFECT_CLASSES = new Set(['none', 'ingest', 'proposal', 'execute']);

/** Enums that must match prisma verbatim. The schema wins; the spec is the bug. */
const MIRRORED_ENUMS = [
  'DocumentChannel',
  'Inbox',
  'DocumentState',
  'DocumentType',
  'ProposalState',
  'WorkspaceRole',
  // METH Stage 2 (issue #120) — the chase/portal/publish/bank read surfaces.
  // ProposalKind is deliberately NOT here: `action_proposals.kind` is TEXT in
  // the schema, so the contract enum is the only registry and there is nothing
  // in prisma for it to drift from.
  'ChaseDetectionEngine',
  'ChaseState',
  'MatchState',
  'MatchKind',
  'PublishMode',
  'PublishState',
  'RuleTier',
  // ID LAW batch (docs/launch/SHAKIB.md S0). IntegrationKind is the reason this
  // list matters rather than a nicety: its contents decide whether a document
  // can reach Published at all, and it was wrong -- {XERO, QUICKBOOKS, SAGE,
  // FREEAGENT} under a release that has no ledger adapter (D42). Now that VT and
  // MANUAL exist, the drift check is what stops the enum being quietly wrong
  // again for the six weeks before someone tries to publish.
  'IntegrationKind',
  'ExportTarget',
  'SubscriptionStatus',
];

const failures = [];
const fail = (msg) => failures.push(msg);

const spec = yaml.load(readFileSync(SPEC_PATH, 'utf8'));
const prismaSource = readFileSync(PRISMA_PATH, 'utf8');

// --- walk helpers -----------------------------------------------------------

function walk(node, path, visit) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`, visit));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value, path);
      walk(value, `${path}.${key}`, visit);
    }
  }
}

function resolveRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce((node, seg) => (node == null ? node : node[seg.replace(/~1/g, '/').replace(/~0/g, '~')]), spec);
}

// --- 1. every $ref resolves -------------------------------------------------

let refCount = 0;
walk(spec, '', (key, value, path) => {
  if (key === '$ref' && typeof value === 'string') {
    refCount += 1;
    if (resolveRef(value) === undefined) fail(`unresolved $ref "${value}" at ${path}`);
  }
});

// discriminator mappings are refs too, but live as plain strings
for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
  for (const [kind, ref] of Object.entries(schema.discriminator?.mapping ?? {})) {
    if (resolveRef(ref) === undefined) fail(`unresolved discriminator mapping ${name}.${kind} -> ${ref}`);
  }
}

// --- 2. enums mirror prisma verbatim ---------------------------------------

function prismaEnumValues(name) {
  const match = prismaSource.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!match) return null;
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
}

for (const name of MIRRORED_ENUMS) {
  const fromPrisma = prismaEnumValues(name);
  const fromSpec = spec.components?.schemas?.[name]?.enum;
  if (!fromPrisma) {
    fail(`enum ${name} is declared in the spec but not in prisma/schema.prisma`);
  } else if (!fromSpec) {
    fail(`enum ${name} exists in prisma but is missing from the spec`);
  } else if (JSON.stringify(fromPrisma) !== JSON.stringify(fromSpec)) {
    fail(`enum ${name} has drifted from prisma:\n      prisma: ${fromPrisma.join(', ')}\n      spec:   ${fromSpec.join(', ')}`);
  }
}

// --- 3. money is integer pence, always (R5, Governance §1.7) ---------------

walk(spec, '', (key, value, path) => {
  if (!/Pence$/.test(key) || !value || typeof value !== 'object') return;
  const types = [].concat(value.type ?? []);
  if (types.includes('number')) fail(`R5 — ${path}.${key} is a float. Money is integer pence, always.`);
  if (!types.includes('integer') && !value.$ref && !value.oneOf) {
    fail(`${path}.${key} is named as money but is not an integer`);
  }
  if (value['x-nt-money'] !== true) fail(`${path}.${key} is money but carries no x-nt-money marker`);
});

// --- 4. operations declare their side-effect class -------------------------

const executeOperations = [];

for (const [pathName, pathItem] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.includes(method)) continue;
    const label = `${method.toUpperCase()} ${pathName}`;

    if (!operation.operationId) fail(`${label} has no operationId — the generated client needs one`);

    const sideEffect = operation['x-nt-side-effect'];
    if (!sideEffect) {
      fail(`${label} declares no x-nt-side-effect (Governance §10.6)`);
    } else if (!SIDE_EFFECT_CLASSES.has(sideEffect)) {
      fail(`${label} has an unknown x-nt-side-effect "${sideEffect}"`);
    }
    if (sideEffect === 'execute') executeOperations.push(label);

    const isWebhook = (operation.tags ?? []).includes('webhooks');
    const mutates = method !== 'get' && sideEffect !== 'none';
    if (mutates && !isWebhook) {
      const takesKey = (operation.parameters ?? []).some(
        (p) => p.name === 'Idempotency-Key' || (typeof p.$ref === 'string' && p.$ref.endsWith('IdempotencyKey')),
      );
      if (!takesKey) fail(`${label} mutates but does not take an Idempotency-Key (Governance §3)`);
    }
  }
}

// Exactly one door executes anything. This is the whole Review → Approve
// guarantee expressed as an assertion.
if (executeOperations.length !== 1) {
  fail(
    `exactly one operation may be x-nt-side-effect: execute — found ${executeOperations.length}` +
      (executeOperations.length ? `: ${executeOperations.join(', ')}` : ''),
  );
}

// --- 5. cursor pagination only (Governance §3) -----------------------------

for (const [pathName, pathItem] of Object.entries(spec.paths ?? {})) {
  const params = [...(pathItem.parameters ?? []), ...(pathItem.get?.parameters ?? [])];
  if (params.some((p) => p.name === 'offset' || p.name === 'page')) {
    fail(`GET ${pathName} uses offset pagination — cursors only`);
  }
  const listShape = pathItem.get?.responses?.['200']?.content?.['application/json']?.schema?.properties;
  if (listShape?.data && !listShape.pageInfo) {
    fail(`GET ${pathName} returns a list with no pageInfo`);
  }
}

// --- 6. the generated Zod actually guards money -----------------------------
//
// The spec-side money rules above are necessary but not sufficient: orval emits
// a bare `zod.number()` for `type: integer`, so scripts/enforce-money-int.mjs
// puts `.int()` back after generation. If that hook is ever removed, reordered,
// or silently fails, this is what notices — otherwise a float would sail through
// a boundary and R5 would be enforced only by prose.
//
// Skipped when nothing has been generated yet, so a fresh clone can lint before
// its first `pnpm generate`.

const ZOD_DIR = resolvePath(HERE, '../src/generated/zod');
if (existsSync(ZOD_DIR)) {
  const unguarded = [];
  const stack = [ZOD_DIR];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolvePath(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(/"([A-Za-z0-9_]*Pence)":\s*zod\.number\(\)(?!\.int\(\))/g)) {
          unguarded.push(`${entry.name}: ${match[1]}`);
        }
      }
    }
  }
  if (unguarded.length) {
    fail(
      `R5 — ${unguarded.length} generated Zod money field(s) accept floats. ` +
        `Did scripts/enforce-money-int.mjs run? First few: ${unguarded.slice(0, 3).join(', ')}`,
    );
  }

  // The generated Zod also ships to the browser, and orval copies every spec
  // description into it as `.describe('…')` — ~10 kB gzip of contract prose on
  // apps/web's bundle floor when METH S12 measured it. Nothing reads Zod's
  // description metadata, so scripts/strip-zod-describe.mjs removes them after
  // generation; this is what notices if that hook is removed or reordered.
  const described = [];
  const describeStack = [ZOD_DIR];
  while (describeStack.length) {
    const dir = describeStack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolvePath(dir, entry.name);
      if (entry.isDirectory()) describeStack.push(full);
      else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes('.describe(')) {
        described.push(entry.name);
      }
    }
  }
  if (described.length) {
    fail(
      `bundle — ${described.length} generated Zod file(s) still carry .describe() prose. ` +
        `Did scripts/strip-zod-describe.mjs run? First few: ${described.slice(0, 3).join(', ')}`,
    );
  }
}

// --- 7. every generated relative import can be resolved by Node -------------
//
// orval emits extensionless specifiers (`from './documents/documents'`). Node
// ESM does no extension or directory resolution, so `tsc` copying one through
// verbatim produces a dist/ that typechecks, builds, ships — and then throws
// ERR_MODULE_NOT_FOUND on first import. scripts/add-js-extensions.mjs rewrites
// them; this is what notices if that hook is removed, reordered or silently
// fails.
//
// It matters more than it looks: apps/api imports the Zod schemas at RUNTIME to
// parse its boundaries, so a missed specifier is not a build warning, it is the
// API failing to start.
//
// Skipped when nothing has been generated yet, so a fresh clone can lint before
// its first `pnpm generate`.

const GENERATED_DIR = resolvePath(HERE, '../src/generated');
if (existsSync(GENERATED_DIR)) {
  const bare = [];
  const stack = [GENERATED_DIR];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolvePath(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]*)['"]/g)) {
          if (!/\.(js|json|css)$/.test(match[1])) bare.push(`${entry.name}: ${match[1]}`);
        }
      }
    }
  }
  if (bare.length) {
    fail(
      `${bare.length} generated relative import(s) carry no extension, so Node cannot resolve them at runtime. ` +
        `Did scripts/add-js-extensions.mjs run? First few: ${bare.slice(0, 3).join(', ')}`,
    );
  }
}

// --- report ----------------------------------------------------------------

const operationCount = Object.values(spec.paths ?? {}).flatMap((item) =>
  Object.keys(item).filter((k) => HTTP_METHODS.includes(k)),
).length;

if (failures.length) {
  console.error(`\ncheck-contract: ${failures.length} problem(s) in packages/contracts/openapi.yaml\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}

console.log(
  `check-contract: ok — ${operationCount} operations, ${Object.keys(spec.components?.schemas ?? {}).length} schemas, ` +
    `${refCount} refs resolved, enums match prisma, one execution door.`,
);
