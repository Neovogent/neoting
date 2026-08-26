/**
 * Codegen from the OpenAPI contract. One spec in, three artefacts out.
 *
 * Two projects rather than one, on purpose: `apps/api` needs the Zod schemas and
 * must not drag React Query and MSW in behind them. The `exports` map in
 * package.json keeps that split honest at import time.
 *
 * Everything under src/generated/ is generated. Never hand-edit it — a
 * hand-patched type is R3, and it is also why integration takes a week instead
 * of two days. Fix the spec and regenerate.
 */
import { defineConfig } from 'orval';

/**
 * `GET /d/{code}` is declared in the contract and deliberately NOT generated.
 *
 * It is the one operation served at the origin root instead of under `/v1` —
 * the capability URL has to fit inside a ledger reference field that truncates
 * silently at ~25-30 characters (SoT §24.3.2), and a version segment no human
 * will ever type is not what that budget should be spent on.
 *
 * `ntFetch` builds every request as `baseUrl() + url` with `/v1` already inside
 * `baseUrl()`, and orval emits path-relative URLs — it ignores a path-item
 * `servers` override, measured on v7.21 rather than assumed. So a generated
 * caller would request `/v1/d/{code}`: a URL nothing serves, failing as a 404
 * that reads like a missing document rather than a wrong base.
 *
 * Excluding it is the honest fix. Nothing in our own frontend should call this
 * route — it is typed or pasted into a browser by an accountant sitting inside
 * VT Transaction+ — while the contract keeps declaring it, because it is real
 * public surface and check-contract.mjs has to see it.
 */
// ⚠ NOT `as const`. orval types `filters.tags` as a MUTABLE `(string |
// RegExp)[]`, so a readonly tuple is not assignable and this file stops
// typechecking — the annotation below is what pins the union member of `mode`
// without freezing the array.
const CAPABILITY_LINK_EXCLUSION: { mode: 'exclude'; tags: string[] } = {
  mode: 'exclude',
  tags: ['capability-links'],
};

export default defineConfig({
  /** Typed client + TanStack Query hooks + MSW handlers — consumed by apps/web. */
  client: {
    input: {
      target: './openapi.yaml',
      filters: CAPABILITY_LINK_EXCLUSION,
    },
    output: {
      // ⚠ EVERY PATH IN THIS BLOCK IS RELATIVE TO `workspace`, NOT TO THIS
      // FILE. That is the whole gotcha: setting `workspace` re-roots `target`,
      // `schemas` AND `mutator.path` at once. Leaving them config-relative
      // emitted a barrel full of `./src/generated/client/...` imports that
      // resolve to nothing, plus a stray nested `src/` directory.
      target: './index.ts',
      schemas: '../model',
      // ⚠ `workspace` IS WHAT WRITES THE BARREL. `indexFiles` defaults to true
      // and does nothing on its own — orval only emits `<workspace>/index.ts`
      // inside `if (output.workspace)` (generate-*.js). Without it, tags-split
      // produces `documents/documents.ts`, `ingestion/ingestion.ts` … and NO
      // index, so package.json's `"./client"` export pointed at a file that was
      // never generated. It failed silently for weeks because apps/api imports
      // `./model` (which has its own index, via `schemas`) and nothing else.
      workspace: './src/generated/client',
      client: 'react-query',
      httpClient: 'fetch',
      mode: 'tags-split',
      clean: true,
      // MSW handlers with faker-backed fixtures. This is what makes
      // VITE_API_MOCKING=enabled work, and therefore what keeps the frontend
      // unblocked days before an endpoint exists (Guideline §7.3).
      mock: {
        type: 'msw',
        delay: 0,
      },
      override: {
        // Every request goes through one fetch wrapper: credentials for the
        // session cookie, Idempotency-Key on mutations, problem+json mapped to
        // a typed error. Callers never assemble a request by hand.
        mutator: {
          // ⚠ RELATIVE TO `workspace`, NOT TO THIS FILE. Setting `workspace`
          // above re-roots mutator resolution, so `./src/http-client.ts` became
          // `src/generated/client/src/http-client.ts` and orval failed with
          // ENOENT. Two hops up from the workspace is this package's src/.
          path: '../../http-client.ts', // from src/generated/client -> src/
          name: 'ntFetch',
        },
        query: {
          useQuery: true,
          // `signal: true` is deliberately off. It is shaped for the axios
          // client, where the second argument is a config object carrying a
          // `signal` field; with `httpClient: 'fetch'` orval emits
          // `getThing(id, signal)` against a mutator whose second parameter is a
          // RequestInit, and the generated file does not typecheck. Callers that
          // want cancellation pass `{ signal }` as the options argument, which
          // ntFetch spreads onto the request.
          signal: false,
        },
      },
    },
  },

  /** Zod schemas — consumed by apps/api at its boundaries, and by apps/web for forms. */
  zod: {
    input: {
      target: './openapi.yaml',
      filters: CAPABILITY_LINK_EXCLUSION,
    },
    output: {
      // Workspace-relative, as in the client project above.
      target: './index.ts',
      // Points at the CLIENT project's model output, not a second copy. orval's
      // barrel always emits a `schemas` re-export line, and with no `schemas`
      // set it emitted `./index.schemas` — a file it never wrote, so `"./zod"`
      // failed to typecheck. Pointing here satisfies the barrel and reuses the
      // types that already exist; setting it to a fresh dir instead generated
      // 147 duplicate type aliases of exactly what `model/` already holds.
      schemas: '../model',
      // Same reason as the client project — without this there is no
      // `zod/index.ts` and `"./zod"` resolves to nothing.
      workspace: './src/generated/zod',
      client: 'zod',
      mode: 'tags-split',
      clean: true,
      // NOTE: orval emits a plain `zod.number()` for `type: integer` — with or
      // without `format: int32`, measured on v7.21 — which would let `12.34`
      // through a money field. `pnpm generate` therefore chains
      // scripts/enforce-money-int.mjs after this, and check-contract.mjs fails
      // the build if that step is ever skipped. Do not run bare `orval` and
      // commit the result.
      override: {
        zod: {
          // Governance §9.2 parses every structured payload in .strict() mode.
          // Generating strict schemas means "parse, don't trust" is the default
          // rather than something each call site remembers.
          strict: {
            body: true,
            response: true,
            query: true,
            param: true,
            header: true,
          },
        },
      },
    },
  },
});
