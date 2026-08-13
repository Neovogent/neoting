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

export default defineConfig({
  /** Typed client + TanStack Query hooks + MSW handlers — consumed by apps/web. */
  client: {
    input: {
      target: './openapi.yaml',
    },
    output: {
      target: './src/generated/client/index.ts',
      schemas: './src/generated/model',
      client: 'react-query',
      httpClient: 'fetch',
      mode: 'tags-split',
      clean: true,
      // MSW handlers with faker-backed fixtures. This is what makes
      // NEXT_PUBLIC_API_MODE=mock work, and therefore what keeps the frontend
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
          path: './src/http-client.ts',
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
    },
    output: {
      target: './src/generated/zod/index.ts',
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
