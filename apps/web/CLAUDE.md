# apps/web — Vite + React 19 SPA

**This is not a Next.js app.** D37 (SoT v1.5) replaced the App Router plan with the built Vite SPA. There are no route groups, no server components and no `app/` directory — routing is a hand-rolled switch in `src/App.tsx` over a `view` in `AppContext`, with every screen behind `React.lazy`.

Read `docs/Source_Of_Truth.md` D37 before assuming anything Next-shaped. The requirements that route groups used to satisfy for free did **not** go away; they became build configuration plus review conditions, and the notes in `vite.config.ts` say which is which.

## The frontend ten (Guideline §7.4)

1. **Split at the route.** Every screen is `lazy()`-loaded from `App.tsx` so opening one downloads one. This replaced "Server Components by default", and it inherits that rule's job: keeping per-route weight down. (Guideline v1.2 §7.4.)
2. **Tokens only** — no hex, no arbitrary px, no rgb()/rgba(). Done for colour: the palette AND the shadow/glow ramp live in the `@theme` block of `src/index.css` (issues #64, #85, #86); alpha steps derive from the base tokens via `color-mix`. Light mode is a variable redefinition plus the documented per-utility exceptions in that file. `scripts/check-colors.mjs` fails `pnpm lint` on any rgb()/rgba() literal anywhere under `src`, including the stylesheet ESLint cannot see.
3. Chat renders **component-grammar primitives only**. If the grammar lacks a card, that is a G7 conversation, not a one-off `<div>`. The grammar is being derived from the imported components rather than imposed on them.
4. Every user-facing string through a catalogue (en-GB); the lint rule blocks literals. **Done — issue #65.** The library is **react-intl** (§12.6 leaves the library open and fixes the behaviour; react-intl is ICU-MessageFormat and framework-agnostic, which is what D37 needed). `defineMessages` per component, ids on `domain.component.purpose`, and `lang/en-GB.json` extracted from source by `pnpm i18n:extract` — **generated, never hand-edited.** Two gates, at different altitudes: `neoting/no-literal-string-in-jsx` works on source and blocks the next literal someone types, `pnpm i18n:check` works on the catalogue and blocks a message with no default, an off-convention key, a silently-overwritten duplicate id or invalid ICU. **2,642 messages** (136 local ids collapsed into 22 `common.*` ids in issue #94). See *i18n* below before adding a string.
5. All four states per screen: empty (teaches the next action), loading (skeletons, no spinners on primary surfaces), error (plain English + `NT-` code), success.
6. Accessibility on every PR: full keyboard path, visible focus, `aria-live="polite"` on chat updates, contrast from tokens, error text never colour-only. `jsx-a11y` (recommended set) and `react-hooks` (`rules-of-hooks` + `exhaustive-deps`) are now enforced at error in `eslint.config.js`, and the pre-existing findings are swept: backdrops are `role="presentation"` with Escape as the keyboard dismissal (`lib/useEscape.ts` — a stack, because dialogs nest; read it before adding a listener of your own), row-click targets carry real button semantics, and the three `autoFocus` uses carry reasoned disables (focus following an explicit user action is the dialog pattern, not focus theft). **Axe before review is still owed on every PR** — the linter cannot see computed contrast or focus order. The nine `exhaustive-deps` disables in `AppContext.tsx` are deliberate inventory, not fixes: each names its omitted-but-stable dep (`logAudit`, `setActiveConversationId`), and they come out together in a stable-callback sweep of that file — do not fix one in passing, and do not add a tenth.
7. Motion by the numbers (tokens `CLAUDE.md`). `motion` (Framer), not CSS transitions, for anything stateful.
8. **< 250 KB gzipped JS per route.** The portal is the lightest surface in the product and takes no heavy dependencies, ever — it must load fast on a bad connection in a car park. See *Bundle* below for where this actually stands.
9. Optimistic UI with rollback toasts. The Approve button literally cannot render before Read-review opens — the grammar enforces it; don't work around it.
10. Component tests for anything with logic.

## Data

`packages/contracts` generates the typed client and the MSW handlers. **Never hand-write an API type; never `fetch` raw in a component.** Data flows through the generated client and TanStack Query.

`VITE_API_BASE_URL` (**not** `NEXT_PUBLIC_*` — those are dead in a Vite build and fail silently) sets the API origin; `packages/contracts/src/http-client.ts` appends `/v1`. Unset, it is `http://localhost:3000` — the port the API actually listens on. It said 3001 here until PR #82, which was the same wrong number the spec's `servers` block carried; nothing has ever served 3001, so an unconfigured clone called a closed port.

⚠ **Almost no screen reads from the API yet.** `AppContext` is still driven by the synthetic generators in `lib/seed.ts`, `lib/seed2.ts` and `lib/generate.ts`, and wiring the practice views onto the contract is still the work in front of us. The one exception is the chase portal (`/p/:linkToken`, METH Stage 9) — see *Client-facing surfaces* below. It is deliberately the first: it is the narrowest surface, its three operations are contracted, and nothing else in the app derives anything from it, so it could move without taking the pipeline's derived state with it.

MSW is started from `src/main.tsx` behind a **dynamic** `import()`, which is what keeps it and `@faker-js/faker` out of the production bundle. Verified: neither string appears in `dist`. Keep it dynamic.

There is no chat proxy and no escape hatch. `VITE_CHAT_PROXY` and the `POST /api/chat` call to the pre-monorepo frontend's Gemini classifier were removed with issue #59: `server.ts` never came across in the import, so the route did not exist and the call could not succeed, while the deterministic classifier in `lib/resolver.ts` was already producing the answer. That ends the D22/D28 (Bedrock, eu-west-2) and D30 (UK-first residency) exception structurally rather than resting it on a flag default — chat reaches a model again only through the Bedrock-backed surface, which belongs to `chat-framework`, not to this component.

**There is exactly one raw `fetch` in `src/`, and it does not call the API.** `src/api/portal.ts` `PUT`s the uploaded bytes to the presigned storage URL the API just handed it. That request goes to the object store, not to Neoting, and its signature covers the method, the URL and the headers exactly as issued — `ntFetch` would prefix `/v1`, attach `credentials: 'include'`, add an `Idempotency-Key` and an `Accept`, and the signature would stop matching. It is in the api layer, never in a component, and the rule above ("never `fetch` raw in a component") holds unchanged. When the practice-side web upload is wired (METH Stage 7) it will need the same call; put it beside this one rather than in a view.

### ⚠ The generated client's response envelope does not exist at runtime

orval's fetch client types every operation as `Promise<{ data: T, status: 200 }>`. The mutator all of them go through — `ntFetch` in `packages/contracts/src/http-client.ts` — returns `await response.json()`, i.e. **the body itself**. So `result.data` typechecks and is `undefined` at run time unless the body happens to have its own `data` field.

`src/api/portal.ts` therefore reads the awaited value as `unknown` and lets the Zod schema decide the shape, which is the rule anyway. **`src/api/documents.ts` does not** — it parses `query.data.data` (the row array) against `listDocumentsResponse` (which is `{ data, pageInfo }`), so in live or mocked mode that parse fails and the inbox reports a contract error rather than rendering. Left alone here because the documents surface is METH Stage 7's, not Stage 9's; it is a one-line fix at that call site (`query.data`, not `query.data.data`) and it needs the hook's own test, which does not exist yet.

## Client-facing surfaces

Four shells replace the practice app outright rather than sitting inside it, because a client must never have another client's data behind the screen they are on. `App.tsx` switches on `portal` from `AppContext`, and each is its own lazy chunk:

| `portal` | Address | What it is | Data |
|---|---|---|---|
| `business` | `/portal/:accountId` | An account a business signs into and can browse | seed |
| `approval` | `/approve/:requestId` | SMS link → OTP → approve one client's batch | seed |
| `registration` | `/register/:accountId/:memberId` | An invited person filling in their own details | seed |
| `chase-upload` | `/p/:linkToken` | SMS link → OTP → the items one chase asked for → upload | **real API** |

### The chase portal (`/p/:linkToken`) — METH Stage 9

The narrowest surface in the product, and the only one wired to the API today. No account, no password, no browsing: a delegated session that may see the items one chase asked for and add documents to them.

`ChasePortalView` is the screen flow, `usePortalJourney` is the state, `src/api/portal.ts` is the wire. The journey has two implementations behind one interface — the contracted operations when `VITE_API_ENABLED=true`, and `AppContext`'s own chase state otherwise — so the view has one code path and the synthetic demo keeps working (METH_MODE §1 makes that a standing condition on every stage).

Five things about it that are decisions, not details:

- **The credential is a bearer, not a cookie.** `METH_MODE.md` Stage 9 says "issue portal cookie"; `openapi.yaml` declares `portalSession: {type: http, scheme: bearer}`. The contract is LAW (G7), so it wins and `openapi.yaml` was not edited to match the prose. The same divergence is recorded in `apps/api/src/modules/portal/CLAUDE.md`.
- **The token is held in React state and nowhere else.** Not `localStorage`, not a cookie, not a module singleton. It is a delegated grant whose holder is not a user and has no way to re-prove anything; persisting it would leave a standing upload credential for someone else's books on a phone that gets handed round the till, with no sign-out anywhere in the product that could clear it. It dies with the tab, which is the intended lifetime.
- **The upload is three calls, and only two are ours.** `POST /portal/uploads` for the intent, a presigned `PUT` straight to storage (the bearer must **not** travel there — see the raw-`fetch` note above), then `POST /document-uploads/{uploadId}/complete`, which the contract lets the portal bearer use. One completion path at two trust levels, no second door.
- **The extraction overlay is read-only, and not by choice.** SoT Stage 8.4 wants the client to correct a misread figure in the portal. `openapi.yaml` puts `portalSession` on three operations plus completion, and none of them *reads* an extraction — so the portal cannot show the figures at all, let alone write a correction. The panel shows what the client sent and says who reads it. Fixing this is a contract change (a portal-scoped extraction read, and a decision on whether a client's correction goes through Review → Approve), which `packages/contracts/CLAUDE.md` already carries on its pass-3 list as Shakib's call.
- **The mismatch message names what we still need, not what we read.** SoT's beat is *"This looks like a £420 invoice, but we need the £600 Google transaction from 5 Aug."* The second half is contracted (`ChaseItem`); the first half is the extraction, which the portal cannot see. So the copy says the true half. The match itself is the server's answer, never a guess made here: the portal polls `GET /portal/context` and reads `received`, which the same deterministic compare sets that auto-closes the chase.
- **"Not answered yet" is its own outcome (`pending`), and that is load-bearing.** `received` is false both for a genuine mismatch *and* for a document still being read, and the client cannot tell those apart — so neither may the copy. The review of Stage 9 caught the hook falling through the 12 s poll budget into `unmatched`, which renders *"it does not look like the {merchant} payment…"* plus a **Send a different one** CTA: a client who photographed the *correct* receipt was told it was the wrong one and pushed to re-send. It was not occasional — `INGEST_QUEUE` defaults to `fixture`, whose queue no worker consumes, so against a default-env API **every** upload ended there, including the demo's headline beat. `pending` now says only what is true ("your accountant has it, nothing is lost, not matched yet") and returns to the list. A failure *after* the send is `pending` too, not `failed` — the bytes are in storage by then, and "That did not send" would be a lie that costs a duplicate.

**What the SMS must contain.** The link the chase composes has to be `<web origin>/p/<linkToken>`. The API composes the SMS body (`sms-copy.ts`, marker `Upload securely: `) and today the token is put in bare; whoever wires the demo outbox must build the full URL, or the tap goes nowhere. The link-entry screen accepts either — it keeps the last path segment of whatever is pasted — but that is a fallback for a mangled text, not the design.

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

| | at import | after i18n | now (METH S9) |
|---|---|---|---|
| `index.js` (shared) | 162.6 kB | 182.4 kB | **187.3 kB** |
| `query.js` (TanStack) | 14.8 kB | 14.8 kB | 14.8 kB |
| `react.js` | 1.5 kB | 1.5 kB | 1.5 kB |
| **shared JS floor, every route** | **178.9 kB** | **198.8 kB** | **203.5 kB** |
| heaviest route on top (`ClientDetailView`) | 32.6 kB | 45.1 kB | **45.2 kB** |
| **worst route, total JS** | **211.5 kB** | **243.9 kB** | **248.7 kB** |
| chase portal on top (`ChasePortalView`) | — | — | 7.4 kB → **210.9 kB** |
| `index.css` (not in the JS budget) | 11.9 kB | 12.4 kB | 13.0 kB |

⚠ **The headroom is about 1.3 kB.** Not 6, and not 25. Re-measured on the METH Stage 9 build: the "now" column above is what `pnpm --filter @neoting/web build` prints today, and the 243.9 kB in the middle column was already stale before Stage 9 touched anything — the shared floor had drifted ~4.5 kB on its own. Stage 9 itself cost **0.17 kB** on the floor (one union member in `AppContext` and one lazy import in `App.tsx`); the rest of the gap was already there and nobody had re-run the build.

**Measure before you merge, not after.** A route over budget is a reject (D37), not a warning, and at 1.3 kB the next `import` of anything shared will do it. The portal is the lightest client-facing route by a wide margin (210.9 kB against `BusinessPortal`'s 224 kB), which is what SoT §14 asks of it — keep it that way: no heavy dependency, and nothing it imports may become shared with a practice screen.

Three things drive the floor, all known:

- `AppContext.tsx` is ~90 kB of source and wraps every route, so it can never be split out;
- the synthetic dataset (~67 kB of source across the three seed/generate modules) is imported by `AppContext` at module scope and therefore ships to users;
- every `defaultMessage` is in the bundle. The catalogue is not loaded at runtime yet — `lang/en-GB.json` exists for translators and for the gate. When a second locale arrives, the messages should move to a fetched catalogue and the defaults be stripped at build (`@formatjs/babel-plugin-react-intl` / the SWC equivalent `removeDefaultMessage`), which gives most of the 19.6 kB back.

Most of the seed weight leaves when the views move onto the generated client. Until then, treat 203.5 kB as the floor a new screen is spending against, and re-measure with `pnpm --filter @neoting/web build` before adding a dependency.

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
| `src/api/portal.test.ts` | The delegated boundary, with `globalThis.fetch` replaced by a recorder. Pence→pounds signed and exact; the merchant → raw-descriptor → nothing fallback; a code that is not six digits refused **before** the network; a float in a pence field refused **after** it; and the two rules that make the session safe — the bearer goes to the API on all three of our calls, and it does **not** go to the storage host on the presigned `PUT`. |
| `src/views/business/ChasePortalView.test.tsx` | The fallback demo path nobody exercises by hand: `/p/<token>` reaches the portal and not the practice app, the six-digit gate is real in the UI, and passing it lands on the item list. |
| `src/lib/capture.test.ts` | The pure half of the compression path — bytes out of a data URL exactly as they went in (including a JPEG header that is not valid UTF-8), and the `.jpg` renaming. The encode itself needs a canvas, which jsdom has not got. |
| `src/lib/useEscape.test.tsx` | The Escape stack: with dialogs nested (DuplicateModal → ConfirmStep), one keypress closes the top layer only, a closed-but-mounted viewer does not shadow the layer below, and the handler read is the latest render's. Invisible in manual testing until someone loses two layers to one Escape. |
| `eslint/no-literal-string-in-jsx.test.js` | The one suite that tests a *gate* rather than the product: real copy still fails the literal rule, punctuation still passes. The cases are lifted verbatim from the views. Not under `src/`, because the rule is not application code — which also keeps it out of `tsc`'s include and out of the bundle. |

Component tests are still owed for anything with logic (frontend ten, item 10) — the AppContext suite is the first, not the last.

`vitest.setup.ts` shims what jsdom lacks and the app really uses. Four entries now: `matchMedia`, `ResizeObserver`, `scrollIntoView`, and `Blob.prototype.arrayBuffer` — jsdom 25 still has no `arrayBuffer()` (nor `text()`), and the portal reads the bytes it is about to upload in order to hash them. The shim is built out of jsdom's own `FileReader`, so it is a real read rather than a stand-in, and it is `??=`-guarded like the others so a jsdom that grows the method wins.

**Lazy routes need `findBy*`, not `await act(async () => {})`.** A `React.lazy` chunk does not resolve inside a microtask flush, so an `act` flush leaves the skeleton on screen and every query fails against it. `ChasePortalView.test.tsx` waits on `screen.findByRole` — still offline, because the only thing being waited on is a dynamic `import()`. This is also why `AppContext.test.tsx` can only assert that `#root` is non-empty: what it is looking at is the skeleton.

## Previews

Vercel previews are a **viewing tool, not hosting** (G6). Synthetic data only. **Deployment Protection must be on before the first preview ships** — an unprotected preview URL is a leaked credential and an instant reject (G10/R16).
