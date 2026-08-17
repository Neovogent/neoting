# apps/web — Vite + React 19 SPA

**This is not a Next.js app.** D37 (SoT v1.5) replaced the App Router plan with the built Vite SPA. There are no route groups, no server components and no `app/` directory — routing is a hand-rolled switch in `src/App.tsx` over a `view` in `AppContext`, with every screen behind `React.lazy`.

Read `docs/Source_Of_Truth.md` D37 before assuming anything Next-shaped. The requirements that route groups used to satisfy for free did **not** go away; they became build configuration plus review conditions, and the notes in `vite.config.ts` say which is which.

## The frontend ten (Guideline §7.4)

1. **Split at the route.** Every screen is `lazy()`-loaded from `App.tsx` so opening one downloads one. This replaced "Server Components by default", and it inherits that rule's job: keeping per-route weight down. (Guideline v1.2 §7.4.)
2. **Tokens only** — no hex, no arbitrary px, no rgb()/rgba(). Done for colour: the palette AND the shadow/glow ramp live in the `@theme` block of `src/index.css` (issues #64, #85, #86); alpha steps derive from the base tokens via `color-mix`. Light mode is a variable redefinition plus the documented per-utility exceptions in that file. `scripts/check-colors.mjs` fails `pnpm lint` on any rgb()/rgba() literal anywhere under `src`, including the stylesheet ESLint cannot see.
3. Chat renders **component-grammar primitives only**. If the grammar lacks a card, that is a G7 conversation, not a one-off `<div>`. The grammar is being derived from the imported components rather than imposed on them.
4. Every user-facing string through a catalogue (en-GB); the lint rule blocks literals. **Done — issue #65.** The library is **react-intl** (§12.6 leaves the library open and fixes the behaviour; react-intl is ICU-MessageFormat and framework-agnostic, which is what D37 needed). `defineMessages` per component, ids on `domain.component.purpose`, and `lang/en-GB.json` extracted from source by `pnpm i18n:extract` — **generated, never hand-edited.** Two gates, at different altitudes: `neoting/no-literal-string-in-jsx` works on source and blocks the next literal someone types, `pnpm i18n:check` works on the catalogue and blocks a message with no default, an off-convention key, a silently-overwritten duplicate id or invalid ICU. **2,642 messages** (136 local ids collapsed into 22 `common.*` ids in issue #94). See *i18n* below before adding a string.
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

There is no chat proxy and no escape hatch. `VITE_CHAT_PROXY` and the `POST /api/chat` call to the pre-monorepo frontend's Gemini classifier were removed with issue #59: `server.ts` never came across in the import, so the route did not exist and the call could not succeed, while the deterministic classifier in `lib/resolver.ts` was already producing the answer. That ends the D22/D28 (Bedrock, eu-west-2) and D30 (UK-first residency) exception structurally rather than resting it on a flag default — chat reaches a model again only through the Bedrock-backed surface, which belongs to `chat-framework`, not to this component. As of that removal there is **no raw `fetch` anywhere in `src/`**, so the "never `fetch` raw in a component" rule above holds with no exception.

## i18n

Adding a string: `defineMessages` at the top of the component, id `domain.component.purpose`, `intl.formatMessage(m.thing)` at the call site. Plurals are ICU (`{count, plural, one {# day} other {# days}}`) — **never** `${n} day${n === 1 ? '' : 's'}`, which encodes an English-only rule about pluralisation and is wrong in most of the languages this would be translated into. Never concatenate a sentence out of fragments; interpolate into one message.

Before minting a per-component id for a universal word, check `src/i18n/common.ts` (`common.action.*`, `common.label.*`, `common.placeholder.*`). Consolidation is by meaning, never string equality: status pills, tabs, navigation labels, channel names and "Yes, …" confirm labels stay per-component so a translator shortening one surface cannot silently reword another (issue #94).

`lang/en-GB.json` is **generated and gitignored** (Governance §1.4 — never commit generated output), so it will not be in the diff and you cannot hand-edit it: `pnpm i18n:check` re-extracts before it checks, and the edit is gone by the time anything reads it. It is the artefact a translator receives, rebuilt on every `pnpm lint`.

**The literal rule is `neoting/no-literal-string-in-jsx`, not `formatjs/`, and the difference is deliberate.** It is the formatjs rule with reports over pure punctuation dropped, because separators like `·`, `—`, `→`, `✓`, `£`, `%` and `{' '}` are not language and putting them in a catalogue teaches everyone the wrong lesson about what a catalogue is for. The upstream rule has no option for that in **any** published version — its only config is `props.include`/`props.exclude`, which match tag and attribute *names*, never the matched text — so the exemption is a wrapper in `eslint/no-literal-string-in-jsx.js`. Read it before touching it; it is eleven lines of predicate and forty of why. Two things about it that matter:

- **it drops a report only when every static chunk has no letter and no digit in it, in any script.** A numeral is not punctuation — `0.00` and `0000` are placeholders whose digits and decimal separator change with the locale, so they are in the catalogue like anything else. One letter is enough to fail: the single deliberate exemption in the app is the Xero brand glyph in `ClientsView`, which carries an `eslint-disable-next-line` and a paragraph saying why.
- **it fails towards reporting.** An unrecognised node shape, or an ESLint that changes how a rule context is built, gets the unfiltered rule — noisy, never quiet. `eslint/no-literal-string-in-jsx.test.js` asserts both halves, because a filter that silently starts matching everything turns the gate into a green tick that checks nothing. This repo has already had one of those (see the header of `scripts/check-i18n.mjs`).

`linterOptions.reportUnusedDisableDirectives` is `error`, so a disable comment that no longer suppresses anything — or that names the upstream rule by mistake — fails the build rather than sitting in the file looking like enforcement.

## Bundle

Gzipped, after the i18n extraction. The budget is **JS** (SoT §14: "initial JS < 250 KB gzipped per route"), so CSS is listed but not counted against it:

| | at import | now |
|---|---|---|
| `index.js` (shared) | 162.6 kB | **182.4 kB** |
| `query.js` (TanStack) | 14.8 kB | 14.8 kB |
| `react.js` | 1.5 kB | 1.5 kB |
| **shared JS floor, every route** | **178.9 kB** | **198.8 kB** |
| heaviest route on top (`ClientDetailView`) | 32.6 kB | **45.1 kB** |
| **worst route, total JS** | **211.5 kB** | **243.9 kB** |
| `index.css` (not in the JS budget) | 11.9 kB | 12.4 kB |

⚠ **The headroom is now about 6 kB, not 25.** Extraction cost ~19.6 kB on the shared floor and ~13 kB on the heaviest route — react-intl itself, plus 2,642 `defaultMessage` strings that ship inline in the components that declare them. That is the honest price of the rule in item 4 and it was worth paying, but it means **the next screen or dependency is very likely to break the budget**, and a route over budget is a reject (D37), not a warning.

Three things drive the floor, all known:

- `AppContext.tsx` is ~90 kB of source and wraps every route, so it can never be split out;
- the synthetic dataset (~67 kB of source across the three seed/generate modules) is imported by `AppContext` at module scope and therefore ships to users;
- every `defaultMessage` is in the bundle. The catalogue is not loaded at runtime yet — `lang/en-GB.json` exists for translators and for the gate. When a second locale arrives, the messages should move to a fetched catalogue and the defaults be stripped at build (`@formatjs/babel-plugin-react-intl` / the SWC equivalent `removeDefaultMessage`), which gives most of the 19.6 kB back.

Most of the seed weight leaves when the views move onto the generated client. Until then, treat 198.8 kB as the floor a new screen is spending against, and re-measure with `pnpm --filter @neoting/web build` before adding a dependency.

## Tests

`pnpm test` (vitest, jsdom). **Offline by construction** (Governance §15.1): every suite either exercises pure functions and the MSW handler bodies directly, or renders the shell against jsdom with the API query disabled — nothing opens a socket and nothing waits on a timer. Tests sit beside what they test, as `*.test.ts(x)`.

What is covered today, and why those:

| Suite | Why it earns its place |
|---|---|
| `src/api/mocks/handlers.test.ts` | The inbox is one endpoint serving four screens through query parameters. Filtering, search, sorting and cursor pagination are asserted here, plus the mock body being parsed by the contract's own Zod schema so fixtures cannot drift from the spec. |
| `src/api/documents.test.ts` | The pence↔pounds boundary, round-tripped exactly, and the enum tables pinned against `DocumentState` / `DocumentChannel` from the contract — a value added to the spec fails here rather than rendering as something plausible. |
| `src/lib/spreadsheet.test.ts` | Money parsing (`2.000,00` is two thousand), quoted CSV fields, and the Net·VAT·Total column race. |
| `src/lib/tableImport.test.ts` | XLSX date serials, day-first UK dates, totals lines refused rather than booked, signed ledgers where a positive row is a refund. |
| `src/lib/matching.test.ts` | Whether a transaction is settled or handed to a human, and the merchant bar that keeps Costco off Costa. |
| `src/lib/dedupe.test.ts` | The two Dext gaps this exists to close: a pair survives a failed extraction, and an invoice matches its receipt twin. |
| `src/context/AppContext.test.tsx` | The #87 regression: nine rapid route changes with conversation churn interleaved, asserting the tree survives, the address is not yanked back mid-render, and no setState-during-render warning fires. The one suite that renders the whole shell. |
| `eslint/no-literal-string-in-jsx.test.js` | The one suite that tests a *gate* rather than the product: real copy still fails the literal rule, punctuation still passes. The cases are lifted verbatim from the views. Not under `src/`, because the rule is not application code — which also keeps it out of `tsc`'s include and out of the bundle. |

Component tests are still owed for anything with logic (frontend ten, item 10) — the AppContext suite is the first, not the last.

## Previews

Vercel previews are a **viewing tool, not hosting** (G6). Synthetic data only. **Deployment Protection must be on before the first preview ships** — an unprotected preview URL is a leaked credential and an instant reject (G10/R16).
