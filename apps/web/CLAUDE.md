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

`VITE_API_BASE_URL` (**not** `NEXT_PUBLIC_*` — those are dead in a Vite build and fail silently) sets the API origin; `packages/contracts/src/http-client.ts` appends `/v1`. **Unset in a browser it is now SAME-ORIGIN — a relative `/v1/...`** — and unset in Node it is `http://localhost:3000`, the port the API actually listens on. That split is new, and it is a bug fix: the fallback used to be localhost for both, so the Vercel build called `http://localhost:3000/v1/me` from every *visitor's* browser. The request failed as a transport error rather than a 401, `useSession` read that as 'degraded', and the hosted app served seed data with the badge suppressed in a production build. Dev never caught it because `.env.development` sets `VITE_API_BASE_URL=` to the EMPTY STRING, which is not `undefined`, so `??` never reached the fallback. Pinned by `src/api/http-base-url.test.ts` — that test fails against the old default. (The Node value said 3001 until PR #82, copied from the spec's `servers` block, which was itself wrong; nothing has ever served 3001.)

**In dev mode the API is on by default and same-origin** (METH S6). `.env.development` — committed, re-included by `apps/web/.gitignore` against the root `.env.*` rule because it carries two public flags and no secret — sets `VITE_API_ENABLED=true` and `VITE_API_BASE_URL=` **empty**: the http-client then builds relative `/v1/...` URLs and the Vite dev proxy (`vite.config.ts`) forwards them to `:3000`, so the session cookie is first-party and no CORS surface has to exist — the API deliberately has none. `NT_DEV_API_ORIGIN` repoints the proxy when `:3000` is taken. Vitest (mode `test`) and `pnpm build` (mode `production`) never load the file, so tests and built bundles stay synthetic unless configured; opt out per-machine with `.env.development.local`. The API side must run `AUTH_MODE=session` or the /me probe fails and the app degrades to seed data with a dev badge rather than showing a login wall nobody can pass.

### The session and the login wall (METH S6)

`src/api/auth.ts` owns the workspace session: `useSession` wraps `GET /me` into a five-state `SessionState`, and **'degraded' is the load-bearing one** — a 401 is "nobody is signed in" and shows `LoginView`; anything else (unreachable API, 5xx, contract drift) renders the workspace on seed data with a dev-only badge, because a login screen against a dead API is a wall nobody can pass (METH_MODE §8: degrade to fixtures, never to blank). `AppContext` reads it at the top of the provider — the address (`portal`) is derived first, because the session query is enabled only for `API_ENABLED && portal === 'accountant'`: a client on an SMS-link surface has no workspace session and their browser must not go asking for the practice's data. The gate itself lives in `App.tsx`, after the portal branch and never covering it. `LoginView` and `ContextHeader` (the §13.3 strip: user, role, scope, user menu with logout) are both lazy — the header additionally mounts only when the session state is not 'off', so synthetic mode never downloads it; that laziness is what holds the worst route under budget (see *Bundle*).

### The hydration architecture (METH S6)

`src/api/slices.ts` is the vocabulary: every slice on the demo route (`documents | chases | proposals | bankTransactions | publishes | businesses`) reports where its data came from — `'api'`, `'seed'` (synthetic mode, or not wired yet), or `'seed-fallback'` (asked and failed; the screen degrades to seeds and `DataSourceBadge` names the failure, dev builds only). `AppContext` exposes the map as `slices`; wired screens (Stages 7/11/12) mount the badge from it rather than letting fixtures impersonate server truth. The API queries are gated on the session being 'authenticated' — before login they would only 401. The `businesses` slice (`src/api/businesses.ts`, reading `GET /businesses` — the server half went in with this stage, `modules/auth-tenancy`) is the proof: unlike `documents`/`transactions` it fills no seed array (nothing mutates a business client-side), so the provider selects between server rows and `deriveBusinessSummaries(clients, documents)` — the same contract shape derived from seeds, pinned by test to still parse as the contract. `src/api/envelope.ts` holds the shared `unwrapBody` — every api-layer parse goes through it, **including `documents.ts` since METH S7 fixed the `query.data.data` bug** (see the envelope note below).

**Three slices fill AppContext from the API; two more read it from their own view chunks (METH S12); the rest do not.** `AppContext` is still driven by the synthetic generators in `lib/seed.ts`, `lib/seed2.ts` and `lib/generate.ts` — except `documents` (`src/api/documents.ts`), since METH S11 `transactions` (`src/api/bank.ts`), and since METH S6 `businesses` (`src/api/businesses.ts`).

**METH S12 wired `chases` and `proposals` WITHOUT touching AppContext, and that placement is load-bearing.** `src/api/chases.ts` (chases + the demo SMS outbox) and `src/api/proposals.ts` (the live approval queue over `GET /action-proposals`, the contract delta issue #140 added) are imported by the lazy view chunks only — a fill effect in AppContext would have put their generated clients on the bundle floor, which had 0.1 kB of headroom when this stage started (see *Bundle*). Consequences someone will otherwise rediscover the hard way:

- `slices.chases`/`slices.proposals` in AppContext stay `'seed'` — a statement about the CONTEXT ARRAYS, which really are still synthetic and still feed `statsFor`, chat cards and ClientsView. The wired views compute their own `sliceStatus` from their own queries and wear their own `DataSourceBadge`; a live-query failure degrades that view to the synthetic board with the badge on (`ChasesView` is the worked example — `SyntheticChasesBoard` is the fallback, `ChasesLiveBoard` the live surface).
- The live Chases board is deliberately its OWN read-only surface, not the synthetic composer fed with server rows: the composer's actions (reminders, item staging, policy) have no contract yet, and buttons whose writes the next poll reverts are worse than absent. Both `chases.ts` hooks poll at 5 s because the beats they exist for (a chase.send approval landing in the outbox; the pipeline auto-closing a chase after a portal upload) happen outside this browser.
- `proposals.ts` deliberately uses the plain `listActionProposals` function inside its own `useQuery` instead of the generated hook/queryKey machinery: `bank.ts` (floor) already pins the generated action-proposals client module into the shared chunk, so every extra export touched from it ships on every route. Read the comment on `QUEUE_QUERY_KEY` before "cleaning this up" to the generated hook.
- `LiveProposalCard` is the live Review → Approve card: [Read review] calls `POST …/review` and renders EXACTLY the server's sections (fail-closed — a section it cannot render withholds Approve), Approve echoes the returned hash, Cancel is the contracted cancellation. `ProposalFlowModal` wraps create-then-card for the two S12 flows: routing an Unrouted document (`UnroutedQueue` in InboxesView — unrouted rows are the contract's `businessId: ''` placeholder, filtered OUT of the inbox lists and INTO the queue) and retrying a failed publish (a fresh `publish.batch` over the one document — Stage 10's retry path; extraction failures instead get a disabled-with-tooltip Retry pointing at the chase engine, because `document.reprocess` has no executor yet). Closing the modal undecided is fine: the proposal stays pending and appears in the Approvals queue, which is the point of having one.
- `ApprovalsLiveQueue` keeps decided cards mounted showing their outcome banner — the settle refetch removes them from `proposals`, and without that the approval confirmation unmounted the instant it appeared (caught by the S12 browser smoke, invisible to unit tests).
- `Document.failureCode` (the API's stable `NT-*` code) now crosses the boundary, and `lib/failures.ts` prefers it for the extraction-vs-publish call: every API row has `fields: []`, which the old field-count heuristic read as "never extracted", branding every publish failure an extraction failure. Same fix corrected `publishFailed` (it was `state === 'FAILED'`, which is extraction; a failed publish is `REJECTED` + `NT-PUB-*`).
- ⚠ `getChaseResponse` is orval's strict-intersection `allOf` gap (see `packages/contracts/CLAUDE.md`): the generated schema rejects every valid `Chase`. `chases.ts` parses the two halves separately (`parseChaseDetail`), pinned by test; a detail that still fails degrades to its list-validated summary with items/messages withheld rather than felling the board (known case: seeded `chs_003` serves `items: []` against the contract's `minItems: 1` — flagged as a pass-3 contract question).
- The outbox panel builds the tappable link with `portalPathFrom` — last path segment of whatever followed `Upload securely: `, re-homed as `/p/<token>` — and opens it in a phone-sized window (the demo's "client's phone" beat). The first two fill the array every existing mutator already writes to rather than becoming a second source beside it: the pipeline derives approvals, chases, duplicates and every client statistic from those arrays, so a parallel list would have half the app disagreeing with the other half about what exists. All are behind `VITE_API_ENABLED` — and, since S6, additionally gated on the session being authenticated (see *The session and the login wall* above); when the gate is shut the query never runs and the seeds stand. Outside `AppContext` entirely, the chase portal (`/p/:linkToken`, METH Stage 9) is fully wired — see *Client-facing surfaces* below. It was deliberately the first full surface: it is the narrowest, its three operations are contracted, and nothing else in the app derives anything from it, so it could move without taking the pipeline's derived state with it.

### The chat, and where classification actually happens

**The canned intent table is gone.** With a live session `InputRow` calls
`requestChatTurn` (`src/api/chat.ts`) → `POST /v1/chat/turns`, and the server's
§9 runtime (`apps/api/src/modules/chat-framework`) does the classifying with the
pinned model, grounds questions in the client's own RLS-scoped records and
returns the intent plus any draft. `src/lib/demoIntents.ts` keeps only its
display-tier composition helpers; `matchDemoIntent` and `parseDemoRule` no
longer exist, and nothing in the browser classifies an utterance.

Three consequences worth knowing before you touch this path:

- **`classifyLocally` is the SYNTHETIC path only.** It still runs when
  `API_ENABLED` is false or there is no session, because the app must walk
  through end to end with no API (METH_MODE §1). It is not a fallback for a
  live failure.
- **A live failure is rendered honestly, never re-classified locally.** §9.3's
  floor is an honest error with a retry. Falling back to the regex would put an
  answer on screen that looks identical to a model answer and was produced by a
  keyword match — the exact confusion the `DataSourceBadge` architecture exists
  to prevent. `requestChatTurn` returns a `failure` with the `NT-` code in front
  of the words.
- **The server's intent enum maps near-identically** to the app's
  (`SERVER_INTENT_TO_APP`), because the contract enum was chosen to match the
  names the LIVE cards already render. It is `satisfies Record<ChatTurn['intent'],
  string>`, so a new server intent breaks the build here rather than silently
  rendering a GENERAL card.

The LIVE cards themselves are unchanged and still stage real proposals. What
each does, and the decisions inside:

- **`LIVE_MISSING`** (`LiveMissingCard`) — read-only, instant (SoT §8.2): the
  unmatched, non-suppressed transactions from the live bank slice (the same
  set server-side detection reads — `isMatched` + `chaseSuppressed`, never a
  re-derivation) plus the open chases from `useChases`, drillable into the
  Chases board.
- **`LIVE_CHASE`** (`LiveChaseComposerCard`) — item checkboxes over the same
  unmatched set, an editable E.164 recipient (prefilled from the synthetic
  namesake client; there is no /v1/contacts read surface), a client-side
  draft in the SoT §8.2 copy shape, then `LiveProposalFlow` stages a real
  `chase.send` proposal. ⚠ Composition belongs SERVER-SIDE ("never free-typed
  by a caller", the contract's words) and the portal link cannot be signed
  here, so the body carries a tokenless `/p/` path — the S8/S9 compose-seam
  gap, sharpened in `apps/api/src/modules/chase/CLAUDE.md` and on the PR:
  the outbox tap into the portal (demo beat 6 → 7) needs that seam.
- **`LIVE_RULE`** (`LiveRuleCard`) — the wow beat. The draft now arrives from
  the SERVER, already contract-ready: `drafts.ts` in `chat-framework` re-cases
  the supplier from the client's own documents (the single-tier match compares
  `scopeKey` against `extraction.supplierName` exactly, so "bidfood" typed in
  chat must become "Bidfood" or the rule fires never) and refuses any category
  not on that client's synced chart of accounts — refuses, never fuzzy-matches,
  because a near-miss is how food costs quietly become drink costs. Staging
  creates a real `rule.create` proposal; approval writes the `rules` row the
  extractor honours on the next matching upload. `categoryName` in the card's
  payload carries the CODE: the human-readable rendering is the server's, at
  Read review, and a prettier label invented here would be a second description
  of the same rule that could disagree with it.
- **`LIVE_PUBLISH`** (`LivePublishCard`) — Ready costs for the picked
  business, pre-filtered by a courtesy mirror of the publish minimum (the
  server refuses `NT-PUB-001` regardless), placeholder preview the engine
  DISCARDS — Read review renders the server-computed totals (METH S10).
- **Navigation intents** reuse existing surfaces: "show everything to review"
  → `SHOW_INBOX` + `statusFilter` (a new optional prop on `InboxTable`);
  "open the Currys receipt" → `REVIEW_DOCUMENT` with the supplier-resolved
  `documentId` (in-review copy preferred).

**`LiveProposalFlow` stages on an EXPLICIT click, never on mount** — a chat
message remounts every time its conversation is reopened, and
`ProposalFlowModal`'s create-on-mount pattern would mint a proposal per visit.
A card remounted after staging shows its draft again; the staged proposal is
pending in the Approvals queue, which is the point of having one. Approve
still cannot mount before Read review — the flow hands off to
`LiveProposalCard`, which renders only the server's own review.

When the server's turn carries `navigation.businessId`, `InputRow` rewrites the
message scope to that SERVER id — live rows key on `biz_*` ids, which the
synthetic-client scope from `resolveScope` can never match.

**Utterance → intent is no longer pinned here, and that is the point.** It is
measured in `evals/` against the real model, which is the only place an
accuracy claim about a model means anything — a regex pinned in a browser unit
test measured the regex. `demoIntents.test.ts` keeps only the display-tier SMS
copy, money/day formatting and E.164 normalisation. Last live calibration
(`anthropic.claude-opus-4-6-v1`, eu-west-2, 21 Aug 2026): intent 92.3%, field
100%, zero injection leaks. Verified end-to-end against deployed staging: the
Bidfood rule beat returns a complete `rule.create` draft, and a grounded
question answers from real seeded records with citations.

**The documents surface went deep in METH Stage 7 (#137).** Beyond the hydrated list (whose parse is FIXED — it read `query.data.data` and failed on every live load; see the envelope note below — and which now POLLS every 5 s while live, because documents arrive from WhatsApp/email/portal/workers and the inbox is where they are watched landing; TanStack structural sharing makes an idle poll re-render nothing, and `enabled: false` keeps tests timer-free):

- **Detail** — `src/api/document-detail.ts`: `useDocumentDetail` reads `GET /documents/{id}` + `/original` + `/events`, maps the accepted extraction to the overlay's shape (per-field confidence + provenance class, §13.3; Category answered from the header with the extract event's `sourceRuleId` as its honest provenance), and polls at 2.5 s while the document is processing. Deliberately NOT in `documents.ts` — that module is on every route's floor and this one is heavy with the strict extraction Zod; it lands on the document screens' chunks. `DocumentPreview` renders it when live: the real original via the presigned URL (no provenance band painted over a real photograph — bounding boxes are not extracted yet), an "open the original" link for non-images, the processing log, and the loading/error states.
- **Corrections** — a typed edit stages a real `document.update-coding` proposal in a lazy `CodingProposalCard` (the same `ReviewGate`, so Approve cannot mount before Read review here either), via the same three-call create → review → approve-echoing-the-hash shape as `confirmMatchProposal`. `parseCodingDraft` is the pounds→pence boundary for typed money and refuses (by named reason) what the contract would. Fields the contract has no correction path for (e.g. VAT number) lose the edit affordance rather than discovering the refusal on approve; so does a PUBLISHED document (locked server-side).
- **Uploads** — `src/api/uploads.ts`: drag-drop/file-picker becomes the real intent → presigned `PUT` → complete journey (`runWorkspaceDrop`, shared by `InboxesView` and `ClientInbox`), then the poll shows Processing → Ready live. The inbox-level drop REQUIRES a chosen client in live mode — the API's own rule; guessing at ingest time is the misrouting the product exists to fix. The business id the views send comes from the context's `serverClientIdFor` since METH S14 (see *The seed↔server id bridge* below); `uploads.ts`'s `serverBusinessIdFor` remains as the fixture convention's home and the bridge's fallback.

Two things about the bank slice that will bite the next person:

- **A server transaction has no `matchedDocId`.** The contract's `BankTransaction` carries `matchState` and not the id of the document that matched it, and that id is used elsewhere as a real key — `lib/matching.ts` builds a `claimed` set from it so one receipt cannot answer two lines, and `ClientApprovalView` looks a transaction up BY it. A placeholder would corrupt both, so it stays `undefined` and **`isMatched()` in `lib/matching.ts` is the one place the two signals are reconciled**. Use it; do not branch on either field directly. The missing id is a contract change for Shakib (G7).
- **Confirming a match goes through Review → Approve, in three calls** (`confirmMatchProposal`): create, review, approve echoing back the review's `renderedSummaryHash`. Approve is unreachable until the review has been opened and that is enforced server-side and again by a database trigger, so the middle call is not a convention that can be skipped. The optimistic local update stays for the click to feel instant; the refetch afterwards replaces it with server truth, so a refusal corrects the screen rather than leaving a match only this browser believes in. The coding correction follows the identical pattern.

The suggestion engine in `lib/matching.ts` stays **display-tier**: its arithmetic is float pounds, it never reaches the server, and nothing server-side applies a tolerance derived from it. Flagged for a post-demo rewrite in pence.

### The seed↔server id bridge, and the live gating sweep (METH S14)

Stage 14's hardening audit found the golden path broke against a **freshly reset** DB, and the reason is worth keeping: the synthetic cast keys clients as `'1'`/`'2'`, the MSW fixtures bridge them as `biz_1`/`biz_2`, and the real seed's businesses are `biz_burger`/`biz_cosmo`/`biz_dental` — earlier stages smoked against a stale shared DB and never met the real ids, so uploads and Unrouted routing were refused server-side and every client-scoped filter (ClientInbox, the embedded BankView) matched nothing after `pnpm demo:reset`. The fix lives in `AppContext`: `serverClientIdFor(clientId)` joins the seed clients to the hydrated `businesses` slice **by normalised name** (case, punctuation and a trailing Ltd/Limited dropped — the name is the only fact both casts share), falling back to the `biz_<id>` fixture convention when the slice has not answered; `isSameClient(rowClientId, clientId)` is the tolerant compare every client-scoped filter now uses (`InboxesView`, `ClientInbox`, `BankView`); and `clientNameFor` answers an opaque id from the hydrated slice before falling through to the id itself. The bridge still retires when the clients list itself reads from `GET /businesses`.

The same sweep enforced the S12 rule everywhere: **a button whose write the next poll reverts is worse than absent.** Live (`documentsSource === 'api'`, or `slices.bankTransactions.source === 'api'` on the bank surface), the local writers are hidden or disabled-with-tooltip pointing at the real path: InboxesView publish / mark-reviewed / move / delete (the publish tooltips name the chat utterance), ClientInbox's `nextStep` and bulk bar (the client-side CSV export stays — it is real either way), BankView's cash-code, synthetic chase composer and Matches tab (live it says where matches actually live), DocumentsView's unarchive/move, and both duplicate-resolution footers (an informational note — the executor ships post-demo). ApprovalsView's fixture summary figures and inert client filter give way to a live count over the queue. BankView, ClientInbox and DocumentsView gained the loading/error banner + `DataSourceBadge` the other wired screens already had. `errorLabel` in `api/slices.ts` is the one failure-label maker now — it keeps the `NT-` code in front of the words (frontend ten, item 5), and `sliceStatus`, the degraded session state, `documentsError` and the outbox error all go through it. `DocumentPreview` lost the handler-less "Enter manually" button and no longer formats `To Review — {note}` with an undefined note, which was a react-intl `console.error` on every live To-Review detail and on the duplicate beat.

MSW is started from `src/main.tsx` behind a **dynamic** `import()`, which is what keeps it and `@faker-js/faker` out of the production bundle. Verified: neither string appears in `dist`. Keep it dynamic.

There is no chat proxy and no escape hatch. `VITE_CHAT_PROXY` and the `POST /api/chat` call to the pre-monorepo frontend's Gemini classifier were removed with issue #59: `server.ts` never came across in the import, so the route did not exist and the call could not succeed, while the deterministic classifier in `lib/resolver.ts` was already producing the answer. That ends the D22/D28 (Bedrock, eu-west-2) and D30 (UK-first residency) exception structurally rather than resting it on a flag default — chat reaches a model again only through the Bedrock-backed surface, which belongs to `chat-framework`, not to this component.

**There is exactly one raw `fetch` in `src/`, and it does not call the API.** `src/api/upload-transport.ts` (`putBytes`) `PUT`s uploaded bytes to the presigned storage URL the API just handed over — for BOTH surfaces that send bytes, the OTP portal and the practice workspace, which is why it moved out of `portal.ts` in METH S7 into its own module (the practice screens must not import the portal's journey to PUT a file, and vice versa). That request goes to the object store, not to Neoting, and its signature covers the method, the URL and the headers exactly as issued — `ntFetch` would prefix `/v1`, attach `credentials: 'include'`, add an `Idempotency-Key` and an `Accept`, and the signature would stop matching. No credential of ours travels there. It is in the api layer, never in a component, and the rule above ("never `fetch` raw in a component") holds unchanged.

### ⚠ The generated client's response envelope does not exist at runtime

orval's fetch client types every operation as `Promise<{ data: T, status: 200 }>`. The mutator all of them go through — `ntFetch` in `packages/contracts/src/http-client.ts` — returns `await response.json()`, i.e. **the body itself**. So `result.data` typechecks and is `undefined` at run time unless the body happens to have its own `data` field.

Every api-layer module therefore reads the awaited value as `unknown` — through `unwrapBody` (one definition, in `documents.ts`, which handles both shapes so it stays right if the mutator ever changes) — and lets the Zod schema decide, which is the rule anyway. `documents.ts` shipped violating this (`query.data.data`), so with the API enabled every inbox load reported a contract error instead of rendering; fixed in METH S7 with the both-shapes test in `documents.test.ts`.

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

**What the SMS must contain.** The link the chase composes has to be `<web origin>/p/<linkToken>`. The API composes the SMS body (`sms-copy.ts`, marker `Upload securely: `) and today the token is put in bare; whoever wires the demo outbox must build the full URL, or the tap goes nowhere. The link-entry screen accepts either — it keeps the last path segment of whatever is pasted — but that is a fallback for a mangled text, not the design. Until the engine-side compose seam exists (the known gap in `apps/api/src/modules/chase/CLAUDE.md` — no outbox SMS carries a *working* token today), `pnpm demo:portal-link` (`scripts/demo/portal-link.ts`, METH S14) signs a real token for a real chase; the demo script's beat 7 enters the portal through it.

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

| | METH S6 | METH S12 | METH S13 | METH S14 | now (§9 chat) |
|---|---|---|---|---|---|
| `index.js` (shared, incl. the 0.1 kB entry stub) | 188.3 kB | 179.3 kB | 179.4 kB | 179.6 kB | **180.1 kB** |
| `query.js` (TanStack) | 14.7 kB | 14.7 kB | 14.7 kB | 14.7 kB | 14.7 kB |
| `react.js` | 1.5 kB | 1.5 kB | 1.5 kB | 1.5 kB | 1.5 kB |
| **shared JS floor, every route** | **204.5 kB** | **195.5 kB** | **195.6 kB** | **195.8 kB** | **196.3 kB** |
| heaviest route on top (`ClientDetailView`) | 45.1 kB | 45.2 kB | 45.2 kB | 45.7 kB | **45.7 kB** |
| **worst route, total JS** | **249.6 kB** | **240.7 kB** | **240.8 kB** | **241.5 kB** | **242.0 kB** |
| `index.css` (not in the JS budget) | 13.3 kB | 13.3 kB | 13.3 kB | 13.1 kB | 13.1 kB |

**The §9 chat runtime cost the floor +0.5 kB, and unlike S12's slices it is ON
the floor deliberately.** `src/api/chat.ts` is imported by `InputRow`, which the
shell always mounts, so the generated chat client cannot live on a lazy chunk
the way `chases.ts` and `proposals.ts` do — the chat input is the shell. The
trade was worth naming: +0.5 kB of floor bought the removal of the whole
client-side classifier, and `AIWorkspaceView` came DOWN 32.9 → 32.4 kB because
the canned table and its regexes went with it. Worst route 242.0 kB against a
250 kB budget — 8 kB of headroom, the most there has been since S12.

METH S13's whole surface (the canned table, four live cards,
`LiveProposalFlow`, the InputRow wiring) cost the floor **+0.1 kB** (the
`READ_ONLY_INTENTS` addition in the floor-resident types) and landed on the
AIWorkspaceView chunk, now 32.9 kB — chat + floor = 228.5 kB, under budget.
`demoIntents.ts` and the cards import only modules already floor-resident
(`resolver`, `matching`) or lazy-chunk-resident (`proposals.ts`, `chases.ts` —
shared chunks with the S12 views, per the reachability rule below).

S14's +0.2 kB floor is the id bridge + `errorLabel` in AppContext/slices; the
+0.5 kB on `ClientDetailView` is the gating and banners in the embedded
BankView/ClientInbox. The chat route is unmoved (AIWorkspaceView 32.9 kB).
Headroom at the worst route: **8.5 kB**.

**The headroom is ~9.3 kB, and METH S12 is where it came from.** The stage arrived at 0.10 kB of headroom, its own additions initially put the floor +0.5 kB over (the generated action-proposals list exports joining bank.ts's floor-resident module copy, plus six generated Zod schemas hoisted into `index` because the zod barrel is statically reachable from floor modules), and the reclaim that paid for it all is `strip-zod-describe` in `packages/contracts` — orval was copying the spec's design prose into the runtime Zod, ~10 kB gzip of it on the floor. After the strip, S12's whole surface (chases + outbox + proposals queue + unrouted + retry) nets the floor **9.25 kB BELOW** the S7 line. Numbers are exact gzip bytes of the built chunks (`gzip -c | wc -c`) — the S6 convention. ⚠ Measure with a CLEAN environment: sourcing the repo `.env` into the shell before `pnpm build` sets `NODE_ENV` and Vite quietly produces a development-flavoured bundle ~25 % larger, which reads as a regression that is not there.

Two chunk-placement facts S12 measured, for the next stage that wires a surface:

- **A module's chunk is decided by REACHABILITY, not by usage.** The zod/client barrels are statically imported by floor modules, so every generated sub-module any lazy chunk touches gets hoisted into `index` — a lazy import does not keep generated code off the floor once its barrel is floor-reachable. The marginal cost is per-EXPORT, which is why `proposals.ts` calls the plain generated function inside its own `useQuery` rather than pulling the hook/queryKey machinery.
- The rest of S12 (`chases.ts`, the view boards, `LiveProposalCard`, `ProposalFlowModal`) landed on lazy chunks as intended: ChasesView 16.7 kB, ApprovalsView 15.5 kB, InboxesView 13.8 kB, `LiveProposalCard` 3.1 kB shared between the Approvals and Inboxes chunks.

**Measure before you merge, not after.** A route over budget is a reject (D37), not a warning. The remaining known reclaims: the seed dataset (~67 kB source) leaving the floor when the remaining views move onto the generated client, and the `defaultMessage` strip when a second locale lands. The portal is still the lightest client-facing route by a wide margin — keep it that way: no heavy dependency, and nothing it imports may become shared with a practice screen (`upload-transport.ts` is the sanctioned shared seam, and it is 0.6 kB).

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
| `src/api/documents.test.ts` | The pence↔pounds boundary, round-tripped exactly, and the enum tables pinned against `DocumentState` / `DocumentChannel` from the contract — a value added to the spec fails here rather than rendering as something plausible. Since METH S7 it also pins the envelope fix: the hook's exact parse composition accepts the raw body the mutator returns AND the envelope the types describe, and `unwrapBody` never strips a body whose own fields merely look like one. |
| `src/api/document-detail.test.ts` | Money crossing in BOTH directions: extraction pence rendered as pounds, and a typed correction (`1299`, `£1,299.00`) becoming integer pence with every refusal named. Plus the §13.3 mapping — provenance classes, the corrected-value flip to human-confirmed, Category's rule-vs-AI answer — and the label pins the readiness rules match on byte-for-byte. |
| `src/api/uploads.test.ts` | The workspace upload boundary, recorder-fetch style like the portal's: our two calls under `/v1` with the cookie and an `Idempotency-Key`, the bytes raw to the storage host with the signed headers verbatim and no credential, the completion hash being the SHA-256 of what was actually sent, and a storage refusal never being reported as a completed upload. |
| `src/api/bank.test.ts` | The contract's **signed** pence becoming the unsigned pounds the screen renders with the direction in `isCredit` — a sign convention that looks right in a demo and silently files every refund as a payment. Plus `isMatched`: `SUGGESTED` is a question and not evidence, and a server row never invents a `matchedDocId`. |
| `src/api/chases.test.ts` | The chase boundary (METH S12): the strict-intersection pin (`getChaseResponse` refuses a VALID body — when orval fixes it this fails and the halves workaround gets deleted), the open/closed split pinned against the contract's `ChaseState`, signed pence → unsigned display pounds, Europe/London instants, and `portalPathFrom` re-homing whatever the SMS carried as `/p/<token>`. |
| `src/api/proposals.test.ts` | The queue boundary (METH S12), recorder-fetch style: `KIND_LABEL` total over the contract's `ProposalKind`; [Read review] returning the sections and the hash; a section the card cannot render failing the WHOLE review (no Approve out of a half-read card); approve echoing the hash verbatim; create parsed by the contract schema with drift named. |
| `src/lib/demoIntents.test.ts` | The demo script itself (METH S13): the five scripted utterances land on their live intents with the right payloads — the Bidfood rule draft byte-exact against what the extractor honours — dictated variants land too, and unknown input falls through to the graceful card. Plus the SMS draft's copy shape, money/day formatting and E.164 normalisation. |
| `src/lib/spreadsheet.test.ts` | Money parsing (`2.000,00` is two thousand), quoted CSV fields, and the Net·VAT·Total column race. |
| `src/lib/tableImport.test.ts` | XLSX date serials, day-first UK dates, totals lines refused rather than booked, signed ledgers where a positive row is a refund. |
| `src/lib/matching.test.ts` | Whether a transaction is settled or handed to a human, and the merchant bar that keeps Costco off Costa. |
| `src/lib/dedupe.test.ts` | The two Dext gaps this exists to close: a pair survives a failed extraction, and an invoice matches its receipt twin. |
| `src/context/AppContext.test.tsx` | The #87 regression: nine rapid route changes with conversation churn interleaved, asserting the tree survives, the address is not yanked back mid-render, and no setState-during-render warning fires. The one suite that renders the whole shell. |
| `src/api/portal.test.ts` | The delegated boundary, with `globalThis.fetch` replaced by a recorder. Pence→pounds signed and exact; the merchant → raw-descriptor → nothing fallback; a code that is not six digits refused **before** the network; a float in a pence field refused **after** it; and the two rules that make the session safe — the bearer goes to the API on all three of our calls, and it does **not** go to the storage host on the presigned `PUT`. |
| `src/views/business/ChasePortalView.test.tsx` | The fallback demo path nobody exercises by hand: `/p/<token>` reaches the portal and not the practice app, the six-digit gate is real in the UI, and passing it lands on the item list. |
| `src/lib/capture.test.ts` | The pure half of the compression path — bytes out of a data URL exactly as they went in (including a JPEG header that is not valid UTF-8), and the `.jpg` renaming. The encode itself needs a canvas, which jsdom has not got. |
| `src/lib/useEscape.test.tsx` | The Escape stack: with dialogs nested (DuplicateModal → ConfirmStep), one keypress closes the top layer only, a closed-but-mounted viewer does not shadow the layer below, and the handler read is the latest render's. Invisible in manual testing until someone loses two layers to one Escape. |
| `src/api/auth.test.ts` | The session boundary. 401 and "the API is down" are DIFFERENT states — the first shows LoginView, the second degrades to seed data — and collapsing them turns every transient outage into a lock-out. Plus: a /me body that drifts from the contract never authenticates, login carries `credentials` (the cookie is the whole session), and logout never throws. |
| `src/api/businesses.test.ts` | The synthetic half of the businesses slice: the counting rules, and — the actual point — that the derived fallback rows still PARSE AS THE CONTRACT, so a screen reading the slice cannot tell the worlds apart. |
| `src/views/LoginView.test.tsx` | The front door's gate refused BEFORE the network (all three credentials, TOTP exactly six digits), the error state wearing its `NT-` code, and an unreachable API saying so instead of blaming the credentials. |
| `eslint/no-literal-string-in-jsx.test.js` | The one suite that tests a *gate* rather than the product: real copy still fails the literal rule, punctuation still passes. The cases are lifted verbatim from the views. Not under `src/`, because the rule is not application code — which also keeps it out of `tsc`'s include and out of the bundle. |

Component tests are still owed for anything with logic (frontend ten, item 10) — the AppContext suite is the first, not the last.

`vitest.setup.ts` shims what jsdom lacks and the app really uses. Four entries now: `matchMedia`, `ResizeObserver`, `scrollIntoView`, and `Blob.prototype.arrayBuffer` — jsdom 25 still has no `arrayBuffer()` (nor `text()`), and the portal reads the bytes it is about to upload in order to hash them. The shim is built out of jsdom's own `FileReader`, so it is a real read rather than a stand-in, and it is `??=`-guarded like the others so a jsdom that grows the method wins.

**Lazy routes need `findBy*`, not `await act(async () => {})`.** A `React.lazy` chunk does not resolve inside a microtask flush, so an `act` flush leaves the skeleton on screen and every query fails against it. `ChasePortalView.test.tsx` waits on `screen.findByRole` — still offline, because the only thing being waited on is a dynamic `import()`. This is also why `AppContext.test.tsx` can only assert that `#root` is non-empty: what it is looking at is the skeleton.

## Previews

Vercel previews are a **viewing tool, not hosting** (G6). Synthetic data only. **Deployment Protection must be on before the first preview ships** — an unprotected preview URL is a leaked credential and an instant reject (G10/R16).
