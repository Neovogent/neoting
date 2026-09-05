# apps/web — Vite + React 19 SPA

**This is not a Next.js app.** D37 (SoT v1.5) replaced the App Router plan with the built Vite SPA. There are no route groups, no server components and no `app/` directory — routing is a hand-rolled switch in `src/App.tsx` over a `view` in `AppContext`, with every screen behind `React.lazy`.

**`/` is the public landing page, and the workspace root is `/app` (launch stage M3).** `views/LandingView.tsx` renders at bare `/` outside every wall — no login gate, no session probe (`portal === 'landing'` keeps `workspaceApiOn` false, so a visitor's browser never calls `/me`). Only the ROOT address moved: the tab addresses (`/clients`, `/chat/…`, `/settings`) are unchanged, `setActiveTab('AI Workspace')` navigates to `/app`, and the tour's `/demo` redirect follows it. The legal drafts in `docs/legal/` already describe the product as "the app is at /app", so the address is the agreed one, not this stage's invention. The landing page's footer carries the Companies (Trading Disclosures) identity from those drafts verbatim; the VAT registration number is a literal `[PLACEHOLDER]` until Shakib supplies it — grep before launch.

**`/legal/*` is the other public surface (launch stage M4).** `views/legal/LegalView.tsx` renders the four documents in `docs/legal/` — terms-of-service, privacy-notice, data-processing-terms, refund-and-cancellation — outside every wall, exactly as the landing does (`portal === 'legal'`, no session probe). The markdown IS the page: a build-time transform (`views/legal/markdown.ts`, run by the `neoting-legal-docs` plugin in `vite.config.ts`) turns each `.md` into a pre-rendered HTML module, so a correction in `docs/legal/` reaches the site on the next build with nothing retyped, no markdown parser ships, and — the point of doing it at build rather than at render — the drafting-aid banners and the solicitor-facing HTML comments those files carry are stripped from the shipped bytes, not merely not displayed. Each document is its own lazy chunk (the terms, the heaviest, is ~10 kB gzip on top of the ~2.6 kB view), styled by the `.legal-prose` block in `index.css`; heading ids are GitHub-slugged because the documents' own tables of contents link `#like-this`. Three things to know before touching it:

- **`[PLACEHOLDER…]` markers are highlighted, counted and warned about — never hidden.** M4's instruction is that a page with one still in it must not go LIVE; resolving them is S6 (Shakib). The build stays green but says so per document, the page wears an amber draft banner while its count is non-zero, and the tests in `views/legal/markdown.test.ts` pin the machinery without pinning the prose, so S6's edits cannot fail them.
- **The privacy notice is linked at the point of collection (UK GDPR Art. 13), not only in footers.** `views/legal/PrivacyNoticeLink.tsx` renders on the chase portal's shell (every step — link, code, photograph), the business portal sign-in, and both upload surfaces. It opens in a NEW TAB deliberately: the chase portal's bearer lives in React state and an in-app navigation would end the session mid-upload. It is a tiny module on purpose — it must never drag `LegalView` or a document chunk onto a portal route.
- **The four slugs are published addresses** (the M3 footer links them; the terms' in-page anchors assume them). Renaming one is link rot, not a refactor. An unknown slug renders the contents page rather than a dead end.

**`/signup/*` is the third public surface, and the one the other two point at (launch stage M9).** `views/signup/SignupView.tsx` is the whole practice-signup journey — the form, the check-your-email screen, the landing spot for the emailed verification link, and authenticator enrolment — outside every wall (`portal === 'signup'`, no session probe), because the visitor by definition has no account and a `/me` probe could only 401. Before it, `apps/web/src` called **none** of the four operations A1 and A14 shipped: the product had a login page and no way to reach one, and the landing page's primary button pointed a prospective customer at a wall they could not pass. See *Signing up* below, and read it before editing a word of that copy — two of its screens are constrained by what the API deliberately refuses to say.

Read `docs/Source_Of_Truth.md` D37 before assuming anything Next-shaped. The requirements that route groups used to satisfy for free did **not** go away; they became build configuration plus review conditions, and the notes in `vite.config.ts` say which is which.

### ⚠ There is ONE Vite build entry, not two

SoT D37 and §15 describe the portal as "a separate build entry", and `docs/Team_Engineering_Guideline.md` §2's repo map repeats it as `(workspace) + (portal) separate build entries`. **That is the plan, not the build.** `vite.config.ts` has a single entry and always has, and its own header comment is where the divergence was recorded honestly rather than papered over:

> *What is NOT done here, and is tracked separately: the portal is still part of this build's graph rather than a separate entry. Lazy loading keeps it out of the initial download, which is most of the benefit; a genuinely separate entry additionally needs the hand-rolled router split and a host rewrite, and that is its own change.*

So do not plan a change around a second entry that does not exist, and do not "fix" a build script that looks like it is missing one. What actually keeps the portal light today is **route-level `React.lazy`** plus the review condition in *Bundle* below — which is why that condition is not optional: it is the only thing standing where the second entry was supposed to be. Closing the gap (either by building the entry, or by amending D37 to say lazy loading is the answer) is a versioned SoT amendment and Shakib's call, not a decision this file can take.

## ⚠ Initial Delivery (ID) — what the UI may and may not say

SoT v1.6 §24 scopes the first paid client release. Five of its decisions land squarely on this app, because they are about **what a screen is allowed to claim**.

- **Never imply a ledger was written to (D42).** In ID there is no Xero, no QuickBooks and no auto-publish. *Published* is an internal state meaning **approved and released for export** — nothing more. No label, tooltip, empty state, toast, status chip or activity line may say or suggest "posted", "synced", "sent to Xero" or anything of that shape. Getting this wrong tells an accountant their books are in a state they are not, which is the worst lie this product can tell. **Launch M5 enforced this app-wide**: `Client.xeroConnected` is deleted, `SetupTask` is `'profile'` only (D47), the client Integrations tab and the Settings Connections section are gone (the setup-link panel moved to the client's Settings tab), the publish surfaces say "Release for export" / "VT Transaction+ import file", and `grep -ri ledger apps/web/src` matches only comments plus the contract's own `LEDGER_TXN_NO_ATTACHMENT` enum key (LAW — its on-screen label is honest). The demo cast's second client is **Ananda Group** (the upstream rename of Cosmo Restaurants, now carried across), and the synthetic chase SMS previews carry the real `<origin>/p/…` link shape instead of a `sec.ure` fake.
- **Export is the visible endpoint of the journey (D42/D43)**, and the accountant must be able to reach the **source document from an exported line**. The export surface is not a settings-page afterthought in ID; it is where the release is judged. It is built — see *The export screen (launch stage A9)* below, including the one reason it is not yet reachable from the shell.
- **Two authorities, and the UI must not be the enforcement (D44).** Accountants and their team compose and edit — chase text, coding, every extracted field. Only the firm's **super admin** releases Ready → Published, singly or in bulk. Hiding a button is presentation; the server check is the rule, and the screen must degrade honestly for a user who lacks the permission rather than pretending the action does not exist.
- **Flag, never block (D46).** A document the AI judges unacceptable still uploads, in both the practice app and the client portal. The flag is information for a human, not a gate — and a batch is shown as the individual documents it actually contains.
- **D49: the prototype UI repo is ID's design source of record** — `MubasshirrKan/ai-accounting-operations-platform`. Check it before inventing a surface that already has an implemented reference.
- **There is no SMS, and since launch M8 the app says so everywhere.** S2 made email the transport and A13 sends chases through it, so the M8 honest-copy pass swept every claim of texting: the chase surfaces, the chase portal (`/p/…` — "Your accountant emailed you a link"), the tour prose, the approval/workflow labels, and `lib/channels.ts`, whose `SMS_ONLY` list is now **empty** — the seam and its generated sentences survive the channel's return unchanged. `grep -riE '\bsms\b|texted' apps/web/src` should match only identifiers (`useSmsOutbox`, `sms-link`, message ids), comments, and the two honest mentions ("no SMS or WhatsApp chases"). M8 also removed the last capability lies (BankView's feed/consent/re-authorise vocabulary — statements are the only bank input, and its Accounts tab now has an empty state; the "Connect bank" permission is gone from UserInviteForm/TeamView/seeds), stopped the seeded identity presenting as a real firm's (`AppContext` empties `practiceName`/`docEmail`/`whatsappNumber` when the API is on, `DocumentsView` resolves the firm name from settings instead of the seed, `PipelineStats` declines honestly in a live build instead of rendering the seeded chart, the live chase card no longer prefills a fictional mobile, new expense claims stamp the real date), gated the Business-portal launcher button to synthetic exactly like the tour button, and gave the brand-new-practice journey honest empty states (ClientDetailView's not-found card instead of `return null`, LeftPanel/ContextBar zero-client copy, the vault's unfiltered empty message, InboxesView's add-a-client-first upload dialog).

## The frontend ten (Guideline §7.4)

1. **Split at the route.** Every screen is `lazy()`-loaded from `App.tsx` so opening one downloads one. This replaced "Server Components by default", and it inherits that rule's job: keeping per-route weight down. (Guideline v1.2 §7.4.)
2. **Tokens only** — no hex, no arbitrary px, no rgb()/rgba(). Done for colour: the palette AND the shadow/glow ramp live in the `@theme` block of `src/index.css` (issues #64, #85, #86); alpha steps derive from the base tokens via `color-mix`. Light mode is a variable redefinition plus the documented per-utility exceptions in that file. `scripts/check-colors.mjs` fails `pnpm lint` on any rgb()/rgba() literal anywhere under `src`, including the stylesheet ESLint cannot see. The prototype wrote its spotlight and shadow work as raw alpha literals; every one of them was re-expressed as `color-mix` over a palette token on the way in, which is also what makes a brand change reach the tour ring instead of leaving one stale mint value behind. ⚠ One trap worth knowing before you write a fade-from-brand keyframe: **`color-mix(… var(--color-brand) 0%, transparent)` collapses to transparent BLACK** and greys the whole ramp — that is what `--color-brand-fade` exists for, and why the `tour-ring` keyframe uses it instead of `0%`. New animation also carries a `prefers-reduced-motion: reduce` opt-out, as `.tour-spot` / `.tour-box` do.

   ⚠ **`bg-white` is the hole in this rule, and nothing lints it.** `check-colors.mjs` fails on `rgb()`/`rgba()` literals only; a Tailwind `bg-white` / `bg-zinc-100` / `border-zinc-200` / `text-zinc-900` sails straight through, and those classes are the SAME colour in both themes — so a panel built from them stays light while the shell around it goes dark. That is the defect reported against the Inboxes screen on 2 Sep 2026 ("this page should be full dark mode if in dark mode, the middle part missed that"): `InboxesView`'s main panel was one `<div className="flex-1 bg-white rounded-t-[28px] …">`, everything inside it was transparent and inherited the white, and the controls had been coloured for that white ground. Measured in the browser, dark theme: `body` was `rgb(10,10,12)` and that one div was `rgb(255,255,255)`. It is now `bg-card` and its contents use the ordinary ramp. **The shell was never the problem** — `Sidebar`, `ContextHeader`, `BottomNav` and `App.tsx` carry only `bg-ground`/`bg-card` and follow the theme in both directions.
   Two things follow. **First, the Chases board carried the identical bug and no longer does (3 Sep 2026).** `ChasesView.tsx` and `ChasesLiveBoard.tsx` were the last two `bg-white` PANELS in the app; both are `bg-card` now, along with that view's `bg-pale` sub-tab strip (`bg-raised`), its `bg-white text-black` active pill (`bg-brand text-brand-on shadow-glow-tab`) and roughly thirty controls inside them that had been coloured for a white ground. Measured in headless Chrome over CDP, dark theme: the panel was `rgb(255,255,255)` over 587,640 px² of a `rgb(10,10,12)` body and is now `rgb(22,22,26)`; light is `rgb(255,255,255)` as it always was. A DOM audit for "opaque **and light** background while `html` has no `light` class" now reports **zero** offenders on all ten workspace routes — write that audit rather than grepping, and note that it must read the background through a canvas readback, because Chrome returns `oklab()`/`oklch()` for alpha and chromatic utilities and a regex for `rgb()` silently skips a 90 %-opaque white panel.

   Three deliberate exceptions survive that audit and must not be "fixed": the chat composer (`InputRow.tsx` + `InputAffordances.tsx`) is light in dark mode on purpose and is the *only* thing the `html.light .bg-white .text-zinc-*` block in `index.css` now serves; the signup QR code is black-on-white in both themes or phones will not scan it; and the camera shutter and flash frame on the two capture surfaces are white objects, not panels. That block should shrink to nothing rather than grow. Its companion `.bg-zinc-900` / `.bg-zinc-800` rescue is **deleted** — the Chases stage pill, policy chip and Review & Chase button were its only three subjects, and a rule with no possible subject reads as a supported pattern.

   **Second, `bg-brand` is mint in BOTH themes, so ink on it is `text-brand-on`, never `text-white`** (white on mint is 1.4:1; `--color-brand-on` measures 11.7:1, and every brand control on `/chases` measures **10.13:1** in both themes). `index.css` has a `.bg-brand.text-white { … !important }` rescue, but it does not reach `hover:bg-brand` + `hover:text-white`, which is how a real 1.4:1 hover state shipped here. There is currently **no such pair left anywhere in `apps/web/src`** — grep before assuming otherwise. Several screens still lean on the rescue (`ClientsView`, `ApprovalsView`, `DocumentsView`, `DataTable`, `Sidebar`'s logomark); prefer the explicit token.

   ⚠ **One mirror-image defect is known and NOT fixed**: the settings toggle knob is `bg-white` on a `bg-white/10` track (`ChasesView.tsx`, `InboxesView.tsx`), which is invisible in **light** mode. It is not a one-line token change — `bg-white` is deliberately literal for the composer, and `bg-raised`/`bg-ground` land within a couple of RGB steps of the track in one theme or the other. It needs a knob token that inverts, which is a palette decision. Likewise `text-amber-*` / `text-red-*` have no `html.light` overrides, so dark-native ink measures ~2.6:1 in light, app-wide.
3. Chat renders **component-grammar primitives only**. If the grammar lacks a card, that is a G7 conversation, not a one-off `<div>`. The grammar is being derived from the imported components rather than imposed on them.
4. Every user-facing string through a catalogue (en-GB); the lint rule blocks literals. **Done — issue #65.** The library is **react-intl** (§12.6 leaves the library open and fixes the behaviour; react-intl is ICU-MessageFormat and framework-agnostic, which is what D37 needed). `defineMessages` per component, ids on `domain.component.purpose`, and `lang/en-GB.json` extracted from source by `pnpm i18n:extract` — **generated, never hand-edited.** Two gates, at different altitudes: `neoting/no-literal-string-in-jsx` works on source and blocks the next literal someone types, `pnpm i18n:check` works on the catalogue and blocks a message with no default, an off-convention key, a silently-overwritten duplicate id or invalid ICU. **2,846 messages** (136 local ids collapsed into 22 `common.*` ids in issue #94; the prototype port added ~490, of which ~206 were the demo tour — 192 of those came back out when the tour went English-only, see *The demo tour*, leaving exactly eight ids under `tour.*`, all of them the overlay's chrome; launch M5's Xero purge then retired ~95 connection/ledger ids; launch A9's export screen added 38 under `export.exportView.*`; M7's live intake and M9's signup journey took it the rest of the way, the latter adding 76 under `signup.*`, and `pnpm i18n:check` now reads **3,168**). Re-extract rather than trusting that figure: `pnpm --filter @neoting/web i18n:extract` rewrites the catalogue. See *i18n* below before adding a string.
5. All four states per screen: empty (teaches the next action), loading (skeletons, no spinners on primary surfaces), error (plain English + `NT-` code), success.
6. Accessibility on every PR: full keyboard path, visible focus, `aria-live="polite"` on chat updates, contrast from tokens, error text never colour-only. `jsx-a11y` (recommended set) and `react-hooks` (`rules-of-hooks` + `exhaustive-deps`) are now enforced at error in `eslint.config.js`, and the pre-existing findings are swept: backdrops are `role="presentation"` with Escape as the keyboard dismissal (`lib/useEscape.ts` — a stack, because dialogs nest; read it before adding a listener of your own), row-click targets carry real button semantics, and the three `autoFocus` uses carry reasoned disables (focus following an explicit user action is the dialog pattern, not focus theft). **Axe before review is still owed on every PR** — the linter cannot see computed contrast or focus order. The nine `exhaustive-deps` disables in `AppContext.tsx` are deliberate inventory, not fixes: each names its omitted-but-stable dep (`logAudit`, `setActiveConversationId`), and they come out together in a stable-callback sweep of that file — do not fix one in passing, and do not add a tenth.
7. Motion by the numbers (tokens `CLAUDE.md`). `motion` (Framer), not CSS transitions, for anything stateful.
8. **< 250 KB gzipped JS per route.** The portal is the lightest surface in the product and takes no heavy dependencies, ever — it must load fast on a bad connection in a car park. See *Bundle* below for where this actually stands.
9. Optimistic UI with rollback toasts. The Approve button literally cannot render before Read-review opens — the grammar enforces it; don't work around it. ⚠ **The review card's content is the SERVER's**, not this app's: `LiveProposalCard` renders exactly the sections `POST .../review` returned and `api/proposals.ts` fails closed on a section it cannot render. That is why the release review's per-document bookkeeping entry (2 Sep 2026 — the rows the VT import file will contain, built by the export's own emitter) cost **zero** web bytes and needed no component change: it arrived as more of the same `{heading, entries[{label, value}]}` sections. It also means the D42 copy rule has to hold *server-side* — `LiveProposalCard.test.tsx` reads `document.body.textContent` after opening a review and asserts the forbidden vocabulary is absent, the `ExportView.test.tsx` way, so a wording change in `render-summary.ts` fails here too.
10. Component tests for anything with logic.

## Data

`packages/contracts` generates the typed client and the MSW handlers. **Never hand-write an API type; never `fetch` raw in a component.** Data flows through the generated client and TanStack Query.

`VITE_API_BASE_URL` (**not** `NEXT_PUBLIC_*` — those are dead in a Vite build and fail silently) sets the API origin; `packages/contracts/src/http-client.ts` appends `/v1`. **Unset in a browser it is now SAME-ORIGIN — a relative `/v1/...`** — and unset in Node it is `http://localhost:3000`, the port the API actually listens on. That split is new, and it is a bug fix: the fallback used to be localhost for both, so the Vercel build called `http://localhost:3000/v1/me` from every *visitor's* browser. The request failed as a transport error rather than a 401, `useSession` read that as 'degraded', and the hosted app served seed data with the badge suppressed in a production build. Dev never caught it because `.env.development` sets `VITE_API_BASE_URL=` to the EMPTY STRING, which is not `undefined`, so `??` never reached the fallback. Pinned by `src/api/http-base-url.test.ts` — that test fails against the old default. (The Node value said 3001 until PR #82, copied from the spec's `servers` block, which was itself wrong; nothing has ever served 3001.)

**In dev mode the API is on by default and same-origin** (METH S6). `.env.development` — committed, re-included by `apps/web/.gitignore` against the root `.env.*` rule because it carries two public flags and no secret — sets `VITE_API_ENABLED=true` and `VITE_API_BASE_URL=` **empty**: the http-client then builds relative `/v1/...` URLs and the Vite dev proxy (`vite.config.ts`) forwards them to `:3000`, so the session cookie is first-party and no CORS surface has to exist — the API deliberately has none. `NT_DEV_API_ORIGIN` repoints the proxy when `:3000` is taken. Vitest (mode `test`) and `pnpm build` (mode `production`) never load the file, so tests and built bundles stay synthetic unless configured; opt out per-machine with `.env.development.local`. The API side must run `AUTH_MODE=session` or the /me probe fails and the app renders the empty workspace with a visible failure badge (launch M2 — no seed data stands in) rather than showing a login wall nobody can pass.

### The session and the login wall (METH S6)

`src/api/auth.ts` owns the workspace session: `useSession` wraps `GET /me` into a five-state `SessionState`, and **'degraded' is the load-bearing one** — a 401 is "nobody is signed in" and shows `LoginView`; anything else (unreachable API, 5xx, contract drift) renders the workspace EMPTY with a failure badge visible in every build, because a login screen against a dead API is a wall nobody can pass. (Until launch M2 this state rendered the workspace on seed data with a dev-only badge — METH_MODE §8's degrade-to-fixtures — which in a production build meant invented rows presented as real. M2 removed the fallback everywhere: with the API on, the synthetic cast never loads.) `AppContext` reads it at the top of the provider — the address (`portal`) is derived first, because the session query is enabled only for `API_ENABLED && portal === 'accountant'`: a client on an SMS-link surface has no workspace session and their browser must not go asking for the practice's data. The gate itself lives in `App.tsx`, after the portal branch and never covering it. `LoginView` and `ContextHeader` (the §13.3 strip: user, role, scope, user menu with logout) are both lazy — the header additionally mounts only when the session state is not 'off', so synthetic mode never downloads it; that laziness is what holds the worst route under budget (see *Bundle*).

### The hydration architecture (METH S6)

`src/api/slices.ts` is the vocabulary: every slice on the demo route (`documents | chases | proposals | bankTransactions | publishes | businesses`) reports where its data came from — `'api'`, `'seed'` (synthetic mode, or not wired yet), or `'error'` (asked and failed; the screen says the data could not be loaded and offers a retry — `DataSourceBadge` is the compact form, `SliceLoadError` the full-board one, both visible in EVERY build). **`'error'` replaced `'seed-fallback'` at launch M2**: the old source degraded a failed slice to the synthetic rows, which in production meant a paying accountant seeing "American Burger Ltd" with no way to know it was invented. Nothing degrades to seeds any more, and the AppContext seed initialisers are all gated on `SYNTHETIC` (`!API_ENABLED`) — with the API on, every seeded array starts empty and fills from the server. `AppContext` exposes the map as `slices`; wired screens (Stages 7/11/12) mount the badge from it rather than letting fixtures impersonate server truth. The API queries are gated on the session being 'authenticated' — before login they would only 401. The `businesses` slice (`src/api/businesses.ts`, reading `GET /businesses` — the server half went in with this stage, `modules/auth-tenancy`) is the proof: unlike `documents`/`transactions` it fills no seed array (nothing mutates a business client-side), so the provider selects between server rows and `deriveBusinessSummaries(clients, documents)` — the same contract shape derived from seeds, pinned by test to still parse as the contract. `src/api/envelope.ts` holds the shared `unwrapBody` — every api-layer parse goes through it, **including `documents.ts` since METH S7 fixed the `query.data.data` bug** (see the envelope note below).

**Three slices fill AppContext from the API; two more read it from their own view chunks (METH S12); the rest do not.** `AppContext` is still driven by the synthetic generators in `lib/seed.ts`, `lib/seed2.ts` and `lib/generate.ts` — except `documents` (`src/api/documents.ts`), since METH S11 `transactions` (`src/api/bank.ts`), and since METH S6 `businesses` (`src/api/businesses.ts`).

**METH S12 wired `chases` and `proposals` WITHOUT touching AppContext, and that placement is load-bearing.** `src/api/chases.ts` (chases + the demo SMS outbox) and `src/api/proposals.ts` (the live approval queue over `GET /action-proposals`, the contract delta issue #140 added) are imported by the lazy view chunks only — a fill effect in AppContext would have put their generated clients on the bundle floor, which had 0.1 kB of headroom when this stage started (see *Bundle*). Consequences someone will otherwise rediscover the hard way:

- `slices.chases`/`slices.proposals` in AppContext stay `'seed'` — a statement about the CONTEXT ARRAYS, which really are still synthetic (and, since launch M2, empty when the API is on) and still feed `statsFor`, chat cards and ClientsView. The wired views compute their own `sliceStatus` from their own queries and wear their own `DataSourceBadge`; a live-query failure renders `SliceLoadError` with a retry (`ChasesView` is the worked example — the error state replaced the old degrade-to-`SyntheticChasesBoard` at M2; the synthetic board now renders only when the API was never asked).
- The live Chases board is deliberately its OWN read-only surface, not the synthetic composer fed with server rows: the composer's actions (reminders, item staging, policy) have no contract yet, and buttons whose writes the next poll reverts are worse than absent. Both `chases.ts` hooks poll at 5 s because the beats they exist for (a chase.send approval landing in the outbox; the pipeline auto-closing a chase after a portal upload) happen outside this browser.
- `proposals.ts` deliberately uses the plain `listActionProposals` function inside its own `useQuery` instead of the generated hook/queryKey machinery: `bank.ts` (floor) already pins the generated action-proposals client module into the shared chunk, so every extra export touched from it ships on every route. Read the comment on `QUEUE_QUERY_KEY` before "cleaning this up" to the generated hook.
- `LiveProposalCard` is the live Review → Approve card: [Read review] calls `POST …/review` and renders EXACTLY the server's sections (fail-closed — a section it cannot render withholds Approve), Approve echoes the returned hash, Cancel is the contracted cancellation. `ProposalFlowModal` wraps create-then-card for the two S12 flows: routing a document (see *The Unrouted queue is gone* below — the `document.route` proposal now hangs off InboxesView's bulk **Move to client**, and unrouted rows, the contract's `businessId: ''` placeholder, list with everything else instead of being held back) and retrying a failed publish (a fresh `publish.batch` over the one document — Stage 10's retry path; extraction failures instead get a disabled-with-tooltip Retry pointing at the chase engine, because `document.reprocess` has no executor yet). Closing the modal undecided is fine: the proposal stays pending and appears in the Approvals queue, which is the point of having one.
- `ApprovalsLiveQueue` keeps decided cards mounted showing their outcome banner — the settle refetch removes them from `proposals`, and without that the approval confirmation unmounted the instant it appeared (caught by the S12 browser smoke, invisible to unit tests).
- `Document.failureCode` (the API's stable `NT-*` code) now crosses the boundary, and `lib/failures.ts` prefers it for the extraction-vs-publish call: every API row has `fields: []`, which the old field-count heuristic read as "never extracted", branding every publish failure an extraction failure. Same fix corrected `publishFailed` (it was `state === 'FAILED'`, which is extraction; a failed publish is `REJECTED` + `NT-PUB-*`).
- ⚠ `getChaseResponse` is orval's strict-intersection `allOf` gap (see `packages/contracts/CLAUDE.md`): the generated schema rejects every valid `Chase`. `chases.ts` parses the two halves separately (`parseChaseDetail`), pinned by test; a detail that still fails degrades to its list-validated summary with items/messages withheld rather than felling the board (known case: seeded `chs_003` serves `items: []` against the contract's `minItems: 1` — flagged as a pass-3 contract question).
- The outbox panel builds the tappable link with `portalPathFrom` — last path segment of whatever followed `Upload securely: `, re-homed as `/p/<token>` — and opens it in a phone-sized window (the demo's "client's phone" beat). The first two fill the array every existing mutator already writes to rather than becoming a second source beside it: the pipeline derives approvals, chases, duplicates and every client statistic from those arrays, so a parallel list would have half the app disagreeing with the other half about what exists. All are behind `VITE_API_ENABLED` — and, since S6, additionally gated on the session being authenticated (see *The session and the login wall* above); when the gate is shut the query never runs and the seeds stand. Outside `AppContext` entirely, the chase portal (`/p/:linkToken`, METH Stage 9) is fully wired — see *Client-facing surfaces* below. It was deliberately the first full surface: it is the narrowest, its three operations are contracted, and nothing else in the app derives anything from it, so it could move without taking the pipeline's derived state with it.

### The bell, and saved conversations (5 Sep 2026 — review items 12 and 9)

**The bell** (`components/NotificationsBell.tsx` over `api/notifications.ts`) is
the live sign of document arrival: `GET /v1/notifications` polled at 10 s + on
focus, badge = the server's whole-practice `unreadCount` (never a page-derived
count), dropdown in the ContextHeader's own hand-rolled pattern (fixed backdrop,
absolute panel, `useEscape`), "Mark all read" through
`POST /v1/notifications/read-receipts` then a refetch — server truth, never a
prediction. Rendered only in the authenticated branch and only with
`API_ENABLED` (synthetic has no server to have written a row). An event this
build does not know renders the honest generic line, so a new server-side
writer shows up rather than vanishing. Clicking a row opens the client.

**Saved conversations** (`api/chatConversations.ts`, mounted as
`useConversationSync()` from `AIWorkspaceView` — the lazy chunk, deliberately:
the generated conversations client must stay off the floor, which is why
AppContext only grew two hydration entry points, `hydrateConversations` and
`hydrateConversationMessages`). The drawer hydrates from
`GET /chat/conversations` (summaries; `Conversation.remoteMessageCount` marks a
row whose transcript is unfetched and keeps it visible in `LeftPanel`'s
started-filter), the active transcript is fetched on open, and a debounced
reconciler PUTs each changed conversation whole (`saveChatConversation` —
title, pin, scope, messages; text + intent name ONLY, never a payload/draft —
`fingerprintOf` says exactly what a save covers and its test pins that payload
churn does not re-PUT) and posts a deletion for known ids that disappear.
`POST /chat/turns` stays side-effect-free; persistence is this caller's own
act. Synthetic mode never runs any of it. A restored transcript renders text
bubbles (plus payload-free navigation cards where the intent alone suffices) —
the cards' payloads were deliberately not kept, because a replayed card would
re-offer an action whose proposal already lives in the Approvals queue.

**Two new server intents render** (review item 9): `SHOW_EXPORTS` →
`ExportsCard` (navigation to the Export screen, D42 vocabulary throughout —
never "send to VT"/"sync"/"posted") and `SHOW_APPROVALS` → the synthetic
`ApprovalsTable` plus an always-present "Open the Approvals queue" button,
because live the context's approvals array is empty by design and the REAL
queue is the Approvals screen's.

**Bundle (5 Sep 2026, node-zlib closure walk at gzip level 6 — the measure
script's `gzip` shell-out does not run on Windows, the ClientDetailView
precedent; NOT a paired A/B, other lanes' drift baked in):** floor 206,883 B ·
`InboxesView` **249,752 B (248 B headroom — the thinnest on the board; the
next byte spent on the floor puts it over)** · `ClientDetailView` 248,328 B ·
`BankView` 242,318 B · `AIWorkspaceView` **294,275 B — the pre-existing breach,
deepened ~3.7 kB by the conversations sync + ExportsCard, both of which belong
on that chunk by the reachability rule**. The floor cost of this whole change
is the two AppContext hydration callbacks (a few hundred bytes); the generated
conversations client and the notifications client are on the chat chunk and the
ContextHeader chunk respectively, not the floor. The known reclaims
(`AIWorkspaceView`'s section above) remain the route's only way back under.

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

### ⚠ The export screen (launch stage A9) — written, tested, and NOT YET REACHABLE

`views/ExportView.tsx` + `api/exports.ts` are the surface D42/D43 makes "the visible endpoint of the journey": pick a client and a period, get the VT Transaction+ import file and a ZIP of the source documents named by their capability codes. Both files are new and neither touches anything shared.

**It is registered as of 28 Aug 2026** — the four additive lines A9 was told to stop short of: a `lazy()` and a `case 'Export':` in `App.tsx`, `'Export'` in `SIDEBAR_TABS` (`context/AppContext.tsx`), and a `Download`-icon entry in `Sidebar.tsx`'s `navItems` and `BottomNav.tsx`'s `MORE`. A9 was scoped to the view and the API and told not to edit the shell while there were open PRs in it, so until now `/export` fell through `fromSlug` to the AI Workspace and `ExportView` was not in the build graph at all. The label is **'Export'** and the message id is `shell.sidebar.export`; never 'Publish', 'Send' or 'Sync' — D42 governs what a label may claim as much as what a screen may.

Six things about it that are decisions, not details:

- **⚠ Every string on it is D42 compliance, not style.** "Export for VT" and "Download VT import file" are the two sanctioned phrasings; *send to VT*, *publish to VT*, *sync*, *posted*, *connect to VT* and both ledger vendor names are forbidden, and the screen states in as many words that *Published* means approved and released for export and that nothing leaves the product on its own. `views/ExportView.test.tsx` reads `document.body.textContent` after a successful export and asserts the forbidden vocabulary is absent — a **copy** test, and the only mechanical guard the rule has. It has already caught one: an earlier draft of the D42 paragraph said "does not connect to VT", which is true and still trips the regex, so the sentence was rewritten rather than the regex loosened.
- **The batch cap is on the form before it is hit**, because generation is synchronous server-side (no queue, no worker, no progress polling — a download button, not an export pipeline). `EXPORT_BATCH_CAP` is read off the generated `createExportBodyDocumentIdsMax`, never typed out, so a contract change moves the sentence with it. When the server answers `NT-EXP-003` the screen shows the problem's own detail *plus* the one action that resolves it, and the branch keys on `NtProblemError.code` — not on the message, which is prose the server may reword.
- **There is no money on this surface at all**, so there is no pence↔pounds boundary to get wrong. `rowCount` and `documentCount` are counts; the emitter owns the only money-formatting boundary and it is server-side.
- **`slices.ts` was NOT widened.** `SliceName` has no `exports` member and should not: it names the demo route's context arrays, and an export is not one. The view computes its own `sliceStatus` from its own query (the `ChasesView` model) and passes any label it likes to `DataSourceBadge`, whose `slice` prop is already a plain `string`. That is also what keeps `api/exports.ts` off the bundle floor.
- **Export history carries no download links, and says so.** The URLs are presigned and minutes long by contract, so a row from last week has none live; the honest answer is a line telling the accountant to export the period again, which reuses the same capability codes and therefore produces a file their saved VT conversion table still matches.
- **The two download anchors carry `rel="noreferrer noopener"`.** The signed URL is bearer authority over a client's whole month of financial records with no session behind it, and a `Referer` header would carry it wherever the tab goes next. Pinned by test.
- **⚠ "Nothing to export" is no longer allowed to be a dead end (2 Sep 2026).** Reported from the live app: a client with exactly one Published document — dated **12 May 2025** — and this screen, defaulting to `previousCalendarMonth`, answering *"No documents reached Published in 01/08/2026 to 31/08/2026 for this client."* The product owner read that as **published, but it will not export**. The server was right (the export period selects on the document's own date, which is the accounting answer and is now stated in the contract) and the screen was useless. It now renders the refusal's `publishedOutsidePeriod` — how many Published documents sit outside the chosen period and the dates they span — plus **one button that sets both date inputs to the server's own bounds**, so nobody retypes two dates read out of a sentence.
  ⚠ **The screen computes none of that, and must never start.** The facts ride on the `NT-EXP-001` problem (`NtProblemError.publishedOutsidePeriod`, the contract's one RFC 7807 extension member) because the exporter is the only thing that knows its own predicate; a second query here could disagree with it and would be a second read of a client's records written by someone not looking at the exporter. Two silences are deliberate and pinned by test: a client with genuinely nothing Published gets no hint (the extension is absent, not zero), and a count whose documents are all **undated** offers no button, because there is no period a widening could reach. `previousCalendarMonth` is unchanged — the default is fine once the dead end is not one.

Colour is tokens throughout — `bg-ground` / `bg-card` / `bg-raised` for surfaces, `bg-brand` + **`text-brand-on`** for the primary buttons (not `text-white`: white on mint is 1.4:1, and `--color-brand-on` exists for exactly this), and the established amber/red/emerald ramps for degraded/failure/settled. **Nothing lints a hex literal in a className**, so it was checked by grepping the two new files for `#[0-9a-fA-F]{3,8}` — zero — and by listing every `bg-`/`text-`/`border-` class in the view against the `@theme` block.

### Bank statement upload is real (28 Aug 2026)

`BankView`'s "Upload statement" sent the file's **name** and never its bytes —
`uploadStatement(f.name, clientId)` pushed a row into local React state that read
"extracting…" forever and vanished on reload. With D40 making manual upload the
only bank input in ID, that mock stood where the whole release's bank data comes
from, and no `BankTransaction` had ever been created by this product outside
`prisma/seed.ts`.

Live, the file now goes through `sendWorkspaceUploads` — the same three-call
journey (`intent → presigned PUT → complete`) every other document takes. The
server classifies it and the ingest job's statement step writes `Statement` +
`BankTransaction` rows with the D41 gates applied
(`apps/api/src/modules/banking-matching/statement-ingest/`). Synthetic mode keeps
the local demo behaviour, per METH_MODE §1.

**The Statements tab reads the API since 29 Aug 2026** (`api/statements.ts` →
`GET /v1/statements`). It was the seeded array, which is EMPTY live — so a client
whose statement had just imported 1,144 transactions saw *"No statements
uploaded"*, and **D41's verdict on it reached nobody**. Three things about it:

- **`assurance` is its OWN column, never a tone on `status`.** Whether the import
  happened and what could be PROVEN about the result are different questions.
  Folding them together makes "we read every line" and "we could not check" the
  same green tick, which is exactly the claim D41 forbids. `reduced` is amber and
  says *"Cannot be checked"* — it is not a softer failure.
- **The findings are shown, not just counted.** A number alone tells an
  accountant nothing they can act on, so the first finding's own words are on the
  row and the rest are in its `title`.
- **Pence → pounds happens in `api/statements.ts` and nowhere else**, like every
  other money boundary in this app.

**The Statements tab gained management actions on 3 Sep 2026**: row selection
with a bulk **Remove**, a per-row Remove, and an open-the-source-document button
(rendered only when the id resolves in the hydrated documents slice). Removal
works in SYNTHETIC mode (`removeStatements` in AppContext, the
`deleteSupplierStatement` pattern) behind a confirmation that states the REAL
blast radius — statement count, total imported rows, file names, composed by
`lib/statementRemoval.ts` — never a generic "Are you sure?". **Live it is
disabled wearing its reason** (`BulkAction` grew an optional `disabled` +
`disabledHint` for exactly this): removing real bank data is a
`bank.remove-statement` proposal on the Review → Approve spine, and that kind is
not in the contract yet (LAW, G7 — the design note in
`apps/api/src/modules/banking-matching/CLAUDE.md` carries the delta; the
server-side executor is built and dormant). When the kind lands, `KIND_LABEL` in
`api/proposals.ts` fails compile as the reminder, and the flip is staging the
proposal from `confirmRemoveStatements` in `BankView.tsx`.

Two things to know:

- **`accept` is `.pdf,.csv,.xlsx` plus the four raster types**, widened back on
  28 Aug 2026 when the server gained a real reader for them (Textract, D20). It
  was narrowed to the two grid formats while a PDF was refused server-side —
  offering a format and then refusing it is worse than not offering it — and
  the widening is gated on the same fact: **a photograph or a PDF only imports
  where `STATEMENT_READER=textract`.** Staging sets it; a local machine cannot
  (Textract cannot read MinIO — see the banking module's own file), and there
  the refusal says the reader is not switched on rather than promising a retry.
- **A refusal is rendered**, as a `role="alert"` line by the upload button. The
  bytes never left, so silence would read as an upload that worked and then did
  nothing — the exact behaviour this replaced.

### The Unrouted queue is gone, and routing moved onto bulk Move to client

`views/UnroutedQueue.tsx` is deleted — the one file the prototype port removed. SoT issue **#158** resolves prototype-vs-SoT surface disputes in the prototype's favour, and the prototype has no Unrouted queue. The removal predates the fork rather than being a prototype invention: an identical comment survives on both sides ("The taught-sender tick from the old unrouted card, kept where the routing decision now happens"), so the *card* was already retired in the shared lineage and this repo re-introduced it as a METH S12 live surface.

**The deletion was only ever valid together with its compensating rewire, and they landed in one commit.** Removing the queue alone would have left live/API mode with no way to route a document at all — bulk-move was gated off in api mode and the queue was the only other door. That is a backend regression hidden inside a UI removal, and no test covers it, so it is worth knowing exactly where the pieces went:

- the `document.route` `CreateActionProposalRequest` and the `ProposalFlowModal` launch now hang off InboxesView's bulk **Move to client**, one proposal per document, walked one at a time (`routeRequestFor` / `startRouting` / `advanceRouting`);
- the `documentsSource !== 'api'` gate is lifted for that action only. Live it goes straight to Review → Approve with no local confirm in front — the review *is* the confirmation, and a second dialog before it is theatre. Synthetic mode keeps its `confirm()` + `moveDocuments` path unchanged;
- unrouted rows are no longer filtered out of the inbox lists into a separate queue; they list like anything else. In synthetic mode no document carries an empty client id, so that reads exactly as before;
- the clientLabel/inboxLabel pair and the sentence "Assigning one is a state change — it goes through Review → Approve like everything else." moved into the bulk-move menu rather than retiring with the queue.

`document.route` itself is untouched in `packages/contracts` (LAW), and routing still goes through Review → Approve. The seven `inboxes.unroutedQueue.*` ids retired with the surface.

### The seed↔server id bridge, and the live gating sweep (METH S14)

Stage 14's hardening audit found the golden path broke against a **freshly reset** DB, and the reason is worth keeping: the synthetic cast keys clients as `'1'`/`'2'`, the MSW fixtures bridge them as `biz_1`/`biz_2`, and the real seed's businesses are `biz_burger`/`biz_cosmo`/`biz_dental` — earlier stages smoked against a stale shared DB and never met the real ids, so uploads and Unrouted routing were refused server-side and every client-scoped filter (ClientInbox, the embedded BankView) matched nothing after `pnpm demo:reset`. The fix lives in `AppContext`: `serverClientIdFor(clientId)` joins the seed clients to the hydrated `businesses` slice **by normalised name** (case, punctuation and a trailing Ltd/Limited dropped — the name is the only fact both casts share), falling back to the `biz_<id>` fixture convention when the slice has not answered; `isSameClient(rowClientId, clientId)` is the tolerant compare every client-scoped filter now uses (`InboxesView`, `ClientInbox`, `BankView`); and `clientNameFor` answers an opaque id from the hydrated slice before falling through to the id itself. The bridge still retires when the clients list itself reads from `GET /businesses`.

The same sweep enforced the S12 rule everywhere: **a button whose write the next poll reverts is worse than absent.** Live (`documentsSource === 'api'`, or `slices.bankTransactions.source === 'api'` on the bank surface), the local writers are hidden or disabled-with-tooltip pointing at the real path: InboxesView publish / mark-reviewed / move / delete (the publish tooltips name the chat utterance), ClientInbox's `nextStep` and bulk bar (the client-side CSV export stays — it is real either way), BankView's cash-code, synthetic chase composer and Matches tab (live it says where matches actually live), DocumentsView's unarchive/move, and both duplicate-resolution footers (an informational note — the executor ships post-demo). ApprovalsView's fixture summary figures and inert client filter give way to a live count over the queue. BankView, ClientInbox and DocumentsView gained the loading/error banner + `DataSourceBadge` the other wired screens already had. `errorLabel` in `api/slices.ts` is the one failure-label maker now — it keeps the `NT-` code in front of the words (frontend ten, item 5), and `sliceStatus`, the degraded session state, `documentsError` and the outbox error all go through it. `DocumentPreview` lost the handler-less "Enter manually" button and no longer formats `To Review — {note}` with an undefined note, which was a react-intl `console.error` on every live To-Review detail and on the duplicate beat.

### The clients list and intake are live (launch M7)

`ClientsView` **was** two lists behind one route — `LiveClientsView` rendered a reduced table (name, three counts, the subscription pill) whenever the businesses slice was live, because that was all `BusinessSummary` carried and every other column would have been invented. **That fork is gone as of 28 Aug 2026; there is ONE board and live gets the real one** — cards or table, the tabs, the column picker, health, every count column and the bulk bar.

What made it possible was widening the endpoint rather than loosening the rule. `BusinessSummary` now carries `industry`, `nextDeadline` and **ten** counts (`toReview`, `ready`, `failed`, `published`, `missing`, `requested`, `overdue`, `unmatched`, `statementGaps`, `approvals`) — a G7 contract change, approved by Shakib, with the aggregation in `apps/api/src/modules/auth-tenancy/businesses.service.ts`. Four things follow that the next person needs:

- **`AppContext` maps server rows into the board's own `Client` shape** (`liveClients`) and answers `statsFor` from `liveStats` — the server's counts through `clientStatsFromCounts` in `lib/selectors.ts`, which reuses `pipelineHealth` so a live client and its seeded twin are scored by the SAME weights. The S12 rule is still enforced; it moved down a level, from withholding the whole screen to answering each figure from a real source.
- **`liveBoard`** (`slicesOn && businesses.length > 0`) is the one condition three things read: which list the board shows, which stats it scores, and whether the seed↔server id bridge is still needed.
- **Two counts are honestly zero live** — `duplicates` and `itemDelay` have no server column, and both cost points in the health score, so a live client scores at or above its seeded twin, never below. `statementGaps` is zero for a different reason: nothing in the repo writes `Statement.gapAnalysis` yet, and counting statements that merely *have* the column set would report gaps nobody found. One place to change when the extractor starts writing it.
- **`bankConnected: true` on a live row is vestigial, not a capability claim.** The seeded health formula docks ten points for a client with no bank feed; ID has no feed to connect (D40), so applying it live would mark every client down for declining a feature that does not exist. It is rendered on no live surface.

⚠ **The subscription `Plan` column left with `LiveClientsView` and has not been re-added.** Per-client subscription state is still on the client's Settings tab (`PlanPanel`), so nothing is unreachable, but the at-a-glance view of who has lapsed is gone from the list. Re-adding it is an optional column fed from `businesses` — small, and worth doing before anyone relies on the list for billing triage.

Live rows now `openClient` like any other, because the clients list itself IS the server's — which retires the old caveat that `ClientDetailView` returns `null` for an opaque id.

`ClientIntakeForm` carries the same split: with a live session it renders `LiveIntake`, one three-step flow (company → contact → business-type profile) over `src/api/intake.ts` and `POST /v1/businesses`. Things that are decisions, not details:

- **One call does the whole job.** A11's service creates the workspace, primary contact, VT integration and setup invite in one transaction, and the registration email carries the link — there is no second "send the invite" call, so creating IS inviting, and the success copy says exactly that (email, six-digit code, the client onboards themselves — never "text" or "SMS", ID sends none).
- **Intake is `x-nt-side-effect: ingest`, not a proposal** (Governance §10.6), so there is no Review → Approve and no `ReviewGate` theatre pretending there is — the read-back before the button is a summary, and the button says what it does.
- **An unanswered optional is an omitted key** (`buildIntakeRequest`): the questionnaire is the AI's only coding context (§24.4), so the employees/subcontractors toggles are tri-state and 'unknown' omits the key rather than filing a `false` nobody asserted. A mobile without its country code is refused before the network, not guessed at; the assembled request is parsed by the contract's own `createBusinessBody` before it travels. Pinned in `intake.test.ts`.
- **`createBusiness` has no generated response schema** (the `contextQuestionnaire` oneOf — the same orval gap `getChaseResponse` documents), so `submitClientIntake` pins the contract's required core by hand and throws with the field named rather than reporting an unverified 201 as a created client.
- On success the form calls `refetchBusinesses()`, so the list behind the modal is already real when the modal closes.

MSW is started from `src/main.tsx` behind a **dynamic** `import()`, which is what keeps it and `@faker-js/faker` out of the production bundle. Verified: neither string appears in `dist`. Keep it dynamic.

There is no chat proxy and no escape hatch. `VITE_CHAT_PROXY` and the `POST /api/chat` call to the pre-monorepo frontend's Gemini classifier were removed with issue #59: `server.ts` never came across in the import, so the route did not exist and the call could not succeed, while the deterministic classifier in `lib/resolver.ts` was already producing the answer. That ends the D22/D28 (Bedrock, eu-west-2) and D30 (UK-first residency) exception structurally rather than resting it on a flag default — chat reaches a model again only through the Bedrock-backed surface, which belongs to `chat-framework`, not to this component.

**There is exactly one raw `fetch` in `src/`, and it does not call the API.** `src/api/upload-transport.ts` (`putBytes`) `PUT`s uploaded bytes to the presigned storage URL the API just handed over — for BOTH surfaces that send bytes, the OTP portal and the practice workspace, which is why it moved out of `portal.ts` in METH S7 into its own module (the practice screens must not import the portal's journey to PUT a file, and vice versa). That request goes to the object store, not to Neoting, and its signature covers the method, the URL and the headers exactly as issued — `ntFetch` would prefix `/v1`, attach `credentials: 'include'`, add an `Idempotency-Key` and an `Accept`, and the signature would stop matching. No credential of ours travels there. It is in the api layer, never in a component, and the rule above ("never `fetch` raw in a component") holds unchanged.

### ⚠ The generated client's response envelope does not exist at runtime

orval's fetch client types every operation as `Promise<{ data: T, status: 200 }>`. The mutator all of them go through — `ntFetch` in `packages/contracts/src/http-client.ts` — returns `await response.json()`, i.e. **the body itself**. So `result.data` typechecks and is `undefined` at run time unless the body happens to have its own `data` field.

Every api-layer module therefore reads the awaited value as `unknown` — through `unwrapBody` (one definition, in `documents.ts`, which handles both shapes so it stays right if the mutator ever changes) — and lets the Zod schema decide, which is the rule anyway. `documents.ts` shipped violating this (`query.data.data`), so with the API enabled every inbox load reported a contract error instead of rendering; fixed in METH S7 with the both-shapes test in `documents.test.ts`.

### Signing up (`/signup/*`) — launch stage M9

How a practice comes into being, over the four operations A1 and A14 built and nothing called. `views/signup/SignupView.tsx` is the screen flow, `api/signup.ts` is the wire, and the addresses are the steps:

| Address | What it is | Call |
|---|---|---|
| `/signup` | the form | `POST /practices` |
| `/signup/check-email` | what happens next | none — see below |
| `/signup/verify?token=…` | the emailed link | `POST /auth/email-verification` |
| `/signup/enrol` | the authenticator | `POST /auth/totp-enrolment`, then `…/confirm` |
| `/signup/done` | sign in | none |

Six things about it that are decisions, not details:

- **⚠ THE CHECK-YOUR-EMAIL SCREEN MUST NOT SAY WHAT HAPPENED, AND THIS IS THE HARDEST COPY ON THE STAGE.** `POST /practices` answers the same empty `202` whether or not an account was created, deliberately: saying which would answer *"is this address registered here"* for anyone who types one — the enumeration oracle `NT-AUTH-003` exists to close on the login path. So the screen says only what happens next, phrased conditionally (*"If that address can be used to open an account…"*), and never *account created*, never *already registered*. `SignupView.test.tsx` reads `document.body.textContent` and asserts six such phrasings are absent — a **copy** test, the same shape `ExportView.test.tsx` uses for D42, and the only mechanical guard the rule has.
- **⚠ NO SECRET REACHES THE ADDRESS BAR, A LOG OR AN ERROR.** The verification token arrives in the URL because that is what an emailed link is; `VerifyStep` scrubs it with a `replaceState` **before** the request goes out, so it is never in the history and never in the next `Referer`. The seed, the ten recovery codes and the `enrolmentToken` live in one component's state for the length of one setup — not `localStorage`, not the query cache, not a URL. Pinned by test at every step.
- **A14's two-step is carried through rather than collapsed, and that is the whole safety of the screen.** `begin` writes nothing; `confirm` is what switches the factor on. So the user must tick that they have saved the ten codes, and then type a real code from the app, before anything is written. `NT-AUTH-008` (the fifteen-minute candidate expired) **restarts** the enrolment rather than dead-ending, and the copy says the previous codes are superseded — a new candidate mints new ones. This release has no re-enrolment or reset flow, so recoverable failure is the design, not politeness.
- **The terms version is not a user choice.** `TERMS_VERSION` in `api/signup.ts` is `'0.1'`, which is `TERMS_VERSION_IN_FORCE` in `apps/api/src/modules/auth-tenancy/practice-signup.service.ts`; any other value is a `400 NT-VAL-001`, because acceptance is recorded as an append-only `audit_events` row and one naming the wrong document is worse than none. `api/signup.test.ts` pins the literal rather than reading the constant back from itself. The checkbox links `/legal/terms-of-service` and `/legal/privacy-notice` — **the real slugs**; M9's brief says "/legal/terms", which is not an address M4 built.
- **The password minimum is enforced on signup and NOT on enrolment**, and the asymmetry is the contract's. Twelve characters is the caller's own input at signup, so a short one is their own `400`. On enrolment a wrong password is a `401`; a client-side minimum there would turn a short one into a `400` announcing that the password is short, which answers a question about somebody else's account.
- **Two entry points outside `views/signup/` changed so the screens are reachable.** `LandingView`'s hero and pricing CTAs read "Create your account" and go to `/signup` (the header "Sign in" is unchanged and still goes to `/app`); `LoginView` carries a link for someone who arrived without an account. M9's `Owns` list does not name either file — the change is two `linkProps` targets and one message default, and it is flagged on the PR.

⚠ **The verification email is not actually sent yet, and this journey cannot complete end to end until it is.** `auth-tenancy.module.ts` still registers `RecordingSignupMailer` (its own comment calls it "the one line S2 changes"), so under `NODE_ENV=production` `POST /practices` refuses with `NT-SRV-001` rather than creating an account nobody could verify, and in development the token is only readable out of the API process. Nothing anywhere builds the verification **link** either — `signup-mailer.ts` says in as many words that "the link is S2's to build". Whoever wires it: the address these screens serve is **`<web origin>/signup/verify?token=<token>`**. That is a server-side gap outside M9's fence and it blocks S7's walkthrough; raised on the PR.

#### The QR encoder is ours, and that is a decision for review

`views/signup/qr.ts` is a hand-written QR encoder — byte mode, error-correction level M, versions 1–14. Every alternative was worse: adding a dependency is on the root `CLAUDE.md`'s stop-and-ask list and no contract-change issue covers this stage; a server-rendered image would put a TOTP seed in a URL, an access log and a CDN; a third-party chart URL is that same disclosure to somebody else. The repo's own precedent is the router, the ESLint literal rule, the legal-markdown transform and the i18n checker. **If Shakib would rather take `qrcode`, this is one import and one component call — swap it and delete the file.**

It is scoped and must stay scoped: v14-M holds 362 bytes and the longest `otpauth://` URI this product can mint is around 160, so a payload it cannot hold **throws** rather than silently truncating — an encoder that drops the tail hands the user a QR that scans cleanly into a broken secret.

**Its warrant is `qr.test.ts`, and the warrant is the point of reading this paragraph.** Two hand-copied number tables are exactly where an encoder like this goes wrong, and it goes wrong silently — the output still looks like a QR code and simply does not scan. So:

- the two transcribed tables (`ECC_CODEWORDS_PER_BLOCK`, `EC_BLOCKS`) are cross-checked against the published byte-mode capacity figures for **all fourteen versions** — a third, independent transcription. A slip in any one of the three fails the build;
- both BCH routines are pinned against the published format-information and version-information strings;
- **every version round-trips** through a decoder written independently in the test file, which re-derives the function-pattern map from the geometry rather than sharing the encoder's. That is what proves the data zigzag, the multi-block interleave and the masking, none of which any table can cover. (Writing that decoder is also what caught the one real bug in this work — an over-reserved format row, in the test, not the encoder.)

`QrCode.tsx` renders it as one SVG path. **It is the one surface in the app that does not follow the theme, deliberately:** a reader expects dark modules on a light ground, inverted codes are read by some phones and not others, and "some phones" means an accountant who cannot set up their second factor and has no way to find out why. Black on white in both themes, with the spec's four-module quiet zone drawn *inside* the SVG so no layout change can remove it.

## Client-facing surfaces

Five shells replace the practice app outright rather than sitting inside it, because a client must never have another client's data behind the screen they are on. `App.tsx` switches on `portal` from `AppContext`, and each is its own lazy chunk:

| `portal` | Address | What it is | Data |
|---|---|---|---|
| `business` | `/portal` (and `/portal/:accountId`) | An account a business signs into and can browse | **real API** |
| `approval` | `/approve/:requestId` | SMS link → OTP → approve one client's batch | seed |
| `registration` | `/register/:accountId/:memberId` | An invited person filling in their own details | seed |
| `chase-upload` | `/p/:linkToken` | SMS link → OTP → the items one chase asked for → upload | **real API** |
| `setup` | `/app/setup?setupToken=…` | Email link → emailed six-digit code → onboarding → subscribe (launch M6) | **real API** (live since 28 Aug 2026 — see below) |

**⚠ Both portals split their fallback failure copy on whether the server ANSWERED, and that is a correctness rule, not a preference.** `faultMessageFor` (exported from `BusinessOnboardingView.tsx` and from `ChasePortalView.tsx` precisely so a test can reach it) returns the "check your connection / check your signal" sentence **only when `fault.code === null`**. A code means a reply came back over the very connection that sentence blames, so the two cannot be on screen together — and they were: the setup journey's missing routes 404'd as `NT-VAL-001` and an invited client was sent to their wifi settings for a route that did not exist. Anything with a code now says the server erred, says trying again may work, and points at the accountant plus the reference. Pinned in both view tests; those are the only mechanical guard the rule has.

### The business portal (`/portal`) — real since 29 Aug 2026

**It was a drawing of a portal until this.** `BusinessPortal` is the prototype's
four-tab shell driven by `AppContext.businessAccounts`, which is
`SYNTHETIC ? buildBusinessAccounts(seedClients) : []` — **empty with the API
on**. So a live visitor got `BusinessSignInView`, which calls
`newBusinessAccount()` and writes an account into local React state that
vanishes on reload. Nothing reached a server; there was no portal.

`views/business/LiveBusinessPortal.tsx` + `useBusinessPortalSession.ts` are the
same journey against the contract, and `BusinessPortal` branches to them on
`API_ENABLED` before it touches `businessAccounts`. **The synthetic shell is
untouched**, because the app must still walk end to end with no API
(METH_MODE §1).

Five things that are decisions, not details:

- **⚠ The server change that made it possible: `setupToken` is now OPTIONAL** on
  `POST /portal/sign-in-codes` and `POST /portal/onboarding-sessions` (a G7
  contract change). It was required, and **the invite expires after seven
  days** — so a client who onboarded, subscribed and came back a fortnight later
  was locked out of their own workspace with no route back that did not involve
  telephoning their accountant. Omitted, the address alone names the workspace,
  which the server permits only when it names **exactly one** business. An
  address on two is refused rather than guessed at.
- **The bearer lives in React state plus `sessionStorage`** — never
  `localStorage`, never a cookie, both of which outlive the tab. It is a
  credential over a client's financial records, held by someone who cannot
  re-prove anything, on a phone that gets handed round the till, so the rule is
  and always was **"it dies with the tab"** — and `sessionStorage` has exactly
  that lifetime. It said "React state and nowhere else" until #243, which is
  stricter than the rule it cited and cost the client a fresh emailed code on
  every reload. The session's `expiresAt` is stored beside it, so the hook's own
  expiry watch survives the reload the bearer now survives. ⚠ **The CHASE portal
  keeps the memory-only rule unchanged** — that bearer is an anonymous delegated
  grant from a link, and stays as strict as it was. ⚠ `vitest.setup.ts` clears
  `sessionStorage` after every test for the same reason it resets the viewport:
  a test that signed in must not decide whether the next one sees a sign-in
  form.
- **⚠ NO COPY MAY SAY WHETHER AN ACCOUNT EXISTS.** `sign-in-codes` answers `202`
  whatever happened, so the code step is reached even for an address nothing was
  sent to, and `requestCode` **always** advances the step — branching on the
  result would turn the screen into the enumeration oracle the uniform `202`
  exists to prevent. The wording is conditional: *"If {email} can be used to
  sign in…"*.
- **The lapsed-subscription state is shown BEFORE the upload button, not after
  the refusal** (D48). An upload without a live subscription is refused
  server-side, so the honest thing is to say so before the client photographs a
  receipt.
- **It reuses `sendPortalUpload` from the chase portal's `api/portal.ts`**, which
  needs no change: `POST /portal/uploads` keys off the session's business, and an
  ONBOARDING-scoped session has one. One upload path at two trust levels.

#### It is a FOUR-TAB product again (2 Sep 2026, D49)

The live portal was one scrolling page of three cards while the design source of
record is Home · Upload · Capture · Settings. The rich shell existed and rendered
**only on synthetic seed data** — `BusinessPortal.tsx` branched to
`LiveBusinessPortal` before it touched anything — so every real client got the
short page and the demo got the product.

Both shells now wear **`BusinessPortalShell`** (header, the ≥768px tab row with
its animated underline, the phone thumb bar) and share **`portalTabs.ts`**, whose
pure `tabFromPath`/`pathForTab` serve two different address shapes: the live
portal is `/portal(/upload|capture|settings)`, the synthetic one is
`/portal/:accountId/…`, and the tab is the last segment when it names one. The
synthetic shell moved out to `SyntheticBusinessPortal.tsx`.

What each live tab does with real data:

- **Home** — the outstanding asks named (`items` + `statementRequests` off
  `GET /portal/context`), a 2×2/1×4 counter row, two action tiles, and
  **Recently sent** off `GET /portal/documents`.
- **Upload** — dropzone, per-file refusals with named reasons, "Just sent", and
  the portal's own documents (`channel === 'SMS_PORTAL'`).
- **Capture** — the camera, which had no live equivalent at all. `idle |
  starting | live | error`, an 80px shutter, a multi-page tray, and the device
  camera fallback that every fault points at. ⚠ Unlike the prototype it uploads
  the **real bytes**: a frame goes through `lib/capture.ts`'s constants and
  `dataUrlToBlob` (`portalCamera.ts` → `frameToPage`), so there is still exactly
  one compressor in this app.
- **Settings** — Business / Plan / Sending / Notifications / People / Security.

Five things that are decisions, not details:

- **⚠ The five status words come from the SERVER.** `PortalDocumentStatus`
  (`processing | with_accountant | accepted | filed | needs_another_copy`) is
  deliberately not `DocumentState`; the mapping is made server-side so it cannot
  fork between clients, and `PortalStatusPill.tsx` only supplies the wording (so
  it stays translatable). **Never render a raw `DocumentState` on a client
  surface, and never derive one of the five here.**
- **⚠ `transactionId` on a per-ask upload is a DECLARATION, not an
  instruction.** It reaches the signed upload claims and a `document_events` row,
  and then auto-close **re-derives** the match from supplier + amount + date
  against every open chase (`apps/api/src/modules/chase/auto-close.ts`). Verified
  before the UI was written, which is why "Send it" says *"the request stays open
  until it matches"* and never that it closes the row it started from.
- **The lapsed state carries a working checkout.** It used to read *"your
  accountant can help you restart it"* while `POST /billing/checkout-sessions`
  sat implemented and portal-authorised. `checkoutReturnUrl` also stopped
  hard-coding `/app/setup` — every caller passes its own return path, or a client
  who had just paid was returned to a one-time setup link they no longer hold.
- **The session watches its own expiry.** `openOnboardingSession` returns
  `expiresAt` and the hook discarded it, so the bearer just began failing and the
  copy blamed the upload (*"That did not send"*) — clients re-photographed
  receipts to fix a sign-in problem. Expiry is its own state with its own
  sentence, and `NT-OTP-002` maps onto it.
- **It polls `GET /portal/context` every 20 s**, paused while the tab is hidden
  and caught up on `visibilitychange`. Nothing polled before, so an ask raised
  while the tab was open never appeared. Slower than the practice app's 5 s on
  purpose: this runs on mobile data.

**⚠ Panels that were deliberately NOT built, because no server path exists:**
notification preferences — a read-only statement of what is true. The repo rule
holds — a control whose write the next poll reverts is worse than absent.

⚠ **Member management LEFT that list on 2 Sep 2026** — it has a server path now
(four contracted operations), so the rule is satisfied rather than bent. See
*Settings → People* below.

⚠ **Business details and the upload note LEFT it on 5 Sep 2026**, both by the
contract growing the path rather than the rule bending. `PUT
/portal/business-profile` gave the onboarding journey a skippable,
every-field-optional details step between welcome and subscribe (`DetailsStep`
in `BusinessOnboardingView.tsx`; only answered fields travel — omitted is
UNCHANGED server-side — and an already-subscribed client still skips straight
to subscribed; a Settings-tab edit panel is still open). `PortalUploadRequest`
gained `note`, and with it the Upload tab STAGES files on selection — per-file
optional name, remove, and an explicit **Upload** button in
`LivePortalUpload.tsx` — instead of firing on select; a failed file stays
staged. The server makes the name the display filename (real extension kept)
and records the client's words on the provenance event.
The plan panel IS correct here, unlike in the prototype: D48 makes the client the
payer, and `PortalSummary.subscription` plus a portal-authorised
`POST /billing/portal-sessions` make it real.

#### Settings → People, and every section is an address (2 Sep 2026, D45/D49)

The panel said *"Managed by your accountant … they cannot be added from this
screen."* The product owner ruled that wrong: **the client's own manager, HR lead
or owner adds and removes their staff.** `views/business/LivePortalPeople.tsx`
over `api/portalPeople.ts` (four contracted operations) is that panel; the two
retired ids are `portal.livePortalSettings.peopleSubtitle` and `…peopleBody`.

**⚠ The section is an ADDRESS now, not `useState`.** It was local state, so
`/portal/settings` always opened on Business and **People could not be linked at
all** — an accountant telling a client "go to Settings, then People" had no
address to send. `portalTabs.ts` was EXTENDED rather than given a sibling:
`PORTAL_SECTIONS` is a `Record<PortalTab, readonly string[]>` (total by the mapped
type, so a fifth tab must answer whether it has sections), and
`sectionFromPath` / `pathForSection` join `tabFromPath` / `pathForTab`. Four
things that are decisions:

- **`tabFromPath` reads the last segment and then the one before it**, which is
  what makes `/portal/settings/people` a Settings address. Two positions and no
  more — scanning the whole list would make `/portal/settings/a/b/c` resolve to
  Settings, which is a dead end wearing a working tab.
- **An unrecognised section is the FIRST section**, never a blank panel and never
  a 404 — the file's own tab-level rule, one level down. A tab that has NO
  sections cannot claim a trailing segment at all, so `/portal/upload/nonsense`
  still falls Home and stays recoverable.
- **The slug is machine-derived from the key**, never the translated label —
  otherwise a French client's link would open nothing for an English one.
  `LivePortalSettings` keys its icon/label `Record` off `sectionsForTab('Settings')`,
  so a section added in one place and forgotten in the other fails to compile.
- **The phone strip auto-scrolls the active pill in when opened from the URL** for
  free: `SectionStrip`'s effect has already run `scrollIntoView` on mount, and it
  now has a section from the address rather than a constant `'Business'`.

**Honest degradation, not a hidden section** (Governance §11.2). A plain
`BUSINESS_STANDARD` sees the whole list plus one line naming who can change it;
`canManagePeople` is a fact and never a gate, and the SERVER refuses all three
mutations regardless. The Remove button is **disabled with an explanatory
`title`** for the last owner and for yourself, rather than vanishing.

**Roles are free text with suggestions.** `jobTitle` is a `<datalist>` — Owner /
Manager / Staff — never a `<select>`: *"a restaurant has a Head Chef and a site
has a Foreman."* `access` is the separate enum the last-owner rule keys on, and
only the three business-level roles are offered (a client cannot hold a practice
role, and the server refuses one).

⚠ **`gateFor` is exported and unit-tested rather than reached through the DOM**,
because the ORDER is the thing being pinned — name → email → valid email →
duplicate email → last-owner, the same order the server applies. A render test
can only observe whichever message came out first.

**Bundle:** `LivePortalPeople` is `lazy()` from `LivePortalSettings` and is its
own **4,506 B** gzip chunk, so `api/portalPeople.ts` and the four generated client
functions are fetched only when a client actually opens People. That is a budget
rule, not a tidy-up — the portal is the surface this product promises will load on
a bad connection in a car park. Measured with the People chunk NOT fetched, the
portal route is **225,210 B** against the 250,000 B budget (~24.8 kB headroom).
⚠ Other lanes had uncommitted work in this tree during the measurement, so treat
that as the route's standing rather than an attributable delta.

`/approve/:requestId` and `/register/:accountId/:memberId` now **refuse honestly
under `API_ENABLED`** rather than falling through to "Link not found": both are
routed outside the live branch, so with a session their seed arrays are empty and
the old copy told the client their link was broken when the feature is simply not
in this release. A portal holder can approve nothing —
`approveActionProposal` carries `security: [- workspaceSession: []]` — and no
client-approval path was built.

Bundle: **the synthetic shell is behind a second `lazy()`**, which is a budget
rule, not a tidy-up. `BusinessPortal.tsx` imported all six synthetic views at
module scope *above* the `API_ENABLED` branch, so every real client downloaded
~2,900 lines of demo shell they can never reach. `API_ENABLED` is a runtime read,
so both halves are in the build; the second `lazy()` decides only one is
**fetched**. Measured (exact `gzip -c | wc -c`, floor + `BusinessPortal`): the
portal route went **227,470 B → 221,955 B** while gaining four tabs, a camera and
a plan panel, with `SyntheticBusinessPortal` a 20.9 kB chunk a live client never
requests. ⚠ Other lanes were committing during both measurements; treat the
−5.5 kB as the shape of the reclaim, not a laboratory figure.

### The setup journey (`/app/setup`) — launch stage M6

The invited client's way in (SoT §24.5, D45/D47/D48): the accountant adds a client, the client is EMAILED a setup link — the address is `SETUP_LINK_PATH` in `apps/api/src/modules/clients-team-settings/setup-link.ts`, which is why this client surface lives under `/app` — and signs in with a six-digit code sent to the registered address. Then their own onboarding, then the subscription. **There is no SMS on this journey and no copy on it may say "text"** — the contract's own words on `createPortalSignInCode`.

`BusinessOnboardingView` is the screen flow, `useOnboardingJourney` the state, `src/api/onboarding.ts` the wire — the chase portal's architecture, deliberately: two implementations behind one interface, bearer in React state and nowhere else, synthetic mode walks end to end with no API (the seeded account it onboards is the first one without a `subscription`). Things to know before touching it:

- **The `portal` derivation checks `/app/setup` BEFORE falling through to `'accountant'`** — an invited client holds no workspace session, so this address reaching the login wall is a dead end for exactly the person the email invited. Like every portal value, it keeps `workspaceApiOn` false: no `/me` probe fires.
- **The server half landed on 28 Aug 2026, and until then this journey 404'd.** `POST /portal/sign-in-codes` and `POST /portal/onboarding-sessions` were in `openapi.yaml` (S0's ID LAW batch) with no controller behind them, so an invited client following the emailed link met a request that had nowhere to go — the S7 walkthrough is what found it. `apps/api/src/modules/portal/portal-onboarding.service.ts` implements both; the screens needed no change, because they were built to the contract. ⚠ The refusals are deliberately silent: `sign-in-codes` answers `202` whatever happened (an unknown token, a wrong address and a real send are one outcome — the mail is what distinguishes them), so **no copy here may report which**, and the check-your-email wording is under the same rule as `/signup/check-email`.
- **The subscribe step WORKS** as of contract change #205 (28 Aug 2026): `PortalSession` gained an optional `businessId` and `createCheckoutSession` accepts the portal bearer, so the client pays at the end of their own onboarding — the only flow D48 and §24.5 describe. `api/onboarding.ts` needed no change; it had parsed the field as `.nullish()` on a non-strict shape all along, waiting for exactly this. **Keep it non-strict**: the field is optional in the contract because a CHASE session omits it, and one shape parses both. The server does not trust what it sends back either — checkout re-derives the business from the session and 404s a body naming a different one. `POST /billing/checkout-sessions` needs a `businessId`, and an onboarding session has no contracted way to learn its own — `GET /portal/context` needs a chase this session does not have. `api/onboarding.ts` parses an optional `businessId` off the session response (deliberately not `.strict()`) so the step lights up the moment the contract grows the field; until then live `subscribe()` reports "could not open the checkout, nothing charged". Growing `PortalSession` is a **contract-change issue for Shakib** (G7), not an edit made from here. The checkout call also sends the portal bearer, which the billing controller does not yet accept (it resolves the workspace cookie) — the same coordination point.
- **One price, as copy.** "£8.50 + VAT" — exclusive of VAT and labelled as such (§24.5); the VAT and the gross total are Stripe's to show. No tier picker, no comparison table (D48). The same string discipline as the landing page: never a bare figure.
- **Stripe's return leg is two standalone screens** (`?checkout=success|cancelled`). The bearer died with the redirect — by design — so they resume nothing, and the success copy claims only "Stripe is confirming": reaching the URL is not proof of payment (the contract's own words on `successUrl`).
- **The settings Plan section** (`BusinessSettingsView` → `PlanPanel`) is the whole of the billing UI beyond checkout: status, renewal date, the price as copy, and a button that mints a Stripe customer-portal session (`POST /billing/portal-sessions`) — card changes, invoices and cancellation are Stripe's pages, deliberately none of ours. Disabled with the demo note on seed data (the S12 rule: a button whose action cannot happen is worse than absent). `BusinessAccount.subscription` (`BusinessPlan` in `lib/types.ts`) is the seed-side stand-in for the contract's `BusinessSubscription`.

### Three staging findings closed together (5 Sep 2026)

One contract widening served all three (`BusinessSummary` gains
`primaryContactName` / `primaryContactMobile` / `setupLinkSentAt`, `PortalSession`
gains an optional `subscriptionStatus`; the server halves are in
`auth-tenancy/businesses.service.ts` and `portal/portal-onboarding.service.ts`):

- **Client details showed "—" for contact name and mobile on every live row.**
  `AppContext.liveClients` now maps `contactName`/`mobile` from the widened
  summary — the same first-wins primary-contact row as the email, display only.
- **The setup-link panel lied twice live.** The synthetic branch reads the
  seeded `OnboardingLink` array, which is EMPTY with the API on, so every real
  client read "No setup link has been sent — add a mobile number first": false
  (intake emails the link at creation) and doubly false (the link travels by
  EMAIL, M8). `SetupLinkLivePanel` in `ClientDetailView.tsx` is the live half —
  sent date off `Client.setupLinkSentAt`, re-send through the REAL
  `inviteBusinessMember` (`api/setup-link.ts`: a fresh invite IS the re-send;
  the server's create-if-absent contact rule means nothing accumulates; a 429
  renders with its code because the invite row was recorded and the email was
  not sent). Gated on the contact EMAIL, never a mobile. The synthetic branch
  is untouched (METH_MODE §1).
- **Onboarding re-offered the £8.50 subscribe step to an ACTIVE client.**
  `openOnboardingSession` now carries `subscriptionStatus` through the parse
  (`api/onboarding.ts`, `.nullish()` on the non-strict shape — keep it
  tolerant), and `useOnboardingJourney.beginSubscription` skips straight to the
  subscribed step on `ACTIVE`/`TRIALING`, exposing `alreadySubscribed` so the
  view shows the "already subscribed" copy without `subscribe()` ever running.
  `NT-BIL-002` remains the server-side guard either way.

Bundle: `ClientDetailView`'s closure measured **247,578 B** after the change
(node-zlib closure walk over the manifest — the measure script's `gzip` shell-out
does not run on Windows), under the 250,000 budget with ~2.4 kB of headroom.

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

## Responsive, safe areas and the phone shell

**D49 made the prototype UI repo ID's design source of record, and the port landed the whole responsive layer.** The rule that settled every dispute: the prototype wins on UI, UX and functionality — *including its removals* — and this repo wins on data, backend and AI. Nothing from the prototype's `src/api/generated/**`, its `src/api/http.ts` or its Gemini `server.ts` came across; `@google/genai` appears nowhere and must not.

**Three layout modes, and the breakpoint is only read in JS when the *structure* changes.**

| | width | shell |
|---|---|---|
| phone | < 768 | no rail — `BottomNav`; tables become cards |
| tablet | 768–1023 | collapsed rail, two-column grids |
| desktop | ≥ 1024 | the original layout |

`lib/useViewport.ts` exports `useViewport()` (`{ phone, tablet, desktop, coarse }`), `useMediaQuery` and `useVisualViewport`. They match Tailwind's `md`/`lg` exactly, so **anything that only changes size stays a Tailwind class** — reach for the hook only to render a *different component* (a bottom bar instead of a rail, a sheet instead of a dialog). `App.tsx` is the worked example: it reads `phone` to swap `Sidebar` for `BottomNav`, and everything else is CSS.

**`useVisualViewport()` is mounted exactly once, in `App.tsx`, and must stay that way.** iOS Safari does not shrink the layout viewport when the keyboard opens, so anything sized in `dvh` slides under the keyboard. The hook writes the honest number to `--vvh` and toggles a `keyboard-open` class on `<html>`. A second mount in a view would fight the first. Views get the keyboard treatment by *using* `h-vv` / `max-h-vv`, never by mounting the hook.

**The utilities in `index.css`, which no component should re-invent:**

- safe areas — `pt-safe` / `pb-safe` / `pl-safe` / `pr-safe` / `px-safe`, plus `pb-safe-4` and `pb-safe-6` (safe inset *plus* a real gap) and `pb-nav` (inset + the 4.25rem tab bar, so a scroll area can clear it);
- `h-vv` / `max-h-vv` over `--vvh`, which falls back to `100dvh` until the hook runs;
- `hit-area` — an `::after` inset of −0.625rem. A tap target cannot grow a dense table row's layout, but it can grow its hit area. Checkboxes, flags, icon buttons;
- `scroll-x` — strips that scroll sideways instead of wrapping, with the scrollbar hidden and `overscroll-behavior-x: contain`.

⚠ **`viewport-fit=cover` in `index.html` is what makes `env(safe-area-inset-*)` non-zero.** Without it every safe-area utility silently computes to zero and the whole layer is inert — it is not decoration, it is the switch. Two more platform rules live in the stylesheet rather than in each component: `touch-action: manipulation` on every interactive element (kills the 300ms double-tap delay), and a `(pointer: coarse)` block raising inputs to `max(16px, 1em)` because **iOS Safari zooms into any field under 16px on focus** and every input in this app is 13–14px.

## The demo tour

`src/tour/` — `TourProvider` (state + `useTour`), `TourOverlay` (spotlight and card), `steps.ts`, `bus.ts`.

**Three different numbers, and they are not interchangeable.** `steps.ts` defines **57 steps**; **55 of them carry a `target`** (welcome and done are deliberately targetless centred cards); those 55 targets name **43 distinct anchor keys**, because a key is reused wherever the same surface is explained twice (`chat-card` alone answers six steps, `client-subtabs` five, `datatable` four). The step counter in the overlay reads **1 / 57** — that is the figure a viewer sees. 43 is the number to check against the DOM; 57 is the number to check against the script. (Launch M5 dropped the five Xero steps — chat-publish, costs-ready-publish, costs-published, integrations, settings-connections — the figures were 63 / 61 / 45 before it; 2 Sep 2026 dropped `chat-invite`, which was 58 / 56 / 43.)

⚠ **`chat-invite` is gone, and the way it failed is the lesson.** It seeded an `INVITE_USER` turn whose card had been deleted, so `IntentRenderer`'s `default` returned `null` and the step confidently spotlit an **empty bubble** under the words *"Inviting someone is a form in the chat"*. The missing-target path could not save it: `chat-card` anchors the bubble **wrapper** (`ChatArea.tsx`), which is present and visible whether or not a card rendered inside it — so an anchor that resolves is not evidence that a step has anything to show. The `team` step also lost its `ask` (*"Or just ask: Invite a colleague"*), which walked the viewer into the same dead path; a step with no `ask` simply omits the line, which several already do.

**Entered from the button in `ContextBar`, which renders only when `documentsSource !== 'api'`** — the app's existing demo-vs-live signal (`API_ENABLED ? 'api' : 'seed'`). The script routes to `/clients/1`, narrates American Burger by name and seeds canned assistant turns, so against a real firm's data it points at the wrong rows. `/demo` and `/demo?step=n` carry the SAME gate since launch M2: with the API on, the address is only a redirect home. The deliberate-door reasoning did not survive M2's trust audit — a live-reachable route that starts a scripted story over a real firm's data is the kind of surprise the stage exists to remove.

- **It is lazy.** `steps.ts` is ~36 kB gzipped of prose and must never reach the floor; it and `TourOverlay` are their own chunks, pulled only when the tour starts. Check this survives any refactor of the provider — a static import from a floor module would put the whole script on every route.
- **The step prose is ENGLISH-ONLY, by an explicit decision** (Shakib, 26 Aug 2026: "Yeah English only"), taken when the cost was put at +206 catalogue keys — ~190 of them prose paragraphs — for a surface that demonstrates the product rather than runs a practice on it. The three blocks in `steps.ts` are plain string constants and `TourStep` carries `string`, not `MessageDescriptor`. **The tour's own chrome is NOT in that decision:** leave / back / next / finish / the progress counter / "Or just ask" keep their `defineMessages` in `TourOverlay.tsx` — they are ordinary UI copy on buttons, and un-wrapping them would be a `neoting/no-literal-string-in-jsx` error. The step prose escapes that rule only because the overlay renders it as a variable (`{step.title}`), which the rule cannot see. Do not re-i18n `steps.ts` without a decision that reverses the one above.
- **`seedChat` fabricates the assistant turn, and it is marked `// DEMO-MOCK`.** The seeded conversations carry a canned reply picked off the step's declared intent with a hand-built payload; no model is called and nothing reaches `POST /v1/chat/turns`. It is the only place in the app that writes an assistant message the §9 runtime did not produce. The tracked issue root `CLAUDE.md` owes every DEMO-MOCK **is not filed for this one yet** — the comment in `steps.ts` says so rather than implying otherwise.
- **The tour blocks less than people assume.** `lockNavigation` (`lib/router.ts`) stops the ADDRESS changing; it does not swallow clicks or keystrokes, and the overlay is `pointer-events-none` outside its own box. Handlers under the spotlight still run. That is why `InboxesView`'s `inboxes:request-publish` action restates the live publish guard for itself. `TourProvider.goTo` re-arms the lock **only once a step is actually prepared** — a throw out of `setup` or `startConversation` used to re-lock a router with no tour on screen, which is an app that cannot navigate until it is reloaded.
- **The bus is how the tour reaches view-local state.** Some steps need a document preview or an approval detail open, and that state lives inside the view. Rather than lifting it, the view calls `useTourAction(name, handler)` and the tour calls `emitTourAction(name)`. `tour:reset` fires on **every** step change so a view can close whatever it opened — subscribe to it if you open anything.
- **Anchors are `data-tour="<key>"`, and `findTarget` picks the last *visible* match.** Two layouts routinely share a key (the desktop aside and the phone `SectionStrip` both answer to `settings-nav`, both to `portal-settings`), which is deliberate and safe: `findTarget` filters on `getClientRects().length > 0` and non-zero dimensions, so the `hidden md:flex` aside is skipped on a phone and the strip is skipped on desktop. Do not "de-duplicate" these by deleting one — that breaks the other viewport.
- **Never slugify a label into an anchor.** The prototype derived `bulk-publish-selected` from an English button caption; a key derived from copy moves with the copy and strands the step. `DataTable`'s `BulkAction` carries an explicit `tourKey` instead — that is the mechanism, use it. It survives the English-only decision unchanged: the reason is that an anchor must not be derived from anything a writer can edit, which has nothing to do with how many locales there are.
- A step whose `target` resolves to nothing degrades to a centred card **and prints a visible amber "missing target" line**, so a broken anchor is loud rather than silent. All 43 anchor keys exist in the source; two are reached indirectly and will not turn up in a grep for `data-tour="…"` — `client-card` (`ClientsView` passes `tourKey` into `ClientCard`) and `client-subtabs` (the literal lives on the shared `SubTabs` frame, not in any view). Grep for `tourKey` as well before concluding an anchor is missing. Six anchors exist that no step targets (`bulk-bar`, `bulk-publish-selected` — a `tourKey` on ClientInbox's synthetic bulk action, orphaned when M5 dropped the `costs-ready-publish` step — `client-users`, `composer-generate`, `inboxes-upload`, `tour-button`), which is harmless. Note `inbox-upload` (ClientInbox, targeted) and `inboxes-upload` (InboxesView, not targeted) are different keys that read almost identically — check which one you mean.

## The theme persists, and there is exactly one key in `localStorage` for it (3 Sep 2026)

**It did not.** `index.html` shipped `class="light"`, `DEFAULT_SETTINGS.theme` was a hardcoded `'light'`, and `settings` is React state — so the sidebar toggle and the Settings radio both worked and both lasted exactly as long as the tab. Every reload threw the user back into light. It was reported alongside the Chases board being white in dark mode and was very likely half of what was actually being experienced.

`src/lib/theme-preference.ts` is the whole of it, and it deliberately copies the shape of `lib/signed-in-hint.ts` — the only other `localStorage` key in this app. Read that file's header too; the argument for why a key is allowed to exist is made there at length. Five things that are decisions, not details:

- **⚠ ONE KEY, `nt.theme`, HOLDING ONE OF TWO WORDS.** `nt_session` is HttpOnly on purpose and the portal bearers live in React state and die with the tab, precisely so a credential over a client's financial records is never left on a shared phone. The bar for a second preference key is the bar this one cleared: **it must be worthless to an attacker.** Read it and you learn which of two stylesheets somebody prefers.
- **The class goes on before the first paint, from an inline synchronous script in `index.html`.** `/src/main.tsx` is a module and modules are deferred by definition, so anything React does happens *after* the browser has painted — which is the white flash this change exists to remove. Verified in headless Chrome: at `first-contentful-paint` the class and the `body` background are already correct in all five scenarios (never-chosen ×2, stored-against-the-OS ×2, junk value). The script is a hand-inlined copy of the module's read half and the duplication is the point; an import would be the deferred module being got ahead of.
- **⚠ DO NOT WRITE A LITERAL `head` OR `script` TAG INSIDE A COMMENT IN `index.html`.** `@vitejs/plugin-react` injects its refresh preamble immediately after the first opening head tag *in the raw source*, so a mention of it in prose swallows the preamble into the comment and the dev server serves an app that never mounts (`can't detect preamble`). This cost a debugging cycle; the file now says so in its own comment.
- **Never chosen is not chosen-light.** With no stored value the answer is `prefers-color-scheme`. That is also why `storeTheme` is called ONLY from `updateSettings` when the patch names a theme — the one signal in this app that a human picked one — and never from the effect in `App.tsx` that *applies* the class. Persisting on mount would pin whatever the OS happened to say at first load and silently stop following it.
- **Storage access can never take the app down.** `localStorage` throws rather than returning null in a browser with site data blocked, and this runs before React mounts. Every access is guarded; the reader answers `null`, the resolver falls through to the OS, and the toggle still works for the session with the failed write swallowed. Verified in a browser with the `localStorage` getter replaced by a throwing one: the app mounts, `/chases` renders, zero uncaught exceptions.

`theme-preference.test.ts` pins the failure cases, because they are the whole point of the module — a blocked store, a junk value, an absent `matchMedia`, and the never-chosen rule.

⚠ **One inconsistency left deliberately**: the two `<meta name="theme-color">` tags key off `prefers-color-scheme` media queries, so a user who *stores* dark on a light-set machine gets a light status bar on iOS. Fixing it means the inline script rewriting those tags, which is more machinery than the symptom justifies; noted rather than done.

## The brand lockup

The product is **Neo Accounting** on every user-facing surface (launch stage M1); "Neoting" survives only in identifiers — `@neoting/*` package names, `nt-*` infra names, database identifiers, env vars, import paths — which are deliberately NOT renamed (that is a Terraform migration and a package-rename cascade, refused mid-launch). `src/assets/Wordmark.tsx` is the lockup: `BrandMark` (the N drawn as one continuous stroke with a ring node at each end, stroking `currentColor` through the `text-brand` token) beside the name as real text in the app's own face — never an image, never a font embedded in an SVG, which silently falls back. The name lives in one message, `brand.wordmark.name`, whose `<strong>` tags carry the Neo/Accounting weight split; it is a brand name and stays untranslated. Used in `ContextHeader`, `LoginView` and the landing page (`LandingView`, header and footer). The tab title and PWA identity (`index.html`, `manifest.webmanifest`) renamed with it. The chat system prompt **still says "Neoting", and M8 deliberately left it** — it is a byte-exact cache prefix with a pinned `PROMPT_VERSION` and an eval gate, all in `apps/api/src/modules/chat-framework`, which is outside M8's web-only fence, and the eval half of the ceremony needs Bedrock. Flagged on the M8 PR; the rename plus version bump plus eval run is still owed as its own change.

## Two shared frames

Both are additive — they replace none of the modals that already draw their own chrome.

**`DynamicComponents/Modal`** — the one dialog frame: scrim, close button, Escape, placement. On a phone it is a bottom-anchored sheet, full width, safe-area aware, with the close button *inside* the card where a thumb reaches; from 640 up the card floats near the top. Props are `{ children, onClose, width?, label? }`. Render it inside an `AnimatePresence` or the exit animation will not play. Two departures from the ported frame, both load-bearing: Escape goes through `lib/useEscape` (a **stack** — a `ConfirmStep` opened over a Modal owns the key, so Escape mid-confirm cancels the confirm and not the surface underneath; two naive `window` listeners fire outer-first and close the wrong one), and the scrim is `role="presentation"` with `role="dialog"` on the card, because announcing a click target as the dialog itself is a lie the a11y sweep already rejected once.

⚠ **The card is BOUNDED and scrolls itself (2 Sep 2026), and both halves are the frame's job rather than a caller's.** It had neither: a dialog taller than the window — a document detail on a short viewport, which is most of them — ran off the bottom edge, and on the phone branch the sheet is anchored with `items-end` + `mt-auto`, where an overflowing item aligns by rules nobody should have to reason about and the scrim's own scrollbar is hidden by its two `[scrollbar-width]` utilities. Reported from the live app as a Path-to-Ready panel whose last action button was cut off with nothing to scroll. So the wrapper carries `max-h-full` and the children sit in an `overflow-y-auto overscroll-contain` box; the close button is deliberately a SIBLING of that box, so it neither scrolls away nor gets clipped. The trade is that the box clips what paints outside a card's own edges — a `shadow-2xl` at the left and right — and unreachable content is the worse of the two. The same wrapper now forces `[&>*]:w-full`, because a child that forgets `w-full` shrink-wraps to its own content and reads as a stray pill on the scrim; `RequestStatementDialog` was the one call site doing it, and it was additionally drawing no `bg-card` at all. Pinned by `CodingProposalModal.test.tsx` — jsdom computes no layout, so the class contract is the only mechanical guard the fix has.

**`DynamicComponents/SectionStrip`** — a row of section pills that scrolls sideways instead of wrapping, for the places a side list or a wide tab row used to be. It scrolls the active pill into view whenever it changes, so a deep link never lands on a strip whose selection is off-screen. **`StripItem.label` is REQUIRED here, unlike the frame it was ported from**, which rendered `item.label ?? item.key` and so leaked a raw machine key (`'vat-returns'`) into the UI the moment a caller forgot one — untranslated, and untranslatable because nothing would ever flag it. `key` is identity and is never rendered; `label` is copy and every call site passes `intl.formatMessage(...)`.

## i18n

Adding a string: `defineMessages` at the top of the component, id `domain.component.purpose`, `intl.formatMessage(m.thing)` at the call site. Plurals are ICU (`{count, plural, one {# day} other {# days}}`) — **never** `${n} day${n === 1 ? '' : 's'}`, which encodes an English-only rule about pluralisation and is wrong in most of the languages this would be translated into. Never concatenate a sentence out of fragments; interpolate into one message.

**Shortening a label on a phone is TWO messages, never a truncation.** The convention the port established is a twin span — the full label in `hidden sm:inline`, a short one in `sm:hidden`, each with its own id (`…Short`):

```tsx
<span className="hidden sm:inline">{intl.formatMessage(m.attachClient)}</span>
<span className="sm:hidden">{intl.formatMessage(m.attachClientShort)}</span>
```

Both spans are in the DOM and CSS chooses; nothing measures text. This exists because the alternatives are all worse in a catalogue: slicing a string in JS assumes English word boundaries, and CSS truncation gives a translator no way to write a genuinely shorter phrase for a narrow screen. `ContextBar` carries the worked examples. The cost is one extra id per shortened label, which is the point — the translator gets to see both and make them agree.

Before minting a per-component id for a universal word, check `src/i18n/common.ts` (`common.action.*`, `common.label.*`, `common.placeholder.*`). Consolidation is by meaning, never string equality: status pills, tabs, navigation labels, channel names and "Yes, …" confirm labels stay per-component so a translator shortening one surface cannot silently reword another (issue #94).

`lang/en-GB.json` is **generated and gitignored** (Governance §1.4 — never commit generated output), so it will not be in the diff and you cannot hand-edit it: `pnpm i18n:check` re-extracts before it checks, and the edit is gone by the time anything reads it. It is the artefact a translator receives, rebuilt on every `pnpm lint`.

**The literal rule is `neoting/no-literal-string-in-jsx`, not `formatjs/`, and the difference is deliberate.** It is the formatjs rule with reports over pure punctuation dropped, because separators like `·`, `—`, `→`, `✓`, `£`, `%` and `{' '}` are not language and putting them in a catalogue teaches everyone the wrong lesson about what a catalogue is for. The upstream rule has no option for that in **any** published version — its only config is `props.include`/`props.exclude`, which match tag and attribute *names*, never the matched text — so the exemption is a wrapper in `eslint/no-literal-string-in-jsx.js`. Read it before touching it; it is eleven lines of predicate and forty of why. Two things about it that matter:

- **it drops a report only when every static chunk has no letter and no digit in it, in any script.** A numeral is not punctuation — `0.00` and `0000` are placeholders whose digits and decimal separator change with the locale, so they are in the catalogue like anything else. One letter is enough to fail. There is currently no in-app exemption: the one there was — the Xero brand glyph in `ClientsView` — left with launch M5's Xero purge, and a new one needs the same treatment it had (an `eslint-disable-next-line` plus a paragraph saying why).
- **it fails towards reporting.** An unrecognised node shape, or an ESLint that changes how a rule context is built, gets the unfiltered rule — noisy, never quiet. `eslint/no-literal-string-in-jsx.test.js` asserts both halves, because a filter that silently starts matching everything turns the gate into a green tick that checks nothing. This repo has already had one of those (see the header of `scripts/check-i18n.mjs`).

`linterOptions.reportUnusedDisableDirectives` is `error`, so a disable comment that no longer suppresses anything — or that names the upstream rule by mistake — fails the build rather than sitting in the file looking like enforcement.

## Bundle

Gzipped, after the i18n extraction. The budget is **JS** (SoT §14: "initial JS < 250 KB gzipped per route"), so CSS is listed but not counted against it:

| | METH S6 | METH S12 | METH S13 | METH S14 | §9 chat | **prototype port** |
|---|---|---|---|---|---|---|
| `index.js` (shared, incl. the 0.1 kB entry stub) | 188.3 kB | 179.3 kB | 179.4 kB | 179.6 kB | 180.1 kB | **183.2 kB** |
| `query.js` (TanStack) | 14.7 kB | 14.7 kB | 14.7 kB | 14.7 kB | 14.7 kB | 14.8 kB |
| `react.js` | 1.5 kB | 1.5 kB | 1.5 kB | 1.5 kB | 1.5 kB | 1.5 kB |
| **shared JS floor, every route** | **204.5 kB** | **195.5 kB** | **195.6 kB** | **195.8 kB** | **196.3 kB** | **199.5 kB** |
| heaviest route on top (`ClientDetailView`) | 45.1 kB | 45.2 kB | 45.2 kB | 45.7 kB | 45.7 kB | **46.4 kB** |
| **worst route, total JS** | **249.6 kB** | **240.7 kB** | **240.8 kB** | **241.5 kB** | **242.0 kB** | **245.9 kB** |
| `index.css` (not in the JS budget) | 13.3 kB | 13.3 kB | 13.3 kB | 13.1 kB | 13.1 kB | 15.1 kB |

**The prototype port cost +2.5 kB of floor and +3.0 kB at the worst route, leaving 4.1 kB of headroom against the 250 kB budget** — under, but the tightest it has been since S6. The floor moved because `BottomNav` and `useViewport` are eagerly imported by `App.tsx`, which is the shell and cannot be lazy: on a phone the rail is not a narrower rail, it is a different component, so the choice has to be made before anything renders. The tour is **not** in that number — `steps.ts` and `TourOverlay` are their own chunks and load only when the tour starts. Measured after the English-only change: `steps` **7.95 kB** gzip (26.40 kB raw), `TourOverlay` **3.04 kB** gzip. Those replace figures of 36.0 kB and 7.5 kB that this file carried before and that no clean-environment measurement reproduces — take the new pair as the ones with a `gzip -c | wc -c` behind them, and re-measure rather than believing either. The floor was **unmoved** by the change (`index.js` 183.20 kB gzip, `ClientDetailView` 46.39 kB, worst route 245.9 kB): the tour never was on the floor, so collapsing its descriptors could not take anything off it. `index.css` grew 1.9 kB for the safe-area and tour blocks; CSS is not in the JS budget, but it is on the critical path, so it is not free either.

**Launch M2 cost the floor +0.54 kB** (measured clean: `index` 183.74 kB gzip, `query` 14.77, `react` 1.53, `ClientDetailView` 46.41 — worst route **246.46 kB**, ~3.5 kB of headroom): the seed-gating conditionals in AppContext, the three exposed refetches, and the always-on badge/`SliceLoadError` pair. The seeds themselves are still on the floor — `SYNTHETIC` is a runtime read (`api/config.ts` reads `import.meta.env` defensively, which defeats static replacement), so both branches ship; the known reclaim of moving the seed dataset off the floor is unchanged and now worth ~67 kB of source to whoever needs the room.

**Launch M5 gave back ~2 kB** (measured clean: `index` 183.54 kB gzip, `query` 14.77, `react` 1.53, `ClientDetailView` 44.60 — worst route **244.54 kB**, ~5.5 kB of headroom): the Integrations tab, the connection panels and the retired messages came off the worst route, and the floor dropped 0.2 kB with the seed/selector trims.

**Launch A9's export screen costs the floor +0.13 kB and adds a 4.84 kB route** (measured clean, exact gzip bytes: `index` **183,820 B** with the view registered against **183,694 B** without, `ExportView` **4,842 B**, `ClientDetailView` unmoved at **44,421 B**). The export route totals ~205 kB against the 250 kB budget and the worst route is unchanged at ~244.6 kB, so headroom is still ~5.4 kB. The floor moved at all because `api/exports.ts` touches the generated exports client, whose barrel is floor-reachable — the reachability rule below, paid at its cheapest because only the two plain functions are imported, never the hook or the query-key machinery. ⚠ The view is **not registered** (see *The export screen* above), so a plain `pnpm build` on `main` produces no `ExportView` chunk at all; these numbers came from registering it temporarily, measuring, and reverting.

**Launch M7 cost the floor +0.4 kB** (measured clean: `index` 183.92 kB gzip, `query` 14.77, `react` 1.53, `ClientDetailView` 44.62 — worst route **244.93 kB**, ~5.1 kB of headroom): the generated `createBusiness` function and `createBusinessBody` schema joined the floor-resident businesses module copies (the reachability rule below — their barrels are floor-reachable, so the marginal cost is per-export and unavoidable). The live list and intake themselves landed on lazy chunks as intended: ClientsView 7.1 kB, ClientIntakeForm 11.6 kB (shared between the Clients and chat chunks).

**Launch M9's signup journey costs the floor +0.23 kB and adds a 9.8 kB route.** Measured clean, on the same machine and in the same session, with and without the stage — which makes this the one delta in this section that is a true before-and-after rather than two independent measurements:

| | baseline (`ae8aa50`) | with M9 | delta |
|---|---|---|---|
| `index.js` + the 78 B entry stub | 184,723 B | 184,950 B | **+227 B** |
| `query.js` + `react.js` | 16,282 B | 16,282 B | — |
| **shared JS floor** | **201,005 B** | **201,232 B** | **+227 B** |
| `ClientDetailView` (worst route, on top) | 44,411 B | 44,432 B | +21 B |
| **worst route, total JS** | **245,416 B** | **245,664 B** | **+248 B** |
| `SignupView` (the new route) | — | 9,818 B | — |

So the signup route totals **211.1 kB** against the 250 kB budget, and the worst route is **245.7 kB with ~4.3 kB of headroom** — the figure to quote, and the one the next screen is spending against. The floor moved at all for the reachability reason this section already documents: `api/signup.ts` touches four generated client functions and five Zod schemas whose barrels are floor-reachable, so their marginal per-export cost is unavoidable. **The hand-written QR encoder is not in that number** — it is imported only by `QrCode.tsx`, which is imported only by `SignupView`, so all of it lands on the signup chunk and no other route pays for it. Keep it that way: a static import of `qr.ts` from anything floor-reachable would put a Reed–Solomon implementation on every route in the product.

⚠ **The two paragraphs above were measured independently, each before the other landed, so neither worst-route figure is current.** A9 reports ~244.6 kB with ~5.4 kB of headroom; M7 reports 244.93 kB with ~5.1 kB. Their floor costs are additive (+0.13 kB and +0.4 kB), so the real headroom after both is roughly half a kilobyte tighter than either line claims. Re-measure on `main` before quoting a number, and before adding anything else floor-reachable — the budget is 250 kB.

**The statements read (29 Aug 2026) costs the floor +0.45 kB and the worst route
+1.26 kB.** Measured clean: `index` **185,372 B** + the 96 B stub, `query`
14,694, `react` 1,534 — floor **201,696 B**; `ClientDetailView` **45,435 B**, so
the worst route is **247,131 B with ~2.9 kB of headroom**. The floor moved for
the reachability reason below (`api/statements.ts` touches a generated client
export whose barrel is floor-reachable) and `ClientDetailView` carries the new
column because BankView is embedded in it.

⚠ **~2.9 kB is the tightest this has ever been.** The next screen has to take
one of the known reclaims with it — the seed dataset leaving the floor, or the
`defaultMessage` strip — rather than spending what is left.

**Next person adding a screen: you have ~4.3 kB** (M9 measured it exactly; the figure below predates that stage). The known reclaims below (the seed dataset leaving the floor, the `defaultMessage` strip on a second locale) are now the difference between shipping and a D37 reject, not nice-to-haves.

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

### 🚨 THE WORST ROUTE WAS OVER BUDGET ON 2 Sep 2026 — measured, not projected

> **Resolved 3 Sep 2026, and the figures below are the wrong quantity anyway.**
> `ClientDetailView` now measures **245,268 B** and `BankView` **237,110 B** by
> closure — see *The route total is bigger than the four-chunk shorthand says*
> further down, and `scripts/measure/route-bundle-closure.mjs`. Everything in
> this section about MEASUREMENT DISCIPLINE (paired builds, clean environment,
> gzip's own noise) still holds and is why the script exists; the four-chunk
> arithmetic it uses does not. Kept as the record of how the breach was found.

`ClientDetailView` **exceeds the 250,000 B hard budget with nothing pending**.
Measured as a tight paired A/B (two builds back to back, exact `gzip -c | wc -c`,
`index-*` + `query-*` + `react-*` + `ClientDetailView-*`):

| | bytes | vs 250,000 |
|---|---|---|
| the route with **no** uncommitted client-details work | **250,233** | **−233 OVER** |
| the same route plus the `primaryContactEmail` slice | **250,305** | **−305 OVER** |

So the deficit is **not** the email field: that costs **+72 B** in total (~6 B of
it the contract widening — `api/businesses.ts`'s barrel is floor-reachable, so
one nullable string is nearly free; the rest is the two render sites). The route
was already over before it was touched.

⚠ **The absolute number is a MOVING TARGET, and that is the finding.** The same
"without" baseline measured **249,967** fifteen minutes earlier in the same
session — roughly **+270 B drifted onto the route while one change was being
written**, from concurrent work in other lanes (`Tables.tsx`, `resolver.ts`,
`ClientInbox.tsx`, `DocumentPreview.tsx`, the Phase 4/5 surfaces above). Three
consequences:

- **Measure paired, in one command, or not at all.** Two builds minutes apart on
  this repo are measuring other people's commits as much as your own. Two
  attempts to shave bytes off the email slice both measured *worse* than the
  thing they optimised, purely from drift — the noise now exceeds a whole small
  feature.
- **One trap worth keeping: reuse the EXACT className string.** Adding `mt-4` to
  an otherwise-identical Tailwind string cost ~230 B, because gzip was
  deduplicating the repeated literal and a one-token change broke the match.
  Cheaper to wrap in a Fragment than to make a class string unique.
- **The next change on this route cannot be additive.** The known reclaims —
  the seed dataset (~67 kB of source) leaving the floor, or the `defaultMessage`
  strip — are now the cost of entry, not nice-to-haves. Whoever takes one gives
  the route back kilobytes rather than bytes; nobody should be hunting for 60.

**Measure before you merge, not after.** A route over budget is a reject (D37), not a warning. The remaining known reclaims: the seed dataset leaving the floor when the remaining views move onto the generated client (**measured 3 Sep 2026 at 9,265 B gzip, not the 67 kB of source this file used to imply**), and the `defaultMessage` strip when a second locale lands. The portal is still the lightest client-facing route by a wide margin — keep it that way: no heavy dependency, and nothing it imports may become shared with a practice screen (`upload-transport.ts` is the sanctioned shared seam, and it is 0.6 kB).

Three things drive the floor, all known:

- `AppContext.tsx` is ~90 kB of source and wraps every route, so it can never be split out;
- the synthetic dataset (~67 kB of source across the three seed/generate modules) is imported by `AppContext` at module scope and therefore ships to users — **but that is 9,265 B of gzip, not 67 kB; see *The seed-dataset reclaim is worth 9,265 B* below before planning anything around it**;
- every `defaultMessage` is in the bundle. The catalogue is not loaded at runtime yet — `lang/en-GB.json` exists for translators and for the gate. When a second locale arrives, the messages should move to a fetched catalogue and the defaults be stripped at build (`@formatjs/babel-plugin-react-intl` / the SWC equivalent `removeDefaultMessage`), which gives most of the 19.6 kB back.

Most of the seed weight leaves when the views move onto the generated client. Until then, treat **199.5 kB** as the floor a new screen is spending against, and re-measure with `pnpm --filter @neoting/web build` before adding a dependency.

## The chase portal requests its own code (1 Sep 2026)

The OTP step's copy used to claim "We have emailed you six digits" while
nothing ever sent one (the chase lane minted no code — under staging's
`OTP_MODE=totp` the portal was unopenable from a chase link). Live, `OtpStep`
now shows an **"Email me my code"** button: `usePortalJourney.requestCode()` →
`requestPortalCode(linkToken)` (`api/portal.ts`) → `POST /portal/sign-in-codes`
with the LINK TOKEN — the code goes to the chase's registered recipient
contact, never an address typed here, and the 202 is uniform, so no sentence on
the step may say whether the link is real ("If this link is live, a code is on
its way…"). Synthetic mode keeps the fixed demo code and the original copy;
`journey.codeRequested` is what flips the wording. Four new `portal.chasePortal.otp*`
ids.

## Statement requests + the itemised portal (Phase 5, 2 Sep 2026)

Three surfaces, one chase kind (engine (c), `statementPeriod` on a
`chase.send` message — the engine composes month + working link + PRIMARY
contact server-side):

- **BankView** (live, client in scope): a "Request statement" button beside
  Upload statement opens `RequestStatementDialog` (lazy) — month picker,
  confirm CREATES the proposal via `requestStatementProposal`
  (`api/proposals.ts`) and says "queued … approved in Approvals"
  (the OffboardClientDialog posture; D44 means the dialog never says "sent").
- **ChasePortalView**: `PortalView.statementRequests` renders a statement card
  per asked month; picking one goes through the same Capture step
  (`statementMonth` header line, upload with `transactionId: null`). Synthetic
  mode carries `statementRequests: []` — untouched.
- **LiveBusinessPortal**: the "waiting for N documents" count now NAMES the
  asks — `BusinessPortalHome` gained `items` + `statementRequests`
  (`api/onboarding.ts`, tolerant parse so an older server sends neither), and
  the awaiting card lists each line/month with Waiting/Got-it state.

## The document lists can publish again (2 Sep 2026)

**The METH S14 sweep left live mode with no reachable publish action, and
*Published is the gate to Export*.** `ExportView` exports only documents that
reached Published (D42/D43), so a client's Costs tab with `documentsSource ===
'api'` — `bulkActions` empty on every tab but Published (`ClientInbox`), the
header and bulk-bar publish disabled-with-tooltip (`InboxesView`) — meant the
accountant could never produce the VT import file. The tooltips pointed at a
chat utterance, which is a real path but not a discoverable one. Reported by
the user as *"there is no option to publish it, if not published then there is
no option to export it for VT software."*

The sweep's principle was right and is unchanged: **a local
`updateDocumentStatus` flip is reverted by the next 5 s poll.** What was missing
was the replacement, and it is `DynamicComponents/PublishBatchDialog.tsx` —
`lazy()` on both surfaces, its own **3,394 B gzip** chunk shared between the
ClientDetailView and InboxesView routes, so none of its copy and none of
`api/proposals.ts` lands on either. Read that file's header before changing any
of it. Four things that are decisions:

- **It stages, it does not write.** `LiveProposalFlow` makes only the CREATE
  call; `LiveProposalCard` is the server's own Review → Approve card, so Approve
  is not merely disabled before `POST …/review` returns — it is not in the DOM —
  and it echoes `renderedSummaryHash` verbatim. Pinned by
  `PublishBatchDialog.test.tsx`.
- **One `publish.batch` names ONE business**, so a practice-wide selection
  spanning clients becomes one batch per client, walked one at a time — the
  `document.route` idiom from bulk Move to client.
- **The "nothing Ready" refusal lives in the DIALOG, not in the callers.** Both
  surfaces therefore meet identical wording (mirroring
  `shell.inboxTable.nothingToPublish*` in `Tables.tsx`), it counts Published
  apart from not-yet-Ready and names both, and the strings stay off the worst
  route.
- **D44 degrades honestly and never hides.** Creating is composing and is every
  member's; the server refuses the APPROVE with `NT-PRM-001`
  (`modules/approvals/assert-can.ts` — `PRACTICE_ADMIN` **and** `is_owner`).
  `/me` carries no `is_owner`, so the dialog can never claim the permission IS
  held: it names who releases, says so more plainly when the session's role is
  not the release role, and the refusal arrives on the card with its code.

⚠ The `publish.batch` preview sent at creation is a placeholder the engine
DISCARDS (METH S10) — never present a draft figure as the one being approved.
`inboxes.inboxesView.publishLiveHint` is no longer a dead-end tooltip; it
describes what the enabled button does. Synthetic mode is byte-for-byte
unchanged on every one of these paths (METH_MODE §1).

## The two CSV export doors on Documents disagreed about what they were (2 Sep 2026)

`DocumentsView` offers the same client-side CSV on the register ("All documents")
and on Archive, and **neither is the D42/D43 export** — that is `ExportView`,
which serves Published only and produces the VT import file plus resolvable links
to the sources. The bug was not the offer, it was the name on the tin: both wrote
**`archive.csv`**, so selecting `processing`, `review` or `rejected` rows on the
register produced a file whose own name says they had been published and released
for export.

The rule now, and it is the rule every other CSV in this app already followed
(`inbox.csv`, `bank-transactions.csv`, `clients.csv`, `<client>-published.csv`):
**the file is a dump of the table you are looking at, and it is named after that
table.** The register writes `documents.csv`, Archive keeps `archive.csv`
(there the name is true — its rows are `published` by construction), and the
shared `exportDocs(rows, filename)` gained two columns: **Status**, so a row's
state travels with it, and **Currency**, for the reason `currency()` carries at
length. Every field goes through the quote-escaper `ClientInbox` already had; the
old bare-quote wrapping broke the column count on a supplier named `Bob "Bobby"
Ltd`. Three tests in `DocumentsView.test.tsx` pin the filename per tab, the
header row and the escaping.

Gating the register to Published was the other option and is worse: the point of
that tab is every state, and an accountant who wants the published subset can say
so in the status filter above it and export that.

## The Category row explains itself (2 Sep 2026)

**The reported bug: a blank Category with no explanation.** The coding ladder
(`apps/api/src/modules/rules-suggestions`) now answers for an uncoded document,
and `Extraction.codingSuggestion` carries the answer — additive and optional.

`api/document-detail.ts` maps it (`toCodingSuggestion`) and `DocumentPreview`
renders it in a panel beside the field list, the `bankMatch` section's shape.
Two outcomes, one panel: `SUGGEST` shows the code, its analysis-account label, a
confidence dot and a one-tap **Accept this category**; `ESCALATE` shows the
named reason instead of the em dash.

Five things that are decisions, not details:

- **⚠ THE CATEGORY ROW'S `value` STAYS `'—'`, EVEN WHEN THERE IS A SUGGESTION,
  AND THAT IS THE WHOLE SAFETY OF IT.** `missingForReady` decides what a
  document still needs by testing `value === '—'` against `BASE_MANDATORY`.
  Writing a suggested code into that row would make the Path-to-Ready panel say
  a document is one field from Ready when nothing has coded it, and the
  accountant would be reading an opinion as a fact. Pinned in both test files.
- **⚠ EVERY SENTENCE ABOUT THE DECISION IS THE SERVER'S**, rendered as a
  variable (`suggestion.note`). The engine words ten escalation reasons and six
  advisories and appends the advisories itself. What is in the catalogue is only
  the chrome — headings, the accept button, the code labels. A second wording of
  *"the licence term is not stated on this document"* here would be a second
  opinion written by someone who did not read the document, and the two would
  drift. Seven new `documents.documentPreview.coding*` ids, all chrome.
- **Accept is the ORDINARY correction path, not a shortcut through it.** The
  suggested code goes through `parseCodingDraft` — the same boundary a typed
  correction crosses — into the same `pending` state and the same
  `CodingProposalModal`: create → Read review → Approve, echoing the server's
  `renderedSummaryHash`. Approve is not merely disabled beforehand, it is not in
  the DOM. The one thing the tap saves is typing a code you are looking at.
- **The row's provenance line becomes the suggestion's note, and its confidence
  the suggestion's** (§13.3). Before this the row claimed
  `AI suggested: demo-extractor-1` over an EMPTY value — a provenance for a
  value that did not exist. `ESCALATE` carries no confidence, so the row reads
  zero and goes amber: there is no coding to be confident about.
- **No panel on a published document** — its coding is locked server-side, so
  the affordance goes rather than the refusal being discovered on approve.

`CATEGORY_LABEL` is exported from `api/document-detail.ts` and read off
`FIELD_PRESENTATION` rather than typed out, so it cannot disagree with the table
that `BASE_MANDATORY` matches on by value.

## Documents got a viewer, a Trash and real counts (2 Sep 2026)

The register listed documents and offered almost nothing you could DO with one.
The product owner asked for *"proper document management here, like delete
option, preview option"*. Five things landed, and four of them are notes the
next person needs.

| File | What it is |
|---|---|
| `DynamicComponents/DocumentViewer.tsx` | the viewer — lazy, **4.9 kB gz** on its own chunk |
| `DynamicComponents/PurgeDocumentsDialog.tsx` | permanent delete as a `document.purge` proposal — lazy, **3.0 kB gz** |
| `api/document-lifecycle.ts` | deletion / restoration / the Trash listing / the header counts |

- **⚠ The viewer is BESIDE `DocumentPreview`, not composed out of it, and the
  reason is the provenance band.** `DocumentPreview` already renders "the
  original beside its extracted fields", and reusing it was tried first. It
  cannot take zoom or rotation: its `<img>` is welded to `scanBandFrame`'s
  letterbox maths, which assume an UNROTATED, UNSCALED `object-contain` image in
  a fixed 3:4 frame. A transform applied from outside desynchronises the hover
  band from the value it claims to mark — the screen pointing at the wrong part
  of a client's invoice and saying "this is where we read it". Making the band
  transform-aware means editing that file, which belonged to another lane. So
  the viewer owns the STAGE (zoom, rotation, paging, download) and
  `DocumentPreview` stays the one place a correction is composed, reached from
  [Correct a field] one dialog up the `useEscape` stack. Nothing about
  extraction, coding or proposals is written twice. **If the band ever becomes
  transform-aware, this fork can collapse.**
- **The presigned original reaches the DOM three ways and all three carry the
  rule**: `rel="noreferrer noopener"` on the download anchor and the
  open-original fallback, `referrerPolicy="no-referrer"` on the PDF `<iframe>`.
  The URL is bearer authority over a client's financial record with no session
  behind it; `ExportView` carries the identical rule for the identical reason.
  Pinned in `DocumentViewer.test.tsx`.
- **Delete is a CALL; purge is a PROPOSAL, and the split is the contract's.**
  `POST …/deletion` and `…/restoration` undo each other exactly, so there is
  nothing for a Review → Approve to protect and they are ingest-class. Purging
  is irreversible, so it is `document.purge` and there is deliberately no
  `DELETE /documents/{id}` in the contract for it to hide behind. **⚠ No
  client-side rule decides what may be purged**: the server refuses a document
  released for export or already linked from an export file (`NT-DOC-002`, D43),
  and that refusal is rendered with its own code and its own sentence — the
  `publishedOutsidePeriod` lesson, applied before it had to be learned twice.
- **The confirmation copy is the point, not the chrome.** Moving to Trash is
  reversible, so it is `tone: 'brand'`, says "Move to Trash", and states that
  nothing is lost. It carries **no recovery window** — no vendor in this
  category publishes one and nothing here enforces one, so a figure would be a
  promise the product does not keep. A reversible act dressed as an irreversible
  one is how people learn to click through the warning that matters, which is
  the purge one.
- **The header counts are the SERVER's** (`GET /documents/counts`), and that
  endpoint exists because they were not true: `PageInfo` carries no total, so
  `total` could only be produced by walking every page and the other three were
  derived from data that had not been fetched. The local derivations survive as
  the pre-answer fallback and as the whole answer in synthetic mode. `deleted`
  has no honest local derivation live, so the summary line has **two whole
  sentences** — with and without the Trash clause — rather than a fragment
  bolted on, and prints no zero for a count nobody has measured.

### ⚠ `import { Modal } from './ApprovalsView'` costs ~32 kB gzip a route

`ApprovalsView` re-exports `Modal` "so existing importers keep working".
Rollup cannot shake a whole view module down to one re-exported component, so a
chunk importing it emits a bare side-effect `import"./ApprovalsView-*.js"` and
the browser fetches **the entire ApprovalsView chunk (15.9 kB)** plus
`DocumentPreview` (9.4 kB), `LiveProposalCard` (3.6 kB), `ReviewGate` (1.8 kB)
and `Tooltip` (1.0 kB) before the route can render. It also silently defeated
this stage's `lazy()`: moving `DocumentPreview` behind the viewer chunk
reclaimed nothing while that line pulled it back through the side door.

`DocumentsView` now imports the canonical `DynamicComponents/Modal`, and the
Documents route went **256,622 B → 227,827 B** — a **28.8 kB reduction** while
GAINING the viewer, the Trash tab, purge and the counts.

**All four importers are gone as of 3 Sep 2026, and the shared pieces now have
canonical homes.** `Field`/`Toggle` live in
`components/DynamicComponents/FormControls.tsx`; `WorkflowCard`/`blankWorkflow`
in `components/DynamicComponents/WorkflowCard.tsx`; `WorkflowEditor` in
`components/DynamicComponents/WorkflowEditor.tsx`, deliberately its own module so
both call sites can reach it through `lazy()` — it is a modal, and eagerly it was
6.9 kB gzip on two routes for a dialog most sessions never open. `ApprovalsView`
no longer re-exports `Modal`, `Field`, `Toggle`, `WorkflowCard`, `WorkflowEditor`
or `blankWorkflow`, and **nothing should put those exports back**: the
re-export is the whole mechanism of this bug.

**The rule this leaves:** a view module (`views/*View.tsx`) is a screen, not a
component library. If two screens need the same piece, it moves to
`components/DynamicComponents/` — importing it from the other screen costs that
screen's entire chunk. Grep before you merge:
`grep -rn "from '\./[A-Z].*View'" src` should return nothing but genuine
composition. **It is clean as of 3 Sep 2026.** The last two offenders were
`SettingsView.tsx` → `import { LinkTtlField } from './ChasesView'` (worth
**28,911 B** on the Settings route — see *The second pass* below) and
`BusinessUploadView.tsx` → `import { Panel } from './BusinessHomeView'` (worth
zero today, taken as a tripwire). `LinkTtlField` now lives in
`components/DynamicComponents/LinkTtlField.tsx`, `Panel` in
`views/business/Panel.tsx`.

⚠ **The grep is necessary and not sufficient.** `InboxesView` kept paying for
`DocumentPreview` after its own call site went lazy, because two dialogs it
imports at module scope (`AnalysisModal`, `DuplicateModal`) imported
`DocumentPreview` at module scope. Nothing named a view; the closure still had
it. Grep every static importer of the module you are moving, not just the
screens.

### 🚨 The route total is bigger than the four-chunk shorthand says

**There is a script now: `scripts/measure/route-bundle-closure.mjs`.** Run it,
do not re-derive a number by hand:

```
node scripts/measure/route-bundle-closure.mjs                  # build + measure every route
node scripts/measure/route-bundle-closure.mjs --dist DIR       # measure an existing --manifest build
```

It reads Rollup's own chunk graph out of `dist/.vite/manifest.json`, walks the
**transitive closure of STATIC imports** from each route chunk — which is what
the browser actually fetches before the route can render — and sums exact
`gzip -c | wc -c` bytes, deduplicated. It deliberately does NOT follow
`dynamicImports`: not fetching those on arrival is the point of a `lazy()`. It
discovers routes itself (every `lazy(() => import(…))` in `App.tsx`, plus any
that resolves under `src/views/` — which is how `BankView` and `ClientInbox`,
lazy from `ClientDetailView` rather than from `App.tsx`, get measured at all;
a route list read from `App.tsx` alone misses the heaviest route in the app).

The shorthand this file used throughout — `index + query + react + the view` —
**undercounts the client routes by ~40 kB** and must not be used again.

Measured 3 Sep 2026 as a paired A/B, two builds back to back in one session:

| route | before | after | vs 250,000 |
|---|---|---|---|
| `AIWorkspaceView` | 289,758 | 290,270 | **40,270 OVER** |
| `SyntheticBusinessPortal` | 274,431 | 274,418 | **24,418 OVER** |
| `InboxesView` | 257,163 | 257,470 | **7,470 OVER** |
| `SettingsView` | 280,029 | **249,105** | 895 |
| `ClientDetailView` | 284,722 | **245,268** | 4,732 |
| `ApprovalsView` | 246,483 | 242,685 | 7,315 |
| `BankView` | 300,696 | **237,110** | 12,890 |
| `TeamView` | 260,802 | **227,064** | 22,936 |
| `DocumentsView` | 227,265 | 227,298 | 22,702 |

(Every other route sits between 205 kB and 245 kB; run the script for the full
table. The uniform ~+30 B on untouched routes is the entry chunk's preload map
growing by three chunk names — real, and the honest price of the split.)

**Four routes came off the reject list.** What did it, in order of size:

1. **`BankView` was statically importing the whole `ClientDetailView` chunk
   (30,665 B) to borrow one dialog.** Not a source-level import — nothing in
   `BankView.tsx` names `ClientDetailView`. Rollup had filed `StatementModal` in
   the `ClientDetailView` chunk (because `ClientSupplierStatements` imports it),
   and `BankView` needs the same modal, so the edge dragged the parent screen,
   both tab screens and `OffboardClientDialog` onto the Bank route. Putting
   `ClientSupplierStatements` and `ClientExpenseClaims` behind `lazy()` — they
   are tabs, exactly like the already-lazy `ClientInbox` and `BankView` beside
   them — moved the shared modal into a chunk of its own and the artefact
   vanished. ⚠ **Chunk membership is not import membership.** When a number
   makes no sense, build with `--sourcemap` and read the `sources` array of the
   chunk's `.map` — that is the only way to see which modules Rollup actually
   put together.
2. **The `ApprovalsView` re-export bug, on three more routes** — see the section
   above. `Field`/`Toggle`/`WorkflowCard`/`WorkflowEditor`/`blankWorkflow` moved
   to `components/DynamicComponents/`, which is what took `SettingsView` (−30.9 kB)
   and `TeamView` (−33.7 kB) under budget as a side effect.
3. **Two modals made lazy**: `WorkflowEditor` (6.9 kB) on Approvals and Client
   detail, `DocumentPreview` + its `document-detail` client (9.6 kB) on Bank and
   Client detail. Both open on a click. The `Suspense` sits INSIDE the `Modal`
   frame, so the dialog and its toolbar paint at once and only the card waits.

**Three routes were still over after that pass.** `InboxesView` and
`SettingsView` came off the list on 3 Sep 2026 — see *The second pass* below,
which supersedes the two paragraphs this note replaces. **Two remain, and both
are diagnosed there:** `AIWorkspaceView` (40,351 over — chat is genuinely the
heaviest screen, and the floor reclaim it was waiting on turns out to be worth
9,265 B, not enough) and `SyntheticBusinessPortal` (14,010 over — synthetic-mode
only, and its residue is structural: it statically imports the whole live-portal
chunk).

#### Arrival is not the whole story: measure the CUMULATIVE cost of a tabbed route

`--union A+B` sums the deduplicated closure of two chunks — what a user actually
holds after arriving somewhere and then clicking a lazy sub-tab. `/clients/:id`
is the case that needs it: it arrives on **Overview** (245,268 B, under), and
each tab adds:

| session | before | after | vs 250,000 |
|---|---|---|---|
| `ClientDetailView` alone (arrival, Overview) | 284,722 | **245,268** | 4,732 |
| `ClientDetailView` + Bank tab | 300,696 | 266,306 | **16,306 OVER** |
| `ClientDetailView` + Costs/Sales tab | 307,503 | 279,032 | **29,032 OVER** |

D37 budgets **initial** JS per route, so the arrival figure is the one that
formally passes or fails — and it passes. But a user two clicks in is holding
267–279 kB, and pretending otherwise is how the four-chunk shorthand happened in
the first place. ⚠ Note the before column: `ClientDetailView + BankView` and
`BankView` alone read the SAME 300,696 B, because `BankView` statically imported
its own parent's chunk. When a union equals one of its members, that is the
signature of exactly this defect — check for it.

**The named next lever on the cumulative figure** is `ClientInbox`'s
`AnalysisModal` (8,540 B), still eager. Its other half — `DocumentPreview` +
`document-detail`, 9,560 B — is **done as of 3 Sep 2026** and took `ClientInbox`
from 244,306 B to 234,376 B on its own; see the section below.

### The second pass, 3 Sep 2026: two routes off the reject list, two left

Paired A/B again, two builds back to back in one session, same working tree,
only the change under test between them. `node scripts/measure/route-bundle-closure.mjs --json …`

| route | before | after | vs 250,000 |
|---|---|---|---|
| `AIWorkspaceView` | 290,270 | 290,351 | **40,351 OVER** |
| `SyntheticBusinessPortal` | 274,418 | **264,010** | **14,010 OVER** |
| `InboxesView` | 257,470 | **247,662** | 2,338 |
| `SettingsView` | 249,105 | **220,194** | 29,806 |
| `ClientInbox` | 244,306 | **234,376** | 15,624 |
| `ChasesView` | 238,854 | 239,362 | 10,638 |

Every other route moved by **+19 to +50 B** — the entry chunk's preload map
growing by four chunk names, the same honest price the first pass paid.
`ChasesView`'s +508 B is `LinkTtlField` leaving its chunk for a shared one.

What did it:

1. **`import { LinkTtlField } from './ChasesView'` was worth 28,911 B, not the
   ~15.8 kB this file predicted** — the `ChasesView` chunk is 15,746 B, but it
   drags `ChaseComposer` (3,235), `chases` (1,866), `ReviewGate` (1,807),
   `Tooltip`, `ChaseModal`, `DataSourceBadge` and ~14 icon chunks behind it.
   `LinkTtlField` now lives in `components/DynamicComponents/LinkTtlField.tsx`
   and both screens import it from there. That was the last real hit for
   `grep -rn "from '\./[A-Z].*View'" src`, which now returns only genuine
   composition (`SyntheticBusinessPortal` composing its own five screens).
2. **`DocumentPreview` was still eager on `InboxesView` — through two modals,
   not one.** Making the call site at `InboxesView.tsx:1561` lazy reclaimed
   **nothing**: `AnalysisModal` and `DuplicateModal` both imported
   `DocumentPreview` at module scope, and `InboxesView` imports both of THEM at
   module scope, so the chunk stayed in the closure through the side door. The
   fix is in the two dialogs — `lazy()` there, `Suspense` inside each dialog's
   own frame — and it is worth 9,808 B on `InboxesView` and 9,930 B on
   `ClientInbox`. ⚠ **A `lazy()` at one call site proves nothing.** Grep every
   static importer of the thing you are moving before you believe a number.
3. **The portal's `Panel` moved to `views/business/Panel.tsx`.**
   `BusinessUploadView` imported it from `BusinessHomeView` — the re-export bug
   by the letter, and worth **zero bytes**, because `SyntheticBusinessPortal`
   imports all five of its screens statically and Rollup files them in one
   chunk. Taken anyway: it is a tripwire under any future `lazy()` on those
   tabs. The synthetic portal's 10,408 B came from `BusinessHomeView`'s
   `DocumentPreview` going lazy, not from `Panel`.

⚠ **Re-measured after `origin/main` merged in (3 Sep 2026): every route moved
+41 to +299 B** — main's forgotten-password screens, the `#244` proposal-body
parse helper and the portal's `sessionStorage` resume, none of it attributable
to one change. **No route crossed the budget**; the two over it are the same two
(`AIWorkspaceView` 290,575 · `SyntheticBusinessPortal` 264,309). `InboxesView`
is 247,703 — **2,297 B of headroom**, still the thinnest on the board.

⚠ **`InboxesView` has 2,338 B of headroom and is now the thinnest on the board.**
Its next lever is `AnalysisModal` itself (8,540 B) — a dialog, and lazy-able —
but it renders its own overlay, so there is no frame to put the `Suspense`
inside and the modal would arrive a beat after the click. That is a behaviour
change, not packaging; do not take it without asking.

### The synthetic portal pays for the live portal — and cannot be split

`SyntheticBusinessPortal` is **264,010 B, 14,010 over**, and 20,206 B of that is
the **`BusinessPortal` chunk, which is the entire LIVE portal**
(`LiveBusinessPortal`, `LivePortalHome/Capture/Upload/Settings`,
`useBusinessPortalSession`). Read off a `--sourcemap` build's `sources` arrays:
`BusinessPortal.tsx` is the only module that dynamically imports the synthetic
shell, so Rollup files every module the two halves SHARE
(`BusinessPortalShell`, `portalTabs`, `PortalStatusPill`,
`LapsedSubscriptionNotice`, `portalAsk`, `portalCamera`, `portalUploadRules`,
`portalSendFault`, `PortalSendFaultNotice` — 47,719 B of source) in the
guaranteed-ancestor chunk, together with the 123,401 B of live-only source it
already held. So a synthetic visitor downloads the live portal to borrow the
shell. The comment in `BusinessPortal.tsx` — "a second `lazy()` decides only one
of them is FETCHED" — is true of the synthetic half only.

🚨 **DO NOT "fix" this by putting the synthetic portal's tabs behind `lazy()`.
It was measured on 3 Sep 2026 and it makes the table WORSE.** Every chunk split
off `SyntheticBusinessPortal` inherits index + query + `BusinessPortal` +
`SyntheticBusinessPortal` ≈ 231 kB before a line of its own code, so one route
14 kB over became three: `BusinessSettingsView` **261,501**,
`BusinessUploadView` **254,443**, and `SyntheticBusinessPortal` still
**251,332**. Reverted. The warning now sits in the file itself.

The two things that WOULD work, neither of them this lane's call:

- **Make the two halves siblings**, both `lazy()` from `App.tsx` on
  `API_ENABLED`, so neither is the other's ancestor and the shared shell gets
  its own chunk. Worth ~14.6 kB, lands the route at ~249.4 kB — **607 B of
  headroom, which is not margin** — and it deletes `PortalChunkSkeleton` and its
  `portal.businessPortal.loading` id, so it is a copy change too.
- **A `manualChunks` entry** pinning the nine shared portal modules to their own
  chunk. Same ~14.6 kB, no waterfall (Vite's preload helper fetches a dynamic
  import's static deps in parallel), and no copy change — but it is a
  build-configuration decision, like the icon consolidation above.

⚠ Making `LiveBusinessPortal` lazy inside `BusinessPortal.tsx` is the one
variant to reject outright: a nested dynamic import is NOT in the parent's
preload map, so it adds a serial round trip to the lightest, most
latency-sensitive route in the product for the benefit of a demo-only one.

### The seed-dataset reclaim is worth 9,265 B, not "67 kB" — measured

This file has quoted "~67 kB of source" for the synthetic dataset leaving the
floor since launch M2, and readers have been reading it as the big reclaim. It
is not. Measured 3 Sep 2026 by stubbing the modules and rebuilding clean:

| stub | `index` gzip | off the floor |
|---|---|---|
| none (current) | 188,154 | — |
| `seed.ts` + `seed2.ts` data arrays emptied | 183,241 | **4,913 B** |
| …plus the nine synthetic-only builders (`buildDocuments`, `buildAccounts`, `buildMissing`, `buildTransactions`, `buildApprovals`, `buildChases`, `buildGaps`, `buildTasks`, `buildVault`) | 178,889 | **9,265 B** |

The dataset is repetitive object literals: 67 kB of source is ~5 kB of gzip.
**9,265 B does not save either remaining route** — `AIWorkspaceView` would still
be 31,086 B over and `SyntheticBusinessPortal` 4,745 B over — and in synthetic
mode the seeds are still fetched, just later, so for the demo it is a paper win
and a real waterfall. Against that: `buildInitialPipeline` runs inside a
`useState` initialiser, `SYNTHETIC ? … : []` appears at ~a dozen more places in
`AppContext`, and there is no "seeds still loading" state anywhere — so doing it
honestly means either an honest loading state on every screen or gating the
whole provider on the import. **Not taken.** It remains a genuine ~9.3 kB win
for LIVE users on every route, and a fair thing to do for its own sake; it is
not the answer to a route over budget, and this file should stop implying it is.

#### ~60 % of a one-icon chunk is per-chunk gzip overhead — measured

`ClientDetailView`'s 15 sub-600 B chunks (nearly all single `lucide-react`
icons) gzip to **4,478 B separately** but to **1,727 B concatenated** — the same
6,624 raw bytes. **2,751 B, 61 %, is the cost of them being separate files**:
gzip cannot share a dictionary across files and each one re-pays a header and a
cold deflate window. The same arithmetic is worth ~6.1 kB on `AIWorkspaceView`
(34 such chunks), ~4.6 kB on `InboxesView` (25) and ~3.2 kB on `BankView` (16).

⚠ **This is NOT free money and must not be taken as a to-do.** Those chunks are
shared BETWEEN routes; inlining them into each route chunk duplicates them and
trades cross-navigation cache reuse for first-paint bytes. It is also a
`manualChunks` change in `vite.config.ts`, i.e. every route at once, not a
packaging fix on one screen. Measure the whole table before and after — with
this script — and treat it as a build-configuration decision, not a cleanup.

## DocumentPreview shows the bank match (Phase 4, 1 Sep 2026)

The section PR #230 refused to fabricate exists now that the server does:
`api/bank-match.ts` (lazy — imported only by the DocumentPreview chunk, plain
generated function inside its own `useQuery`, the `proposals.ts` reasoning)
reads `GET /documents/{id}/bank-match`; the preview renders "Suggested bank
match" / "Matched bank transaction" with the line's label, amount and date,
and a SUGGESTED match gets a **Confirm match** button that runs the SAME
three-call `confirmMatchProposal` ritual the Bank screen uses (create →
review → approve echoing the hash — the middle call cannot be skipped).
`toLocalTransaction` now fills `matchedDocId` from the contract's new
`matchedDocumentId` (CONFIRMED only — a suggestion arrives null by design),
closing the old "never set from a server row" caveat in `api/bank.ts`.

## Three live surfaces landed 31 Aug 2026

**Removing a client lives on the client's Settings tab, NOT the Clients
board** — a design decision ("not the front card"), pinned by
`ClientsView.test.tsx` asserting the ABSENCE on both layouts. The danger-zone
Panel at the bottom of ClientDetailView's Settings tab opens
`DynamicComponents/OffboardClientDialog` (ConfirmStep chrome + optional
reason, cap 500 from the contract); confirming creates `business.offboard`
and STOPS — review/approve are the Approvals queue's moves, and the panel
then says "queued", never "removed". Live-gated on
`slices.businesses.source === 'api'`; seed data disables the button with the
reason (the PlanPanel posture). The kind renders through `api/proposals.ts`
(`KIND_LABEL`, the partial `KIND_NOTE`, `offboardReason`) generically in
`LiveProposalCard`, and `ApprovalsLiveQueue`'s settle nudges
`refetchBusinesses()` — that query neither polls nor refetches on focus, so
without it an approved offboard stayed on the board.

**Chat uploads are real** (`components/ChatUpload.tsx`): the composer picker
and drag-drop on ChatArea/InputRow share one flow — live, it is the S7
two-step journey with `channel: 'CHAT_UPLOAD'`, the business resolved from
the attached client. With "All clients" active (or several attached) the
files are HELD and the missing question is asked — `ChatClientPicker`, a
searchable client list rendered by `ChatUploadClientPicker` beside the drop
overlay in both hosts — and the upload continues with the explicit answer;
never a guess. A practice with no clients keeps the named refusal (an empty
list has nothing to pick). Synthetic keeps the local ingest and
attach-then-send chips. The uploads client is dynamically imported and the
picker is `lazy()` (its own ~1.3 kB chunk) so the flow stays off the floor —
keep both that way; measured floor cost of the picker seam is zero.

**DocumentPreview survives live data now.** Its grid tracks are
`minmax(0,…)` on purpose — a presigned `<img>`'s natural width and nowrap
line-item descriptions blow a bare `1fr` past the card, and
`overflow-hidden` clips every value; truncating elements carry `title`. The
hover band paints AT the field's `boundingBox` when extraction placed the
value on the displayed page (page 1), letterbox-corrected through the image's
natural aspect (`object-contain` in a 3:4 frame — the box is page-relative);
no box / another page / image not yet loaded falls back to the whole-frame
band with an honest caption. Boxes come from OCR word geometry matched
exactly-once server-side (`extraction/field-geometry.ts`) — a value printed
twice on the page gets NO box rather than a guess. The Path-to-Ready panel mirrors
`resolveProcessedState` (Total+Supplier+Category via `BASE_MANDATORY`);
there is deliberately no confirm-as-is button — `UpdateCodingPayload` with
all-equal values collapses to zero changes server-side before the readiness
edge (a G7 gap, reported, not bent) — and no bank-match section exists
because no read surface exposes a document's suggested match (same: G7 gap,
named in the offboard hand-back).

## 🚨 The lists read EVERY page now (2 Sep 2026) — they used to stop at 100, silently

`AppContext` asked for `{ limit: 100 }` on **all three** of its API slices, and
**nothing outside the tests ever read `nextCursor` or `hasMore`.** `pageInfo` was
parsed, plumbed through `api/bank.ts` and `api/documents.ts`, returned from every
hook — and dropped at the call site. So a real client holding **2,288** bank
transactions had **95.6% of their financial records unreachable in the product**,
with no message, no control and no indication of any kind.

It was invisible because the old seed held 27 transactions: every screen was
correct on demo data and silently wrong on real data. And it was never only a
short table — these arrays are what the derived figures reduce over:

| Figure | Where |
|---|---|
| the **"unexplained" total and count** — the headline of the whole Bank screen | `BankView.tsx` (`scopedTxns.filter(...).reduce(...)`) |
| the transactions table footer, the "Needs you" pill | `BankView.tsx` |
| the **Unmatched** KPI tile and every document tile | `AnalyticsView.tsx` |
| the documents summary line and both table footers | `DocumentsView.tsx` |
| "N items" above every table (the `DataTable` default footer) | `DataTable.tsx` |
| "{count} clients in scope" | `ContextHeader.tsx` |
| the live chase-candidate lists — **items that would never be chased** | `LiveMissingCard.tsx`, `LiveChaseComposerCard.tsx` |

**`api/paged.ts` is the fix.** `fetchAllPages` follows `pageInfo.nextCursor` to
the end; the three hooks call the **plain generated function** inside their own
`useQuery` (the `proposals.ts` idiom) instead of the generated single-page hook.
Four things to know:

- **`limit` is capped at 100 by the contract** (`Limit`, `maximum: 100`) and the
  envelopes are keyset-paginated because Governance §3 forbids offset paging.
  There is no bigger number to ask for — reading the whole list is the only
  honest answer, which is why this is not "raise the limit".
- **`AppContext` passes no `params` at all now.** A `limit` written there would
  only cap the FIRST page; the hooks set the page size themselves at the
  contract's maximum.
- **The cap is `MAX_PAGES = 50` (5,000 rows) and reaching it is VISIBLE.**
  `truncated` rides into `SliceStatus` and `DataSourceBadge` renders an amber
  "showing the first N — there are more" (`shell.dataSourceBadge.truncated`), so
  every screen that already mounts the badge gets the truth for one message.
  Silently truncating a client's financial records is not acceptable; a visible
  limit is.
- ⚠ **The documents poll now costs one round trip per page**, every five
  seconds. Two or three requests at ID's scale, and the price of the counts being
  true; the documented replacement for the poll is push, which retires it.

**The three-definition disagreement this section reported is FIXED** — see
*"Unexplained" is one predicate now* below.

**Bundle** — measured as a tight paired A/B, two builds back to back in one
session, exact `gzip -c | wc -c`:

| | baseline | with the fix | delta |
|---|---|---|---|
| shared JS floor (`index` + stub + `query` + `react`) | 203,398 B | 203,604 B | **+206 B** |
| worst route (`AIWorkspaceView`) | 238,572 B | 238,787 B | **+215 B** |
| `ClientDetailView` | 234,061 B | 234,279 B | +218 B |

**Worst route 238,787 B against the 250,000 B budget — 11,213 B of headroom.**
The floor moved by only 206 B because dropping the three generated single-page
hooks (`useListBankTransactions`/`useListDocuments`/`useListBusinesses`, with
their query-key and options builders) paid for most of `paged.ts` — the
reachability rule below, working in the useful direction for once.

⚠ **`ClientDetailView` is no longer the worst route and the 🚨 section below is
stale.** It reads 30,687 B on its own chunk because `BankView` (11,550 B) is now
a chunk of its own; the embedded-bank view therefore pulls ~245.8 kB, still under
budget. `AIWorkspaceView` (35,183 B) is the heaviest single route today. None of
that is attributable to this change — other agents have uncommitted work in this
tree, which is exactly why the numbers above are a paired delta and not two
independent measurements.

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
| `src/lib/resolver.currency.test.ts` | `currency()`, which lives in **`resolver.ts`** — the file was `currency.test.ts` beside a `currency.ts` that does not exist, so the only way to find the function was to read the test's import. Pins the USD-rendered-as-£ bug and that the fix changed nothing for sterling. ⚠ Zero-decimal currencies (JPY) are a stated GAP rather than an assertion: the old `currency(1234,'JPY') === 'JPY 1,234.00'` case enshrined an accounting error, and the fix belongs at the pence→pounds boundary — which divides by 100 for a currency that has no minor unit — not in a display helper. |
| `src/lib/spreadsheet.test.ts` | Money parsing (`2.000,00` is two thousand), quoted CSV fields, and the Net·VAT·Total column race. |
| `src/lib/tableImport.test.ts` | XLSX date serials, day-first UK dates, totals lines refused rather than booked, signed ledgers where a positive row is a refund. |
| `src/api/paged.test.ts` | The truncation regression, at the size it was found at: 2,288 rows come back as 2,288 and not 100, in 23 requests, each carrying the cursor the last one returned. Plus the three ways a cursor-follower goes wrong — an exactly-full page still asking the server rather than inferring from the row count, `hasMore: true` with no cursor STOPPING instead of re-fetching the same page forever, and the cap being reported as `truncated` while stopping exactly at the end is not (a permanent "there are more" badge on a complete list teaches accountants to ignore the one warning that matters). |
| `src/lib/matching.test.ts` | Whether a transaction is settled or handed to a human, and the merchant bar that keeps Costco off Costa. |
| `src/lib/dedupe.test.ts` | The two Dext gaps this exists to close: a pair survives a failed extraction, and an invoice matches its receipt twin. |
| `src/context/AppContext.test.tsx` | The #87 regression: nine rapid route changes with conversation churn interleaved, asserting the tree survives, the address is not yanked back mid-render, and no setState-during-render warning fires. The one suite that renders the whole shell. |
| `src/api/portal.test.ts` | The delegated boundary, with `globalThis.fetch` replaced by a recorder. Pence→pounds signed and exact; the merchant → raw-descriptor → nothing fallback; a code that is not six digits refused **before** the network; a float in a pence field refused **after** it; and the two rules that make the session safe — the bearer goes to the API on all three of our calls, and it does **not** go to the storage host on the presigned `PUT`. |
| `src/views/business/ChasePortalView.test.tsx` | The fallback demo path nobody exercises by hand: `/p/<token>` reaches the portal and not the practice app, the six-digit gate is real in the UI, and passing it lands on the item list. Plus `faultMessageFor`: a code means the server answered, so the client's signal is never what gets blamed for it. |
| `src/views/business/BusinessOnboardingView.test.tsx` | The invited client's journey on seed data — `/app/setup` reaching the sign-in flow rather than the login wall, the copy saying EMAILED (D47), the six-digit gate, one VAT-exclusive price. Plus `faultMessageFor`, which is where the `NT-VAL-001`-under-"check your connection" bug was closed. |
| `src/lib/capture.test.ts` | The pure half of the compression path — bytes out of a data URL exactly as they went in (including a JPEG header that is not valid UTF-8), and the `.jpg` renaming. The encode itself needs a canvas, which jsdom has not got. |
| `src/lib/useEscape.test.tsx` | The Escape stack: with dialogs nested (DuplicateModal → ConfirmStep), one keypress closes the top layer only, a closed-but-mounted viewer does not shadow the layer below, and the handler read is the latest render's. Invisible in manual testing until someone loses two layers to one Escape. |
| `src/api/auth.test.ts` | The session boundary. 401 and "the API is down" are DIFFERENT states — the first shows LoginView, the second renders the workspace degraded (empty since M2, with a visible failure badge) — and collapsing them turns every transient outage into a lock-out. Plus: a /me body that drifts from the contract never authenticates, login carries `credentials` (the cookie is the whole session), and logout never throws. |
| `src/api/businesses.test.ts` | The synthetic half of the businesses slice: the counting rules, and — the actual point — that the derived fallback rows still PARSE AS THE CONTRACT, so a screen reading the slice cannot tell the worlds apart. |
| `src/views/LoginView.test.tsx` | The front door's gate refused BEFORE the network (all three credentials, TOTP exactly six digits), the error state wearing its `NT-` code, and an unreachable API saying so instead of blaming the credentials. |
| `src/App.test.tsx` | The shell switch — the one structural decision `App.tsx` takes in JS rather than CSS. `Sidebar` at desktop AND tablet width, `BottomNav` at phone width, each asserting the other is absent, plus both live directions when the viewport moves under a mounted tree (which is the only thing that exercises `useMediaQuery`'s `change` subscription). |
| `src/test/viewport.test.ts` | The second suite that tests a *gate*: that the viewport stub still discriminates. See below — the stub it replaced answered every question `false` and nothing failed, so the discrimination is now pinned through `useViewport` itself. |
| `src/lib/useScrollActiveIntoView.test.tsx` | The active-item selector. `[aria-current]` matched the attribute at ANY value, so a strip whose inactive items render `aria-current="false"` scrolled its FIRST item into view forever — hiding the item actually selected, on the deep-link journey the hook exists to fix. Pins the exclusion, the other two clauses, and "nothing active scrolls nothing". |
| `src/views/ExportView.test.tsx` | **The only mechanical guard D42 has.** After a successful export it reads the rendered DOM and asserts none of *send to VT*, *sent to VT*, *publish to*, *sync*, *posted to*, *Xero*, *QuickBooks* or *connect to VT* appears — a copy test, because the rule is about what a screen is allowed to claim and no type can hold it. Plus the batch cap being stated before it is hit, `NT-EXP-003` keyed on the CODE not the prose, both downloads carrying `rel="noreferrer"`, and the four states (empty history teaching the next action, failed history wearing its `NT-` code with a retry, no-session degrading honestly). |
| `src/api/exports.test.ts` | The create boundary: the 201 parsed by the contract's own item schema (orval emits no response schema for a 201 — it is reached off the list response, and this is what says so if that stops resolving), both envelope shapes, a drift throwing with the field named, no hand-set `Idempotency-Key`, and `previousCalendarMonth` across a January rollover, a 30-day month, both February lengths and the first-of-the-month off-by-one that files "1 August to 31 July". |
| `src/views/signup/qr.test.ts` | **The whole warrant for a hand-written QR encoder** (launch M9). Two transcribed number tables cross-checked against the published byte capacities for all fourteen versions; both BCH routines pinned against the published format and version strings; and every version round-tripped through a decoder written independently in the test, which is the only thing that covers the data zigzag, the block interleave and the mask. Plus the refusal: a payload one byte past the limit throws instead of truncating, because an encoder that drops the tail produces a QR that scans cleanly into a broken secret. |
| `src/views/signup/SignupView.test.tsx` | Three of these are not render tests. **The check-your-email screen is a COPY test** — the `202` is uniform on purpose, so six phrasings that would turn it into an enumeration oracle are asserted absent. **The verification token is scrubbed from the address**, checked after the call. **`NT-AUTH-008` restarts the enrolment** rather than dead-ending, with the superseded recovery codes off the screen. Plus the form gate (twelve characters and the terms tick, refused before the network), all ten codes shown once behind a confirm, six digits before Finish, and each of `NT-AUTH-003/004/005/006/007` saying the one thing that tells the user what to do next. |
| `src/api/signup.test.ts` | The request this module composes and the parse it puts the answer through. `TERMS_VERSION` pinned as a **literal** against the server's `TERMS_VERSION_IN_FORCE` — a test that read the constant back from the constant would pass however far it had drifted, and what it files is an append-only audit row about a real person. Plus: the address normalised the way `normaliseEmail` does server-side (`users.email` is unique on the literal bytes), both response parses through the contract's own Zod with drift throwing, both envelope shapes, and the deliberate asymmetry — a password length rule on signup and none on enrolment. |
| `src/components/DynamicComponents/PublishBatchDialog.test.tsx` | The two rules that make a publish action safe rather than merely present. **Approve is ABSENT — not disabled — until `POST …/review` returns**, and then echoes the review's `renderedSummaryHash` verbatim; the server and a DB trigger enforce the same rule, so this pins the one of three implementations that could silently drift. Plus the refusal (nothing Ready, counting Published apart from not-yet-Ready and naming both), a D42 **copy** test in the `ExportView.test.tsx` shape, and D44 degrading honestly — a role that cannot release is told who can and still gets the staging action. |
| `eslint/no-literal-string-in-jsx.test.js` | The one suite that tests a *gate* rather than the product: real copy still fails the literal rule, punctuation still passes. The cases are lifted verbatim from the views. Not under `src/`, because the rule is not application code — which also keeps it out of `tsc`'s include and out of the bundle. |

Component tests are still owed for anything with logic (frontend ten, item 10) — the AppContext suite is the first, not the last.

⚠ **A suite that fails to TRANSFORM reports as one failed file, not as four missing tests.** `LoginView.tsx` shipped with a `{/* … */}` comment sitting beside the returned element inside `return (…)` — two expressions, which is a parse error and not a stylistic preference. It took `tsc`, `vite` and all four of `LoginView.test.tsx`'s assertions down with it, and the run summary said "1 failed | 23 passed" rather than naming what had gone missing. When a file count and a test count move in opposite directions, read the file count first. A JSX comment before the root element belongs above the `return` as a line comment.

### ⚠ The layout mode is something a test CHOOSES, and its default is desktop

`vitest.setup.ts` sets `asyncUtilTimeout` (above) and shims what jsdom lacks and the app really uses: `matchMedia`, `ResizeObserver`, `scrollIntoView`, and `Blob.prototype.arrayBuffer` — jsdom 25 still has no `arrayBuffer()` (nor `text()`), and the portal reads the bytes it is about to upload in order to hash them, so that shim is built out of jsdom's own `FileReader` and is a real read rather than a stand-in.

Three of those four are `??=`-guarded so a jsdom that grows a real implementation wins. **`matchMedia` is not, and the exception is the point.**

It used to be, and it used to answer `matches: false` to every query. That read as neutral and was not. `useViewport()` derives the layout mode from three media queries and turns a universal `false` into `{ phone: true, tablet: false, desktop: false }` — so after the responsive port **every component test rendered the phone shell**: `App.tsx` mounted `BottomNav` and never `Sidebar`, and the sidebar rail, the desktop asides and every `hidden md:*` surface the port introduced were exercised by none of the ~300 tests. A regression in any of them would have gone green. Nothing announced this; it is what a stub that answers everything looks like from the outside.

`src/test/viewport.ts` replaces it with a small real media-query evaluator over a settable viewport:

- **`setViewport('phone' | 'tablet' | 'desktop')`** is how a test says which shell it means. `resetViewport()` runs from an `afterEach` in the setup file, so one test's choice cannot decide what the next one renders.
- **The default is `desktop`**, which is what the suite exercised before the port (there was one layout, and it was that one). Flipping it there broke nothing — the whole suite passed unchanged — which is itself the measurement of how little the desktop shell was being looked at.
- It answers `min-width` / `max-width` / `pointer` / `hover` / `prefers-reduced-motion` honestly and **everything else `false`**, the old behaviour. The app's own queries stop being guesses; nothing else gains an answer a real browser might disagree with.
- A `setViewport` on a mounted tree **notifies existing subscribers**, so the `change` half of `useMediaQuery` is reachable. Wrap that call in `act()`.
- It is `matchMedia` and nothing else. `innerWidth`, `getBoundingClientRect` and layout are still jsdom's zeroes, so nothing here can assert measured geometry — only which branch the app takes on the mode it is told it is in.
- Assigned unconditionally on purpose: a jsdom that grew a real `matchMedia` would answer against a layout viewport it does not have, and `setViewport` would go quietly back to controlling nothing — the exact failure this replaced.

One real behaviour it surfaced, worth knowing before writing an assertion: **the rail does not leave the DOM the instant the shell narrows.** `Sidebar` is wrapped in `AnimatePresence`, so it stays mounted through its exit animation; `BottomNav` is a plain conditional and unmounts at once. `App.test.tsx` therefore asserts both halves of the swap only in the phone→desktop direction, and mount-time absence in the others, rather than chasing an animation this environment cannot run honestly.

**Lazy routes need `findBy*`, not `await act(async () => {})`.** A `React.lazy` chunk does not resolve inside a microtask flush, so an `act` flush leaves the skeleton on screen and every query fails against it. `ChasePortalView.test.tsx` waits on `screen.findByRole` — still offline, because the only thing being waited on is a dynamic `import()`. This is also why `AppContext.test.tsx` can only assert that `#root` is non-empty: what it is looking at is the skeleton.

### The two timeouts, and why `testTimeout` alone does not fix a lazy-chunk flake

⚠ **`findBy*` keeps its own clock.** vitest's `testTimeout` does not govern it; testing-library's `asyncUtilTimeout` does, and that defaults to **1000 ms**. This was measured, not assumed — raising `testTimeout` to 20 s left `ChasePortalView.test.tsx` failing in exactly the same place, because the *test* was never close to timing out; the *query* had already given up.

So the harness sets **both**, and they are budgets for transform contention rather than for slow assertions:

- `testTimeout` / `hookTimeout` `20000` in `vite.config.ts` — for suites that `await import()` in the test body (`ChatArea.test.tsx` does, deliberately, so the context mock is in place first);
- `configure({ asyncUtilTimeout: 5000 })` in `vitest.setup.ts` — for `findBy*` waiting on a `React.lazy` route chunk.

**The flake these fix is pre-existing and not caused by any application change.** On a loaded machine `origin/main` alone failed 2 of 303 tests on roughly one run in three (measured: run 1 green, run 2 red, run 3 green), always `ChatArea` or `ChasePortalView`, always on a dynamic `import()`, while the suite reported 60–113 s of aggregate import time across 24 parallel files. Every one of those files passes deterministically in about a second in isolation. Raising a ceiling costs a green run nothing — a query that matches immediately still returns immediately — and an element that never appears still fails the test. **If you see one of these two suites time out, do not edit the test body**; it is machine load, and the assertions are not the thing that broke.

## Previews

Vercel previews are a **viewing tool, not hosting** (G6). Synthetic data only. **Deployment Protection must be on before the first preview ships** — an unprotected preview URL is a leaked credential and an instant reject (G10/R16).


## "Unexplained" is one predicate now (2 Sep 2026)

**Three surfaces answered "how many bank lines are unexplained?" with three
different definitions, and an accountant read them side by side.** Measured on a
freshly seeded database, American Burger Ltd:

| Surface | Said | Definition it used |
|---|---|---|
| the client card / ClientDetail tile / Accounts tab (`statsFor`) | **6** | the server's `BusinessSummary.counts` |
| the Bank screen's headline | **10 unexplained · £8,725.44 without evidence** | `!isMatched(t)` |
| the Analytics **Unmatched** tile | **10** | `!t.matchedDocId` |

All three now read **6**, and the Bank header reads *"6 unexplained · £2,868.04
without evidence"*. The £5,857.40 that left the figure was two Stripe/Just Eat
payouts, a service charge (all `chaseSuppressed`) and two `SUGGESTED` lines —
none of which any amount of chasing could ever have brought down.

**`isUnexplained` in `lib/matching.ts` is the one definition**, beside
`isMatched` and deliberately not merged into it. Read its doc comment before
touching either. The short version:

- **`isMatched` asks "does this line already have its evidence?"** — the
  matching engine's question, where `SUGGESTED` is deliberately NOT matched
  because a suggestion is a question waiting for a human.
- **`isUnexplained` asks "is this one of the lines the product will go and
  chase?"** — the counting question. It mirrors the server's own `where`
  (`businesses.service.ts`: `matchState: 'UNMATCHED', chaseSuppressed: false`),
  which is the AUTHORITATIVE one because it is what the chase engine chases.

It lives in `matching.ts` rather than `selectors.ts` so the contrast is visible
in one screen of code — `selectors.ts` already imports from `matching.ts`, and
the reverse would be a cycle. Both modules are floor-resident, so placement cost
nothing either way.

Four things that are decisions, not details:

- **It is truthful on BOTH casts, which is why it is not `matchState === 'UNMATCHED'`.**
  A seeded row carries `matchedDocId` and no `matchState` at all, so the strict
  server test would have emptied the demo (METH_MODE §1). It guards on
  `isMatched` first, which also makes "unexplained is a strict subset of
  not-matched" true by construction — a count can never exceed the list above
  it. Synthetic mode is byte-for-byte unchanged: no seeded row carries
  `matchState` or `chaseSuppressed`, pinned by test.
- **Moved onto it:** `AnalyticsView`'s tile; `deriveClientStats` (the seeded
  half of the per-client `unmatched` column — the live half was already the
  server's, so the tile and the column had been disagreeing with each other
  too); `BankView`'s unexplained total, count, table footer and "Needs you"
  pill; and the two chase-candidate lists, `LiveMissingCard` and
  `LiveChaseComposerCard`, which had the suppression half right and were still
  offering `SUGGESTED`/`EXCLUDED` lines nothing would ever chase.
- **`BankView`'s matched/unmatched evidence LENSES stay on `isMatched`**, and
  the `needs-you` lens moved with its pill. A lens is the matcher's question and
  carries no number; the one that carries a number has to select exactly what
  that number counts.
- **`chaseSuppressed` does reach the browser** — it is required on the
  contract's `BankTransaction` and `api/bank.ts` maps it through. No fallback
  was needed. It is `boolean | undefined` in `lib/types.ts` only because the
  seeded cast omits it, which the predicate treats as "not suppressed".

⚠ **One claim in the old follow-up note was already stale.** It said
`AnalyticsView`'s `!t.matchedDocId` "counts every transaction on live data".
That was true until Phase 4 (1 Sep 2026) taught `toLocalTransaction` to fill
`matchedDocId` from the contract's new `matchedDocumentId`; since then the id is
set on exactly the CONFIRMED rows, so the tile was wrong by the SUGGESTED,
EXCLUDED and suppressed lines (10 vs 6) rather than by the whole feed.

**Bundle** — paired A/B, two builds back to back, exact `gzip -c | wc -c`:
floor 203,481 → 203,522 B (**+41 B**); worst route (`ClientDetailView` + its
embedded `BankView` chunk) 244,997 → **245,050 B**, i.e. **+53 B** and
**4,950 B of headroom** against the 250,000 B budget.

## The correction-integrity package (5 Sep 2026 — review items 22/36/46/47, feeding 29)

A reviewer typed £9,000 of tax onto a £994 zero-rated invoice, "jhngbhf" into
Category, a 2027 date, and walked a webcam selfie to Ready — every layer silent.
The ruling (Mubashir): **warn with an Ignore button, never hard-block the
human**; hard-refuse only where a hard rule exists. What this app owns:

- **`lib/correctionChecks.ts`** mirrors the SERVER's deterministic checks
  (`validation-dedupe/correction-checks.ts` — tax exceeding the total, sign
  disagreement, future / >7-years-old document date, money/category typed onto
  a non-financial document). ⚠ **Change the two together** — the dialog's
  warning and the proposal review's restatement must not disagree. Live-only by
  construction: the staging path that reaches the dialog exists only with the
  API on (METH_MODE §1 holds).
- **The correction dialog opens on the WARNING when checks fire**
  (`CodingProposalModal`): **[Ignore — I'm sure]** reveals the ordinary
  Review → Approve card with the ignored warning RESTATED inside the review
  detail (`role="alert"` in `CodingProposalCard`); **[Go back and fix]** hands
  the TYPED value back to the field (`reopenEdit` now restores the staged
  value, not the field's old one — "fix what you typed"). Ignore proceeds with
  the ORIGINAL typed value; nothing is rewritten. The checks read
  `DocumentDetailData.checkContext` — raw header pence/ISO dates off the wire
  document, never parsed back out of display strings.
- **The junk-category refusal is the SERVER's** (chart membership, checked at
  proposal creation) and arrives on the card through the existing
  `failedOnCard` path with its reason. ⚠ **The chart select/datalist is NOT
  built** — no contract operation serves a chart to the browser; the G7 delta
  is written in the review notes (item 47). Free text + server refusal is the
  standing state.
- **"Confirmed by you", never a percentage** (item 22): `ExtractedField` gained
  `humanConfirmed`, set from `provenance === 'HUMAN_CONFIRMED'` in
  `toDetailData`, and DocumentPreview renders the words instead of "100%
  confident" — the old badge read as the system endorsing whatever was typed.
  §13.3 is intact: the provenance line still says "human confirmed — corrected
  in review"; only the CONFIDENCE presentation changed, and machine-read rows
  keep their percentage.
- **The TYPE gate, mirrored** (items 36/47): `Document.docType` crosses the
  boundary now (`toLocalDocument`; undefined on the synthetic cast, so
  synthetic is byte-for-byte unchanged). `readinessOf` and `missingMandatory`
  put 'Type' FIRST when it is OTHER — matching the server's readiness rule,
  which now refuses READY for OTHER/unclassified — and DocumentPreview's
  Path-to-Ready panel leads with "cannot be Ready until its Type is corrected"
  plus a Correct-the-Type button (the `readyComplete` copy is withheld while
  the gate holds, because "every field is present" would contradict it).
  ⚠ 'Type' is deliberately NOT a `BASE_MANDATORY` member: that list is the join
  key for the practice's mandatory-fields settings, and Type is a rule, not a
  toggle.
- **The D46 flag follows the document** (item 47): a live row whose `docType`
  is OTHER wears "Not a financial document" (red) — ClientInbox's doc cell and
  flag column, DocumentsView's status column, and the DocumentPreview header.
  The publish review's restatement is server-side (the ⚠ Checks section, keyed
  on the MACHINE extraction's verdict, so a human's later Type correction does
  not erase it).
- **The "⚠ Checks" review sections cost zero web bytes** (frontend rule 9):
  they are ordinary `{heading, entries}` sections and `LiveProposalCard`
  renders them unchanged — pinned in `LiveProposalCard.test.tsx`, along with
  the fail-closed half (a review the parse refuses still withholds Approve).

Tests: `lib/correctionChecks.test.ts` (property-style, mirroring the server
suite), the DocumentPreview warning-flow/Type-gate/Confirmed-by-you cases, and
the LiveProposalCard section pins.

**Bundle (5 Sep 2026, node-zlib closure walk at gzip level 6 — NOT a paired
A/B; other lanes' drift baked in):** every route under budget except the
pre-existing `AIWorkspaceView` breach (295,486 B, ~+200 B from the
floor-resident readiness/selectors/types edits). `InboxesView` 249,708 B
(292 B headroom — still the thinnest), `ClientDetailView` 248,289 B. The
warning-step UI and `correctionChecks.ts` land on the document-detail chunks
(DocumentPreview/CodingProposalModal are already lazy), not the floor.

## Bundle: the Chases dark-mode fix + theme persistence (3 Sep 2026)

Paired A/B, two builds back to back in one session, exact `gzip -c | wc -c`. Worst route is `ClientDetailView` plus its separate `BankView` chunk on top of the shared floor.

| | baseline | with both changes | delta |
|---|---|---|---|
| shared JS floor (`index` + stub + `query` + `react`) | 205,075 B | 205,208 B | **+133 B** |
| `ClientDetailView` + `BankView` | 41,547 B | 41,533 B | −14 B |
| **worst route, total JS** | **246,622 B** | **246,741 B** | **+119 B** |
| `ChasesView` chunk | 15,896 B | 15,769 B | **−127 B** |
| `index.css` (not in the JS budget) | 16,503 B | 16,388 B | −115 B |

**Worst route 246,741 B against the 250,000 B budget — 3,259 B of headroom.** The whole +133 B of floor is the theme work (`theme-preference.ts` plus the two AppContext call sites); the colour fix is *negative* on its own route, because it reuses `InboxesView`'s class strings byte-for-byte and because collapsing `STAGE_LABEL` from `{light, dark}` to one `cls` deleted five dead light-ground strings. The CSS shrank because Tailwind no longer generates `bg-zinc-50/100/200`, `divide-zinc-100`, `bg-pale`, `text-black` or `hover:bg-black` for anything.

⚠ **The baseline measured 246,622 B against the 246,438 B this file's neighbours were quoting a day earlier — +184 B of drift from other lanes, with nothing of mine in it.** That is why the table above is a paired delta and not two independent measurements, and it is why an unpaired "before" from an earlier session is worth less than it looks. ⚠ Mid-run the build broke on `WorkflowEditor` not being exported from `ApprovalsView` — another lane mid-refactor — and resolved on its own within a minute; the numbers are from after that.

## The practice team is live, and `/invite` exists (2 Sep 2026)

**The Team screen was a drawing.** "Invite colleague" opened a local record
editor whose `onSave` reached `AppContext`'s `saveColleague` — a bare
`setColleagues(...)` that evaporated on reload — and the chat surface's
`UserInviteForm` rendered *"Invitation sent to {email} as {role}."* over an
`onApprove={() => undefined}`. Neither had an operation behind it, because until
this change the contract had none: the only member endpoints were a CLIENT's own
users, which explicitly refuse every practice-level role.

| File | What it is |
|---|---|
| `api/team.ts` | `GET`/`POST /v1/practice-members` — the firm's own people |
| `api/invitation.ts` | the invitee's two calls, kept apart from the Team screen's |
| `views/invite/InviteView.tsx` | `/invite?token=…`, its own lazy route |

Seven things that are decisions, not details:

- **`SliceName` was NOT widened**, and `api/team.ts` computes its own
  `sliceStatus` — the `ExportView` precedent. `slices.ts` names the demo route's
  context arrays; a member would put this module on the shared bundle floor for
  every route (the reachability rule under *Bundle*). `DataSourceBadge`'s `slice`
  prop is already a plain `string`.

- **⚠ THE PER-PERMISSION TICK-BOXES ARE GONE.** `memberships.permissions[]` is
  read by NOTHING — `approvals/assert-can.ts` says so and explains why it cannot
  start reading it — and three incompatible vocabularies for it existed across
  the seed, this screen and the chat card. A toggle that governs nothing is the
  same lie as an invite button that sends nothing; both were fixed together. What
  decides authority is the ROLE and `isOwner`, and both are now shown.

- **`UserInviteForm.tsx` is DELETED**, and as of 2 Sep 2026 so is the
  **`INVITE_USER` intent itself, end to end.** Deleting the card left four live
  producers with no consumer, all synthetic-only and therefore silent: the
  classifier in `lib/resolver.ts` still matched "invite a colleague" and answered
  *"Fill in the invite below…"* over an `IntentRenderer` `default` that returns
  `null`; the tour seeded the intent AND told the viewer to type it; and the
  union member in `lib/types.ts` was what let all of that keep compiling. All
  four are gone — the pattern, its reply message, the `chat-invite` step, the
  `team` step's `ask`, the canned `replies.inviteUser`, and the union member.
  "Invite a colleague" now falls through to `GENERAL`, whose reply says what the
  chat actually does; inviting is the Team screen's button. ⚠ **`docs/Source_Of_Truth.md`
  §378 still lists "user invite" among the chat forms** — the SoT is a governance
  document and is Shakib's to amend, so the divergence is reported, not edited.

- **The live colleagues table is a genuine fork from the synthetic one, and that
  is the OPPOSITE call from the Clients board — so the reason matters.** M7
  deleted `LiveClientsView` because it rendered a REDUCED board: every column
  existed as a fact and simply had no field, and the answer was to widen the
  endpoint. Here the missing columns are location, job title, avatar and
  permission chips — three do not exist in the schema at all and the fourth is
  read by nothing. Widening the contract to carry them would be inventing data to
  fill a table.

- **⚠ `hideFinancialFields` is carried by the contract and deliberately NOT
  rendered.** Nothing in this release reads it when serving a document, so a
  "Finance hidden" pill would announce a protection that is not in force. It
  comes back the day the redaction does.

- **⚠ The invite form's NAME fields went for exactly that reason** (2 Sep 2026).
  It asked for "First name (optional)" / "Last name (optional)", `api/team.ts`
  put them on the wire, and `practice-team.service.ts` read neither — `invites`
  has no column for a name. `InviteView` then asks the invitee for their own as
  **required** fields, so even a persisted value would be overwritten by the
  person it describes. The rule this screen already states ("a field whose value
  is discarded is a question asked in bad faith") applied to them and had simply
  not been noticed. `api/team.test.ts` now asserts the whole key set, so a re-add
  meets a test. Removing them from `PracticeMemberInviteRequest` is the contract
  half and is still owed (G7).

- **Pending invitations are on the same response and on the same screen**, with
  an amber "Invited — awaiting setup" pill and the expiry in Europe/London. An
  invitation nobody can see is an invitation nobody chases: an admin who invited
  someone on Monday needs to know on Friday it is still unaccepted.

- **The S14 rule is applied to every remaining local writer.** With a session,
  the colleague editor (and with it `saveColleague`, `removeColleague`,
  `sendPasswordReset` and the avatar picker) never renders; "Create team", "New
  task", the per-team edit pencil, the assignee select, the row status buttons and
  the two local bulk actions are hidden or disabled-with-tooltip, and each tab
  carries one banner saying why rather than repeating it per control. "Ask AI
  about workload" stays — opening a scoped chat is real either way.

### `/invite?token=…` — the invited colleague's journey

`portal === 'invite'` in `AppContext`, checked **before** the `'accountant'`
fallthrough and keeping `workspaceApiOn` false — the `/app/setup` precedent, and
the same reason: the person holding the link has no account, so a `/me` probe
could only 401 and a login wall would lock out exactly who the email invited.

M9's rules are inherited verbatim:

- **The token is scrubbed with `replaceState` BEFORE the first request**, so it is
  never in the history and never in the next outbound `Referer`. Pinned by a test
  that captures `location.search` from inside the mocked call.
- **`faultMessageFor`'s rule**: "check your connection" appears only for
  `code === null`. A code means a reply came back over the connection that
  sentence would blame. Pinned by test.
- **`EnrolStep` and `views/signup/qr.ts` are REUSED UNCHANGED** — `EnrolStep` is
  now exported from `SignupView.tsx`. A second enrolment screen is a second place
  the two-step could be got wrong, and getting it wrong costs the account: this
  release has no re-enrolment or reset flow. `NT-AUTH-008` therefore restarts
  enrolment here too, because it is literally the same component.
- **Unlike `/signup/check-email` this screen MAY name things** — the practice, the
  address, the role, who invited them. That one answers an anonymous caller who
  typed an address; this one answers somebody holding a token we emailed to the
  address it names, and every fact is already in the message they are reading it
  from. A password form for an unnamed employer is the phishing shape, not the
  safe one.

**Bundle.** `InviteView` is **4,207 B gzip** on its own chunk and shares
`SignupView` (9,690 B) because it imports `EnrolStep` from it — so the `/invite`
route is floor + 13,897 B. Measured clean with `gzip -c | wc -c`. ⚠ Other agents
have uncommitted work in this tree, so the absolute floor and worst-route numbers
in the table above are not attributable to any one change; re-measure on a clean
checkout before quoting a delta.
