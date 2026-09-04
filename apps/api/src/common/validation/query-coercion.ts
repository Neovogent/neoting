import type { z } from 'zod';

/**
 * Lift an Express query object into the shapes the generated schemas expect,
 * WITHOUT hand-writing a DTO.
 *
 * The gap this closes: query strings have no types. Express hands the
 * controller `{ limit: '25', state: 'READY' }` — every value a string, a
 * repeated key an array of strings — while the generated Zod schemas
 * (`@neoting/contracts/zod`) type `limit` as `z.number()` and every repeatable
 * filter as `z.array(...)`, because that is what `openapi.yaml` declares.
 * Parsed raw, `?limit=25` and `?state=READY` are both 400s: the first is a
 * string where a number is expected, the second a bare string where an array
 * is. The very first call `apps/web` makes (`useDocuments` with `limit: 100`)
 * trips it.
 *
 * The schemas themselves cannot change — they are generated from the contract
 * and regenerating with global coercion would loosen every OTHER boundary
 * (bodies are JSON and genuinely typed; a number-as-string in a body SHOULD be
 * a 400). So the conversion happens here, at the one boundary where stringness
 * is transport, not data — and it is driven off the schema's own shape, so it
 * cannot drift from the contract:
 *
 * - a key the schema types as an array, holding a single value → wrapped
 *   (`explode: true` form parameters arrive bare when given once);
 * - a key the schema types as a number, holding a string that parses as one →
 *   converted. A string that does NOT parse (`?limit=abc`) is passed through
 *   untouched so Zod reports the honest "expected number" against the field;
 * - a key the schema types as a boolean, holding exactly `"true"` or `"false"`
 *   → converted. **Only those two spellings**, and deliberately not the truthy
 *   coercion `Boolean(value)` would give: under that rule `?deleted=false` is
 *   `true`, which on `GET /documents` is the entire Trash served in place of
 *   the inbox. `"1"`, `"yes"` and `""` are passed through untouched so Zod
 *   reports "expected boolean" rather than this helper guessing. Added with the
 *   first boolean query parameter in the contract (`deleted`, 2 Sep 2026);
 * - a key the schema does not know → passed through untouched, so `.strict()`
 *   rejects it BY NAME rather than this helper silently dropping it;
 * - anything that is not an object at all → passed through for the schema to
 *   reject as it would have anyway.
 *
 * Wrappers (`optional`, `default`, `nullable`) are unwrapped before the type
 * check, because the generated query params are almost all optional. Matching
 * is on `_def.typeName` strings rather than `instanceof`, deliberately: the
 * schemas are constructed by the `zod` instance inside `@neoting/contracts`,
 * and under pnpm that is not guaranteed to be the same module instance as
 * ours — `instanceof` across two zod copies is silently false everywhere,
 * which would turn this helper into a no-op that every test misses.
 */
export function coerceQuery(
  schema: { readonly shape: Readonly<Record<string, z.ZodTypeAny>> },
  query: unknown,
): unknown {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return query;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const field = schema.shape[key];
    if (field === undefined) {
      out[key] = value;
      continue;
    }
    const name = typeName(unwrap(field));
    if (name === 'ZodArray' && !Array.isArray(value)) {
      out[key] = [value];
    } else if (name === 'ZodNumber' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      out[key] = Number(value);
    } else if (name === 'ZodBoolean' && (value === 'true' || value === 'false')) {
      out[key] = value === 'true';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function typeName(t: z.ZodTypeAny): string | undefined {
  return (t._def as { typeName?: string }).typeName;
}

/** Strip `optional`/`default`/`nullable` wrappers down to the core type. */
function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  let core = t;
  for (;;) {
    const name = typeName(core);
    if (name !== 'ZodOptional' && name !== 'ZodDefault' && name !== 'ZodNullable') return core;
    core = (core._def as { innerType: z.ZodTypeAny }).innerType;
  }
}
