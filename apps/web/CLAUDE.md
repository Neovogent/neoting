# apps/web — Vite + React 19 SPA

**This is not a Next.js app.** D37 (SoT v1.5) replaced the App Router plan with the built Vite SPA. There are no route groups, no server components and no `app/` directory — routing is a hand-rolled switch in `src/App.tsx` over a `view` in `AppContext`, with every screen behind `React.lazy`.

Read `docs/Source_Of_Truth.md` D37 before assuming anything Next-shaped. The requirements that route groups used to satisfy for free did **not** go away; they became build configuration plus review conditions, and the notes in `vite.config.ts` say which is which.

## The frontend ten (Guideline §7.4)

1. **Split at the route.** Every screen is `lazy()`-loaded from `App.tsx` so opening one downloads one. This replaced "Server Components by default", and it inherits that rule's job: keeping per-route weight down. (Guideline v1.2 §7.4.)
2. **Tokens only** — no hex, no arbitrary px. ⚠ **Not true of the imported code yet**: ~1,016 inline hex literals, tracked in issue #64. Light mode is ~60 override rules keyed to exact hex class names, so a *new* arbitrary hex silently stays dark. Do not add more.
3. Chat renders **component-grammar primitives only**. If the grammar lacks a card, that is a G7 conversation, not a one-off `<div>`. The grammar is being derived from the imported components rather than imposed on them.
4. Every user-facing string through a catalogue (en-GB); the lint rule blocks literals. ⚠ **No library is chosen** — next-intl was Next-only and D37 retired it. Governance v1.5 §12.6 keeps every rule and drops the name. ~1,200 literals to extract, tracked in issue #65.
5. All four states per screen: empty (teaches the next action), loading (skeletons, no spinners on primary surfaces), error (plain English + `NT-` code), success.
6. Accessibility on every PR: full keyboard path, visible focus, `aria-live="polite"` on chat updates, contrast from tokens, error text never colour-only. Run axe locally before requesting review. `jsx-a11y` is not yet in `eslint.config.js` — see the note there.
7. Motion by the numbers (tokens `CLAUDE.md`). `motion` (Framer), not CSS transitions, for anything stateful.
8. **< 250 KB gzipped JS per route.** The portal is the lightest surface in the product and takes no heavy dependencies, ever — it must load fast on a bad connection in a car park. See *Bundle* below for where this actually stands.
9. Optimistic UI with rollback toasts. The Approve button literally cannot render before Read-review opens — the grammar enforces it; don't work around it.
10. Component tests for anything with logic.

## Data

`packages/contracts` generates the typed client and the MSW handlers. **Never hand-write an API type; never `fetch` raw in a component.** Data flows through the generated client and TanStack Query.

`VITE_API_BASE_URL` (**not** `NEXT_PUBLIC_*` — those are dead in a Vite build and fail silently) sets the API origin; `packages/contracts/src/http-client.ts` appends `/v1`. Unset, it is `http://localhost:3000` — the port the API actually listens on. It said 3001 here until PR #82, which was the same wrong number the spec's `servers` block carried; nothing has ever served 3001, so an unconfigured clone called a closed port.

⚠ **The screens do not read from the API yet.** `AppContext` is still driven by the synthetic generators in `lib/seed.ts`, `lib/seed2.ts` and `lib/generate.ts`. The contract path exists and is exercised (`src/api/documents.ts`, `useDocuments`, and the MSW handlers), but wiring the views onto it is the next piece of work, not something already done.

MSW is started from `src/main.tsx` behind a **dynamic** `import()`, which is what keeps it and `@faker-js/faker` out of the production bundle. Verified: neither string appears in `dist`. Keep it dynamic.

`VITE_CHAT_PROXY=enabled` is the one remaining escape hatch, and it is **off by default deliberately** — it lets the chat box call `POST /api/chat`, the Gemini-backed classifier in the pre-monorepo frontend's `server.ts`. Gemini sits outside D22/D28 (Bedrock, eu-west-2) and outside D30 (UK-first residency); issue #59 keeps it as a temporary local-development exception whose whole condition is that it goes before the frontend is deployed anywhere that is not a laptop. `server.ts` did not come across in the import, so in this repository the route does not exist and the flag has nothing to reach. **Do not turn it on in any deployed build.**

## Bundle

Measured on the import build, gzipped:

| | gzip |
|---|---|
| `index.js` (shared) | 162.6 kB |
| `query.js` (TanStack) | 14.8 kB |
| `index.css` | 11.9 kB |
| `react.js` | 1.5 kB |
| **shared floor, every route** | **190.9 kB** |
| heaviest route on top (`ClientDetailView`) | 32.6 kB |

Every route is inside the 250 KB budget, but **the shared floor is most of it** — the budget is met with roughly 25 kB of headroom, not comfortably. Two things drive that floor and both are known:

- `AppContext.tsx` is ~90 kB of source and wraps every route, so it can never be split out;
- the synthetic dataset (~67 kB of source across the three seed/generate modules) is imported by `AppContext` at module scope and therefore ships to users.

Most of that leaves when the views move onto the generated client. Until then, treat 190.9 kB as the floor a new screen is spending against, and re-measure with `pnpm --filter @neoting/web build` before adding a dependency.

## Tests

`pnpm test` (vitest, jsdom). **Offline by construction** (Governance §15.1): every suite exercises pure functions and the MSW handler bodies directly, so nothing opens a socket and nothing waits on a timer. Tests sit beside what they test, as `*.test.ts`.

What is covered today, and why those:

| Suite | Why it earns its place |
|---|---|
| `src/api/mocks/handlers.test.ts` | The inbox is one endpoint serving four screens through query parameters. Filtering, search, sorting and cursor pagination are asserted here, plus the mock body being parsed by the contract's own Zod schema so fixtures cannot drift from the spec. |
| `src/api/documents.test.ts` | The pence↔pounds boundary, round-tripped exactly, and the enum tables pinned against `DocumentState` / `DocumentChannel` from the contract — a value added to the spec fails here rather than rendering as something plausible. |
| `src/lib/spreadsheet.test.ts` | Money parsing (`2.000,00` is two thousand), quoted CSV fields, and the Net·VAT·Total column race. |
| `src/lib/tableImport.test.ts` | XLSX date serials, day-first UK dates, totals lines refused rather than booked, signed ledgers where a positive row is a refund. |
| `src/lib/matching.test.ts` | Whether a transaction is settled or handed to a human, and the merchant bar that keeps Costco off Costa. |
| `src/lib/dedupe.test.ts` | The two Dext gaps this exists to close: a pair survives a failed extraction, and an invoice matches its receipt twin. |

Component tests are still owed for anything with logic (frontend ten, item 10).

## Previews

Vercel previews are a **viewing tool, not hosting** (G6). Synthetic data only. **Deployment Protection must be on before the first preview ships** — an unprotected preview URL is a leaked credential and an instant reject (G10/R16).
