# Mubashir review — running notes

Started 2026-09-05. Items are logged here one by one as they arrive, before any fix work begins.
Previous round: 15 items, 13 landed in #253 (`6105dad`).

Format per item:
- **Original** — what Mubashir said, verbatim (translated if the source was Bengali, with the original kept).
- **Image** — path(s) to the linked screenshot(s).
- **Brief** — what I understood: the actual problem, where it likely lives, and what "fixed" looks like.

---

<!-- Items get appended below as they arrive. -->

## Items 1–15 — backlog, reconstructed from PR #253 (`6105dad`)

Mubashir's original words and screenshots for these were not captured in this file (the round predates it); the descriptions below are reconstructed from the PR body and commit messages. **13 of 15 landed in #253; two halves remain open, blocked on scope from Shakib.**

| # | Item (reconstructed) | Status | Where it landed |
|---|---|---|---|
| 1 | "ok thanks" got the capability pitch instead of an acknowledgement | ✅ Done | chat prompt `chat-workspace/2026-09-05.1`, new `general-003` eval case, §9.8 gate re-recorded live (PASS, intent 93.3%, 0 injection leaks) |
| 2 | App should default to light mode until the user picks | ✅ Done | `theme-preference.ts` + inline script — OS preference no longer consulted |
| 3 | Setup link should prefill the registered email / name the workspace | ✅ Done | `POST /portal/setup-previews`, uniform `NT-OTP-001` refusals |
| 4 | Business details asked at onboarding + signed-in portal handoff after Stripe | ✅ Done | `PUT /portal/business-profile` (fourth `PermittedAction`, `business.profile.manage`) + skippable every-field-optional details step; onboarding session adopted into the portal's sessionStorage slot |
| 5 | Landing page needs a client-portal door | ✅ Done | `LandingView` |
| 6 | Portal needs its own theme toggle | ✅ Done | `BusinessPortalShell`, self-contained |
| 7 | Chase composer must not force a mobile number | ✅ Done | mobile optional — the engine resolves the registered contact |
| 8 | UK-first mobile handling (07… → +44) and UK-first copy | ✅ Done | chase composer |
| 9 | "Ask them for their bank statement" dead-ended · full task-and-chat system in the chat UI | ✅ Done (5 Sep, second pass) | statement-request flow landed in #253; the chat-system half landed after Shakib supplied the verbatim wording — see "Items 9 and 12, closed" below |
| 10 | Portal upload should accept CSV/XLSX/XLS | ✅ Done | client-side accept widened (server had it since 28 Aug) |
| 11 | Client should be able to name an upload; upload on explicit button, not on select | ✅ Done | `PortalUploadRequest.note` (contract first); note → display filename, raw words → provenance; staged files + explicit Upload button |
| 12 | Documents should arrive on the board in real time | ✅ Done (5 Sep, second pass) | the 30 s board poll (interim, #253) plus the REAL half: `GET /v1/notifications` + the header bell — see "Items 9 and 12, closed" below |
| 13 | Portal statements processed as invoices · document delete | ✅ Done | extractor prompt briefs STATEMENT/OTHER; ClientInbox rows get real reversible Move to Trash |
| 14 | A foreign business's statement imported silently into the wrong client | ✅ Done | `statement-ingest/account-holder.ts` — extracted account holder vs the business's names, `accountHolderMismatch` flag in `gapAnalysis` + WARN; flag never block (D46), silent when no holder read (D41) |
| 15 | Chase button on selected unexplained bank rows | ✅ Done | Bank-tab selection stages a real `chase.send` per business, composed server-side, released from Approvals (D44) |

**Open carry-overs from this round:** none — item 9's chat half and item 12's
real-time half closed on 5 Sep 2026 (second pass) after Shakib supplied the
verbatim wording and waived the scope question ("No need contract or anything,
do whatever Mubashir said, finish it").

## Items 9 and 12, closed (5 Sep 2026, second pass)

**Item 9 — original (verbatim):**
> Typed the phone number but the stage for review option is not enabled; here
> in this cat ui, full regular task and chat system must be implemented

**Image:** the chase composer card in the WORKSPACE chat (recipient mobile
typed, "Stage for review" disabled) — so "this cat ui" is the accountant's chat,
not the client portal (the #253 round had parked it under the wrong surface).

**What landed:** the disabled-button half was #253's items 7/8. The
"full regular task and chat system" half:
- **Task coverage** — `ChatIntent` grew `SHOW_EXPORTS` and `SHOW_APPROVALS`
  (the two standing dead ends: export asks answered in prose, approvals asks
  falling to GENERAL). Prompt `chat-workspace/2026-09-05.2`, §9.8 re-recorded
  live and PASSING (34 rule cases, intent 94.1%, fields 100%, injection 0
  leaks), web renders both (`ExportsCard`, ApprovalsTable + queue link).
- **Chat system** — conversations are server-persisted
  (`chat_conversations` table, four contracted CRUD operations, the drawer
  hydrates/saves/deletes through `useConversationSync`), so a reload no longer
  loses every transcript. `POST /chat/turns` stays `x-nt-side-effect: none` —
  persistence is the caller's act.

**Item 12 — original (verbatim):**
> No real time notification in the portal or any sign of document arrival

**Image:** the Clients board (Zeplow Inc, 0/0) after a portal upload.

**What landed:** the real half on top of #253's 30 s poll —
`GET /v1/notifications` + `POST /v1/notifications/read-receipts` (the
`notifications` table's first reader), a `document.received` row written at the
sink for routed email/WhatsApp arrivals (portal uploads already wrote
`portal.upload`, chase auto-close already wrote `chase.closed`), and the header
bell: 10 s poll + window focus, whole-practice unread badge, mark-all-read,
click-through to the client.

## Item 16 — Request statement dialog: unusable period input, no channel choice, no preview

**Original (verbatim):**
> The request statement button is a good option for asking statement but the input field is not making any sense that what to type, instead, there should be option for selecting date in range, by month, by date, by year, by date-month-year (or UK format date selector); accountant can pick any of the four option and select; after that he should see option same as, that want to send via sms (tick mark with untick mark option, check box tbh), send via email (tick mark with untick mark option, check box tbh); after that, both email and sms format preview will be shown for reviewing (each time ai must write personalize the sms and email based on the accountant and the client, but for now use a single preset template, no need of ai, just note the personalization for later); after reviewing, accountant will confirm and will be sent

**Images:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 02.33.50.jpeg` — Bank tab, red arrow on the "Request statement" button beside "Upload statement".
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 02.33.49.jpeg` — the current dialog: a bare "STATEMENT MONTH" text field with "12" typed in and "Queue the request" disabled (the `<input type="month">` renders as an unlabelled free-text box in his browser, and the confirm gates on a `YYYY-MM` regex he has no way to discover).

**Brief:**
The current `RequestStatementDialog` (`apps/web/src/components/DynamicComponents/RequestStatementDialog.tsx`, staged from `BankView.tsx`) asks for one opaque month value and nothing else. Mubashir wants the dialog rebuilt as a short wizard:

1. **Period selection** — four selectable modes, UK-formatted: (a) date range, (b) by month, (c) by year, (d) a single specific date (d/m/y). The accountant picks a mode, then picks the value(s) with a proper date selector — never a free-text field.
2. **Channel selection** — two independent checkboxes: send via SMS, send via email (either, both).
3. **Preview step** — the composed SMS and email bodies shown for review before anything is queued. For now one preset template per channel is fine; the stated end-state is AI-personalised copy per accountant/client pair — **noted for later, explicitly not to build now**.
4. **Confirm** — accountant confirms and the request goes out (in our architecture: stages the `chase.send` proposal, released via Approvals per D44 — his "will be sent" reads as the existing queue-for-approval path, not a bypass).

Repo realities that will shape the fix: the engine's statement request (`statementPeriod` on `chase.send`) currently carries a single month, so range/year/date modes likely need a contract/engine widening (G7 territory); the message is composed **server-side** at review, so the "preview" step either surfaces the server's composed copy or a client-side mirror of the preset template; and ID currently has **no SMS transport** (email is the channel since launch M8), so the SMS checkbox needs a decision — offer-and-honestly-disable vs. build against AWS End User Messaging. Personalisation via AI = future work only.

## Item 17 — Bank transactions: credits show a minus sign, and "Credit — no document" is green when it should be red

**Original (verbatim):**
> If accounting is credited then it must show plus sign, why minus sign? This must be fixed
>
> also any lack of document is a red flag, not green just because it is credited to the bank account; the amount column number could be green, but the evidence column must be red as well as the no document tag

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 02.36.49.jpeg` — the Bank transactions table (Zeplow Inc.): three BACS WORLDPAY SETTLEMENT credit rows arrowed, each showing a green **−£543.98 / −£2,373.49 / −£2,383.30** in the Amount column and a green-toned "Credit — no document" pill in Evidence, while debit rows show a red "No document" pill and plain amounts.

**Brief:**
Two distinct defects in `apps/web/src/views/BankView.tsx`, both in the transactions table columns:

1. **Sign convention** (`BankView.tsx:642`): the Amount cell renders `currency(t.amount)` raw and colours it green when `t.amount < 0` — so a credit displays as **−£543.98 in green**, sign and colour contradicting each other. Mubashir's rule: money **into** the account shows a **plus** sign (`+£543.98`). Keep green for credits if we like, but the sign must say "in". Fix is at the display: render credits as `+` (derive direction from `isCredit` — the reconciled signal `api/bank.ts` maps from the server's signed pence — not from the local sign of `amount`). Check the same convention everywhere amounts render (table footer, CSV export at `BankView.tsx:1632`, detail panes) so one screen doesn't disagree with another.

2. **Evidence tone** (`BankView.tsx:635-637`): a credit with no document currently gets a *blue/green* pill ("Credit — no document") while a debit with no document gets *red* ("No document"). His rule: **missing evidence is a red flag regardless of direction** — the pill keeps its "Credit — no document" wording but goes **red**, same as "No document". The amount figure may stay green; the Evidence column must not soften just because money came in.

No contract or server change needed — both are pure display-tier fixes in the web app. Worth a quick sweep for the same green-credit-pill / signed-amount pattern in `ClientDetailView`'s embedded BankView (same component, so free) and any analytics/chat cards that render bank lines.

## Item 18 — Client portal: sent-documents count exists, but no browsable list with preview/download/controls

**Original (verbatim):**
> From the client portal there is option to see how many document is sent but no option to see the actual list of sent document with preview option download option and with other document control functions

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the business portal Home tab (Zeplow Inc.): the counter row reads **1 DOCUMENTS SENT**, and the "Recently sent" card shows a single row ("NatWest · 31 Aug 2026 · With your accountant") with no way to open, preview or download it.

**Brief:**
The live business portal (`apps/web/src/views/business/LivePortalHome.tsx` / `LivePortalUpload.tsx` over `GET /portal/documents`) shows counts and a "Recently sent" status list, but a row is inert: no full sent-documents list page, no preview of the image/PDF, no download, no other document controls. Mubashir wants the client to be able to open the actual list and work with each document.

What exists to build on: `GET /portal/documents` already lists the portal's own documents with the five server-side portal status words; the practice side has `DocumentViewer` (zoom/rotate/download) but that is a practice-app component fed by a practice-session presigned URL. The gap is contract-shaped as much as UI-shaped: the portal bearer currently has **no operation that returns a document's original bytes/presigned URL** (the portal security list covers uploads, context, sign-in, completion — not an original read). So:
1. **UI half** — a "Documents" surface in the portal (either a fifth tab or the Upload tab's list made primary) listing every sent document with status, and per-row preview + download.
2. **Server/contract half (G7)** — a portal-scoped read of a document's original (presigned URL) for documents that client's own session uploaded/owns. Needs Shakib's contract approval.
3. **"Other document control functions"** — scope needs deciding: rename is plausible (the `note`/display-filename mechanism from item 11 exists), delete/replace should likely map to "send another copy" rather than real deletion (D46/state-machine: the accountant's pipeline owns document state, and a client deleting evidence out of a practice's books is not a portal power). Keep the portal light — it's the 250 kB budget's most protected route.

## Item 19 — Category must never be null: always a suggestion with a confidence score

**Original (verbatim):**
> It is very important that the ai is not giving any null value, the backbone of accounting is understanding the category or the accounts; you were told to fix the understanding, at least give suggestion with confidence score; there won't be no written account category on any invoice ever; this requires deep understanding of accounting, use higher capable model for this if possible

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — DocumentPreview for an Aldgate Meats Ltd invoice (Zeplow Inc., £994.00, To Review): every extracted field 95–99% confident, but **Category is "—" at 0% confident (red)**, with the escalation note *"Nothing on this client's chart matches what this document describes, and nothing was guessed at. This client has not bought from this supplier before, so there is no prior treatment to be consistent with."* Processing log shows `code: escalated`. Path to Ready blocks on Category.

**Brief:**
The coding ladder (`apps/api/src/modules/rules-suggestions`) currently has a deliberate ESCALATE outcome: when nothing on the client's chart of accounts matches, it refuses to guess and hands the accountant a named reason plus a blank Category. Mubashir is overruling that posture for this case: **an escalation with no candidate is not acceptable** — a meat supplier invoicing a restaurant is exactly the thing an accountant expects the AI to categorise. His rules:
1. The AI must **never return a null category** — always produce a best-guess suggestion (e.g. "Cost of goods sold / Food purchases") **with an honest confidence score**, even when confidence is low. A low-confidence suggestion + the explanatory note beats a dash.
2. Invoices never print their own account category — so "nothing written on the document" is not a reason to abstain; the categorisation must come from understanding what the goods/services *are* (meat → food costs for a restaurant), i.e. real accounting reasoning over the line items + the client's industry profile.
3. **Use a higher-capable model** for the coding step if possible (the intake questionnaire/industry context is available as coding context per SoT §24.4).

Repo realities: the ladder's "refuse, never fuzzy-match, only codes on the client's synced chart" rule exists so food costs don't silently become drink costs — the fix must keep the suggestion **as a suggestion** (the Category row's `value` stays `'—'` for `missingForReady`; accepting still goes through the ordinary correction → Review → Approve path, all already built for the SUGGEST outcome). So the shape of the fix is server-side: when the chart-match tier fails, fall through to a model-reasoning tier that picks the *nearest chart code* (never an invented one) with a confidence score and a note explaining the reasoning — turning today's ESCALATE-with-nothing into SUGGEST-with-low-confidence wherever a chart code plausibly fits, and reserving ESCALATE for genuinely undecidable documents. Model choice for that tier is a config/cost decision (Bedrock model tiers, ADR 0001) — flag to Shakib.

## Item 20 — Coding correction: modal + blurred backdrop must dismiss after the confirmation shows

**Original (verbatim):**
> After changing the category of an invoice manually the modal backdrop with the blend balk screen must disappear after showing the confirmation

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — after approving a category correction: the green toast "Correction approved — Category is now human-confirmed." sits at the top, but the whole DocumentPreview underneath is left **blurred behind a dark scrim** — the coding-proposal modal's backdrop never clears, leaving a dead screen the user has to close by hand.

**Brief:**
The manual-category flow (DocumentPreview → correction → `CodingProposalModal`, the create → Read review → Approve ritual) shows its success state but does not release the dialog: the backdrop/scrim and blur stay after "Correction approved". Expected behaviour: show the confirmation, then **auto-dismiss the modal and backdrop** (brief delay or immediate close with the confirmation surfaced as a toast on the underlying screen), returning the user to the now-updated document detail. Fix lives in `apps/web/src/components/DynamicComponents/CodingProposalModal.tsx` (and possibly its host in `DocumentPreview`) — on approve-settled, call the modal's `onClose` after the confirmation renders instead of parking on the outcome banner. Note the Approvals queue deliberately keeps decided cards mounted with an outcome banner (`ApprovalsLiveQueue`) — that pattern is right for a queue and wrong for a modal over a document; don't "fix" the queue while fixing this. Pure web change, no contract impact.

## Item 21 — "Received via" says sms-link for a direct portal upload; map all receiving channels properly

**Original (verbatim):**
> wrong tag for received via; the document is received via client direct upload option from the portal without any chase, make sure to map out all receding information properly and fix this issue

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — Zeplow Inc. → Costs → Ready: the Aldgate Meats invoice row's "Received via" column shows an **`sms-link`** tag (red arrow), but the document was uploaded by the client from the signed-in business portal's Upload option — no chase, no SMS link involved. (Same wrong provenance visible in item 19's image: header "VIA SMS-LINK", processing log "uploaded-by-delegated-session".)

**Brief:**
One server channel is doing two jobs: every portal upload — whether through a **chase link** (`/p/:token`) or the **signed-in business portal** — lands as `DocumentChannel.SMS_PORTAL`, fixed server-side (`LivePortalUpload.tsx:143` says so in as many words), and `api/documents.ts:79` maps it to the app's `'sms-link'` source. So a client's direct portal upload wears a chase-link tag, and the accountant reads a chase that never happened. Compounding it: ID has no SMS at all (M8), so "sms-link"/"VIA SMS-LINK" is doubly wrong on every surface, and the Costs table renders the raw slug `sms-link` instead of a translated label (the catalogue's label for it is "Chase link").

Fix has two layers:
1. **Channel split (server/contract, G7)** — distinguish "chase-portal upload" from "business-portal direct upload" at ingest. The app already has an unused `'portal'` member in `SourceChannel` (`lib/types.ts:20`) waiting for exactly this. Options: a new `DocumentChannel` enum value (contract change, Shakib), or derive the display channel from provenance the server already records (chase-linked session vs ONBOARDING/account session — the upload claims know which trust level they came from). Mubashir's ask is "map out all receiving information properly", i.e. audit **every** intake door (email, WhatsApp, chat upload, workspace upload, chase portal, business portal, CSV/statement) and make sure each renders its true channel.
2. **Labels (web)** — whatever the split lands on, the rendered words must be honest: "Client portal" for direct portal uploads, and the chase-link label must not say "SMS" while ID sends none (the M8 honest-copy rule). Sweep the render sites: ClientInbox/Costs "Received via" column (raw slug today), DocumentPreview's "VIA SMS-LINK" header, DocumentsView, AnalyticsView channel mix, InboxesView channel filter.

## Item 22 — Manual corrections get no AI sanity check: £9,000 tax on a £994 invoice, silence

**Original (verbatim):**
> Put tax amount a unrealistic number and the ai is silent, no warning or nothing; accountant can put wrong number and make mistake, but the ai should be there for helping, while confirming any manual change pass it under ai suggestion so that if there is any confusion from the ai as a second opinion, the accountant gets option to correct himself (so put a button along with the confusion that is "ignore" ai also can make mistake too)

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the Aldgate Meats invoice after a manual correction: **Tax amount £9,000.00 at "100% confident"** on a £994.00 zero-rated invoice (the document itself prints "Total (zero-rated) £994.00"), state Ready, no warning anywhere. The 100% badge is the human-confirmed provenance convention, which here reads as the system endorsing an absurd figure.

**Brief:**
A manual field correction goes through `parseCodingDraft` (type/format checks only) → Review → Approve, and nothing ever asks whether the *value makes sense*: tax exceeding the gross total, tax on a document whose own text says zero-rated, a total that disagrees with the line items. Mubashir wants an **AI second-opinion pass on every manual change**:
1. When a correction is confirmed, run it past a sanity check (deterministic arithmetic first — tax > total, tax+net ≠ total, negative values — and/or a model pass that reads the correction against the document's own extracted content).
2. If the check is confused, show the concern to the accountant **with an "Ignore" button** — the AI is advisory, the human always wins ("ai also can make mistake too"). Ignoring proceeds with the original correction; not ignoring returns to editing.
3. This is a helper, not a gate — the accountant may still be right (his words: accountants can make mistakes, so can the AI).

Where it lands: cheapest honest version is deterministic cross-field validation at the correction boundary (client-side warn in the correction dialog + server-side advisory on the proposal review — the review card already renders arbitrary server sections, so a "⚠ tax exceeds gross" section costs zero web bytes per rule 9). The model-backed second opinion is a server concern (rules-suggestions / extraction lane) and should ride the same seam as item 19's reasoning tier. Also worth noting: the "100% confident" human-confirmed display reads wrong when the human just typed nonsense — maybe "Confirmed by you" instead of a percentage. Review → Approve flow itself unchanged; the check slots in before/at review, never bypassing it.

## Item 23 — Publish dialog can't scroll; Approve unreachable, so nothing can be published

**Original (verbatim):**
> Scroll not working wtf have you checked, not being able to publish

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — `PublishBatchDialog` ("Release 1 item for export", Zeplow Inc.) with the staged review card mounted ("Release for export — AWAITING REVIEW", server-computed preview: Items 1, Gross £994.00, VAT £9000.00). The card is cut off mid-heading at "THE ACCOUNTING ENTRY THIS RELEASE WILL PUT IN THE IMPORT FILE" and **the dialog will not scroll**, so [Read review]/Approve below the fold are unreachable — publishing is impossible. (The VAT £9000 is item 22's bad correction flowing through, separate issue.)

**Brief:**
`PublishBatchDialog.tsx` wraps the shared `DynamicComponents/Modal`, whose 2 Sep fix (`max-h-full` wrapper + `overflow-y-auto overscroll-contain` children box) is supposed to make every tall dialog scroll — and per the module notes jsdom can't verify it, only a class-contract test does. With `LiveProposalCard` mounted inside (it grows by the server's whole review), the outer scroll demonstrably does not work in the real browser. Likely suspects to check in the browser, not jsdom: the Modal children box failing height-constraint when its parent is the flex `items-end`/centred wrapper (a `max-h-full` chain needs every ancestor to actually bound height); the dialog's own inner `max-h-52` list trapping scroll; or the review card introducing an unbounded child that defeats `overflow-y-auto` (missing `min-h-0` on a flex child is the classic). **Severity: release-blocking** — this is the only publish path since the S14 sweep removed local writers, and Published gates Export (D42/D43). Fix in the Modal frame (so every tall dialog benefits), verify in a real browser at a normal laptop viewport, and consider a Playwright/CDP smoke for "Approve is reachable" since jsdom computes no layout.

## Item 24 — Publish dialog copy lectures the super admin about needing the super admin

**Original (verbatim):**
> I'm the super admin and it is giving me lecture; fix the text highlighted based on the model and the situation

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — `PublishBatchDialog`, pre-staging screen, highlighted sentence: *"Anyone in the practice can stage a release; only your practice's super admin can approve one. The server decides, not this screen."* — shown to a user who **is** the super admin, reading as a lecture about a restriction that doesn't apply to them.

**Brief:**
The D44 note in `PublishBatchDialog.tsx` is deliberately generic because the session (`/me`) carries the role but **not `is_owner`**, so the dialog "can never claim the permission IS held" (its own documented rule) — it names who releases and says so *more* plainly when the role is not the release role. Mubashir wants the copy **role-aware**: when the signed-in user can approve, don't recite who can't. Resolution options, in order of preference:
1. **Widen `/me` to carry `isOwner`** (G7 contract change, Shakib) — then the dialog can branch honestly: super admin sees "You can approve this after reading the review"; everyone else keeps the current sentence naming who releases.
2. If the contract can't move now, at least soften the unconditional sentence so it informs rather than lectures (e.g. lead with what the button does, put the who-releases fact in secondary text) — but any phrasing claiming "you can approve" without the server-known fact would violate the dialog's own honesty rule, so option 1 is the real fix.
Same sweep should cover the sibling D44 sentences on other staging surfaces (`RequestStatementDialog`'s "sends only when your practice's super admin approves it", OffboardClientDialog, LiveProposalFlow copy) so the whole family goes role-aware together, from the same `/me` fact.

## Item 25 — Chat gives a confidently wrong answer: "nothing missing" for a client with a screen full of undocumented transactions

**Original (verbatim):**
> Ai is giving wrong answer, nothing was chased or finished, make sure to maintain proper ai memory and analysis if asked any question, without proper thinking and analysis ai must not reply

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — chat, Practice Admin, 1 client in scope. User: *"What is still missing for Zeplow Inc.?"* Assistant: *"Here you go: **Nothing missing for Zeplow Inc. — every detected gap is closed or already chased.**"* — while the Bank screen (item 17's image) shows a page of Zeplow rows tagged "No document", and no chase was ever sent or completed.

**Brief:**
The MISSING intent's answer contradicts the product's own Bank screen. The reply is the `LiveMissingCard` empty-state copy, and that card is read-only over the live bank slice (unmatched + non-suppressed via `isUnexplained`) plus open chases — so the falsehood is almost certainly **data plumbing, not model reasoning**: the card computed over an empty/mis-scoped set. Prime suspects: the chat scope's business id not resolving to the server's Zeplow id (the seed↔server id bridge — `navigation.businessId` rewrite or `isSameClient` failing for this cast), the bank slice not being hydrated in the chat context, or the server's grounded answer being generated without reading the transactions at all. Diagnose which layer produced the sentence first (client card empty-state vs. server §9 grounded turn).

Mubashir's general rule on top of the specific bug: **the AI must not answer a data question without actually analysing the data** — if the grounded read fails or returns nothing verifiable, say so ("I can't verify right now") rather than emitting a confident all-clear. An empty result set and a failed/mis-scoped read must render differently: "nothing missing" may only be said when the transactions were actually read and genuinely all matched/chased. Add an eval case for this exact turn (client with unmatched undocumented lines → the answer must enumerate them), since §9.8's gate is where accuracy claims live.

## Item 26 — Duplicate approval requests for the same document; super admin's own actions shouldn't queue for their own approval

**Original (verbatim):**
> For same document, multiple review request has come in the approval tab, there is two mistake, 1. The super admin himself was doing it, so need of any approval here, 2. Keep track for each approval request sent by the team member added by the super admin (super admin can be multiple each will not require approval if it is super admin account), and make sure no duplicate approval request is sent

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — Approvals queue, **8 pending**, at least six identical "Release for export · ZEPLOW INC. · proposed by CMTNDDE8P00337710E1OQD4J…" cards, all REVIEWED, all the same proposer, all over the same one Ready document.

**Brief:**
Two asks plus one observation:
1. **Duplicate suppression (clear-cut bug):** nothing stops staging the same `publish.batch` over the same document repeatedly — each click of "Stage for review" mints a fresh proposal. Very likely amplified by item 23: with Approve unreachable behind the broken scroll, he closed and re-staged six-plus times, and every attempt stayed pending. Fix server-side: refuse (or return the existing proposal for) a create whose kind + business + document set matches an already-pending proposal — idempotent staging, with the dialog surfacing "this release is already awaiting review" and linking to it. Also worth a "stale pending duplicates" cleanup path so his current queue can be cleared.
2. **Self-approval flow for super admins (product decision, D44-adjacent):** his ruling — when the actor **is** a super admin (and there can be several), their own staged action shouldn't sit as a separate approval request for themselves; team-member requests are tracked per member and do require the release. Note carefully: Governance §10's spine (no state change outside ActionProposal / Review → Approve, enforced server-side + DB trigger) must survive — the cheapest compliant reading is a **fast path, not a bypass**: super admin stages and the same dialog immediately walks them through Read review → Approve in one flow (the machinery already exists — `LiveProposalCard` mounts right there), so the record is identical but nothing lingers in the queue. Removing Review → Approve for super admins outright would be a Governance change — Shakib's call, flag it.
3. **Per-member attribution:** the proposer renders as a raw CUID (`CMTNDDE8P00337710E1…`) — resolve it to the member's name so the queue reads "proposed by Mubashir", which is half of his "keep track for each approval request" ask.

## Item 27 — Approvals have no Deny: reject-with-reason, email the proposer, downgrade the document with a visible tag

**Original (verbatim):**
> There is no option for denying an approval, if the super admin denies to approve it then it must ask for the reason, and the reason and declined message must be sent via email to the team member and must be shown in the table row in the document row; and this document must be downgraded from ready tab to review tab with tag that it is rejected or denied by the super admin for this reason in a column

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — an opened review card (Release for export, doc_d6682c…): the only actions are **Cancel** and **Approve**. No reject/deny.

**Brief:**
The review card (`LiveProposalCard`) offers Approve and Cancel; Cancel is the contracted *withdrawal* (proposer takes it back), not a reviewer's refusal — there is no "deny with reason" in the product. Mubashir wants the full rejection loop:
1. **Deny button** on the review, gated to whoever holds the release authority; denying **requires a reason** (free text).
2. **Notification**: the reason + declined message emailed to the team member who staged the proposal.
3. **Visibility**: the denial and reason shown on the document's row (a column/tag in the client's document tables).
4. **State**: the document drops **Ready → To Review** wearing a "rejected by super admin: {reason}" tag, so the composer sees exactly what to fix and where.
Scope honestly: this is a **contract + server + web** feature (G7 — new proposal decision `REJECTED`-by-reviewer with reason, a document state transition, an outbound email through the established mailer, plus web columns and the deny UI). It also interlocks with item 26 (dedupe/self-approve) and item 22 (a deny is exactly what the £9,000 VAT release deserved). Needs Shakib's contract sign-off before a PR opens.

## Item 28 — Export date inputs render US-format MM/DD/YYYY; must be UK-readable

**Original (verbatim):**
> Why the fuck there is this 2025 recommendation here to export data?? The date selector must be in in this format 3rd March 2026 - 12th December 2026 type, not 07/30/2025

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — ExportView: FROM/TO inputs showing **07/30/2025** (month-first), after taking the "Use 30/07/2025 – 30/07/2025 instead" suggestion; below, the NT-EXP-001 refusal for that single-day 2025 period.

**Brief:**
Two halves — the "2025 recommendation" half is item 29's (the suggestion is *correct*, see below); the format half is real: `ExportView`'s FROM/TO are native `<input type="date">`, which render in the **browser/OS locale** — his environment shows US month-first, violating the repo invariant (UK d/m/y everywhere, Europe/London rendering). A native date input's display format cannot be forced from HTML, so the fix is a UK-formatted date control: keep the native picker for input but render the chosen value as UK long-form ("30 July 2025", his ask is "3rd March 2026" style), or replace with the app's own picker. Same treatment for the refusal text's dates (currently 30/07/2025 — already d/m/y, fine) and the "Use … instead" button label. Also ties into item 16's ask for a proper UK date-range selector — one date-control decision should serve both.

## Item 29 — Export "major issue": root-cause analysis (deep-dive done)

**Original (verbatim):**
> There is a major issue with the export option, do deep research on it what is the problem and how to solve it, the suggest is for past which is wrong, also not exporting at all

**Images:**
- Item 28's image — NT-EXP-001: *"1 Published document(s) were found for 30/07/2025 to 30/07/2025, but none of them could be exported. This document's figures do not add up… Gross, net and VAT must share one sign (debit positive, credit negative). Mixed signs are a parsing accident, not a transaction."*
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the prior attempt: period 01/09–05/09/2026, NT-EXP-001 "No document dated in period… There is 1 Published document outside that period, dated 30/07/2025 — the export selects on the document's own date… Use 30/07/2025 – 30/07/2025 instead."

**Brief (root cause traced in code):**
Two stacked facts, **both by design and both correctly refusing — the real bugs are upstream**:
1. **"Suggest is for past":** the Aldgate Meats invoice is *dated 30 July 2025* — printed on the document itself (item 19's image, "Date: 30/07/2025"). The export selects on the **document's own date**, not the release date — the stated accounting rule (a document released today but dated last year belongs to last year's export; the contract says so, and the 2 Sep `publishedOutsidePeriod` work built exactly this suggestion). So suggesting 30/07/2025 is the exporter being right about a document that is genuinely dated 2025. If the PM finds that surprising, the open questions are (a) whether the demo/test document's date is just stale test data, and (b) whether the copy should explain "this document is dated 30 Jul 2025" more prominently — but selecting by release date instead would be a product/SoT decision for Shakib, and the current rule is the accounting answer.
2. **"Not exporting at all":** traced to `apps/api/src/modules/exports-public-api/canonical/canonical-row.ts` — `checkSignsAgree` refuses a row whose gross/net/VAT signs disagree. This document: gross £994.00, VAT **£9,000.00** (item 22's unchecked manual correction) → net = 994 − 9000 = **−£8,006** → mixed signs → `document-not-representable` → NT-EXP-001. The exporter is the **last line of defence working as designed** ("the last place it is cheap to refuse" — its own comment); the failure is that an impossible figure sailed through correction (item 22), through Review → Approve (the release review even displayed "gross £994.00, VAT £9000.00" — item 23's image — and nothing flagged VAT > gross), into Published, and only died at export.
**How to solve (the chain, not the symptom):** (a) item 22's sanity check at the correction boundary (tax > total refused-or-warned before it's ever stored); (b) the same arithmetic check at `publish.batch` review time, so the release review card *says* "⚠ VAT exceeds gross — this will not export" instead of presenting it neutrally; (c) the export refusal should name the document and offer the path to fix it (open the document, correct Tax amount), not just describe the accounting rule; (d) once the £9,000 is corrected back, the export of 30/07/2025 succeeds as-is. No change to the exporter itself is warranted.

## Item 30 — Chase composer includes matched/published and credit lines as chase candidates

**Original (verbatim):**
> One document was sent and was published from the transactions from the bank statement but the chase engine has included it for chasing, the ai in the chat section is very poor

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — a chase item-selection list (all rows pre-ticked): includes **FASTER PAYMENT TO ALDGATE MEATS LTD £994.00** (highlighted) — the transaction whose document was sent, matched and published — plus several **credit** lines (negative Worldpay settlements, Just Eat credit). Every transaction in the statement appears ticked as a chase candidate.

**Brief:**
The chat-side chase composer is offering lines that must never be chased: (1) the Aldgate Meats £994 line is **matched to a published document** — its evidence exists in the product; (2) credit/settlement lines (Worldpay payouts, Just Eat) are the exact category the `isUnexplained` predicate exists to exclude. The repo's own rule (2 Sep, "Unexplained is one predicate now") says `LiveChaseComposerCard` and `LiveMissingCard` read the unexplained set — unmatched + non-suppressed via `isUnexplained` — so either this surface isn't using the predicate, or the underlying data is wrong in chat scope: the live bank slice's `matchState`/`matchedDocumentId` not reflecting the confirmed match (same data-plumbing suspicion as item 25 — these two are almost certainly one root cause: **the chat lane's view of Zeplow's bank data disagrees with the Bank screen's**), or the seed↔server id bridge mis-scoping the client so the card composed over the wrong/unfiltered set. Diagnose items 25 and 30 together: reproduce in the live app, log what set each card actually received, and check whether the match-confirm + publish actually wrote `matchState: 'CONFIRMED'` on that transaction server-side. Also: every row **pre-ticked** is wrong even for genuine candidates — chasing is opt-in per line, default should be unticked or curated, not "tick everything".

## Item 31 — Chase draft ignores the selection, reads like a data dump, and cannot be edited

**Original (verbatim):**
> I've unchecked this transaction to be included in the chase, but the email is not updating based on the selection, also the email should be written with personal touch; there is no option to change the chasing email is any part, provide a edit option for the generated email if the accountant wants to change a word or the whole email or any sentence

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the chase composer (same surface as item 30): a transaction has been unchecked (red arrow on the empty checkbox) but the DRAFT MESSAGE below still lists every line — a wall of ~30 raw bank descriptors ("we're missing the receipts for FASTER PAYMENT TO L FERREIRA WAGES on 28 Aug, …"). Recipient mobile prefilled `+447700900001` (the fictional test number). No way to edit the draft.

**Brief:**
Three defects on `LiveChaseComposerCard` (`apps/web/src/components/DynamicComponents/LiveChaseComposerCard.tsx`):
1. **Bug — draft not reactive to selection:** unticking an item doesn't recompose the draft; the message keeps naming transactions the accountant excluded. The client-side draft must derive from the *current* checked set.
2. **Copy quality:** the draft is an unreadable recitation of raw bank descriptors. He wants a personal-touch message (matches item 16's later-AI-personalisation note — for now, a humane preset that summarises: "a few receipts from August, including X and Y" rather than thirty descriptors; note §8.2 was already amended once for "no amounts in chase copy").
3. **Editability:** no way to change a word/sentence/the whole message anywhere before it sends. ⚠ This collides with the contract's rule that chase copy is composed **server-side** and "never free-typed by a caller" — the deliberate injection/consistency defence. Options: an editable-with-guardrails seam (accountant edits travel as a reviewed field on the proposal, shown verbatim at Read review, still released by the super admin), or per-practice templates. Either way it's a contract/engine change — **G7, Shakib's call** — not a textarea slapped on the card. Also: the prefilled fictional mobile should be gone per M8; check why this build still shows it.

## Item 32 — Match suggestion calls a name-only hit "Probable" when amount and date are wildly different

**Original (verbatim):**
> the is so stupid in the portal that the matching is not understanding that the date and amount id so different, but only the name is same then how this could be the same doc for the transactoin?

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the "Needs you" candidate dialog: transaction **FASTER PAYMENT TO ALDGATE MEATS LTD · 26 Aug 2025 · £674.46**, candidate **Aldgate Meats Ltd · £994.00 · 30 Jul 2025** tagged "Probable 48%", note "Merchant name normalises to the same supplier, but the amounts differ."

**Brief:**
Two problems in one dialog:
1. **Scoring:** the suggestion engine (`apps/web/src/lib/matching.ts` — explicitly display-tier, float-pounds, "flagged for a post-demo rewrite in pence") treats supplier-name equality as enough for "Probable" even when the amount is £320 off and the date a month apart. Amount/date disagreement should crush the score; a name-only coincidence for a repeat supplier (a butcher a restaurant pays weekly!) is the *expected* case, not a probable match. The rewrite this module already owes is now user-visible.
2. **Already-claimed document offered again:** this same £994.00 / 30 Jul 2025 Aldgate document is already matched and published against the 06 Aug £994.00 transaction (item 30's image shows it). The `claimed` set in `lib/matching.ts` exists precisely so one receipt cannot answer two bank lines — either it isn't consulted on this dialog's candidate list, or live rows' missing `matchedDocId` (the known contract gap: only CONFIRMED rows carry `matchedDocumentId`) leaves the claimed set empty in live mode. Same data-plumbing family as items 25/30.

## Item 33 — "Chase for it" button in the candidate dialog does nothing

**Original (verbatim):**
> This chase button is not working

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the same candidate dialog (11 Aug 2025 · £556.20 · same Aldgate candidate), red arrow on the **"Chase for it"** button; clicking it has no effect.

**Brief:**
The per-transaction candidate dialog (BankView's "Needs you" verdict modal) offers "Chase for it" alongside "Cash code instead" / "This is the one", and the chase button is inert in the live build. Per the S14 sweep the synthetic chase composer paths are gated off live — so this button most likely either lost its handler in the gating, or points at a local writer that live mode suppresses without the disabled-with-tooltip treatment the sweep gave everything else. Expected behaviour live: stage the real engine chase for this one transaction (the same `chase.send` seam item 15 wired for the Bank-tab bulk selection). Find the handler in `BankView.tsx`'s verdict dialog and either wire it to `requestChase`/proposal staging or disable it honestly with the reason until it can act.

## Item 34 — Ready document shows no sign of the bank transaction it matched

**Original (verbatim):**
> One document is ready but not showing the corespondent bank transaction it matched

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — DocumentPreview for **Barchester Bakehouse Ltd · Zeplow Inc. · 15 Sep 2026 · £288.40**, state Ready, log `…coding updated → state READY`, `match` step absent from the log; no "Matched bank transaction" / "Suggested bank match" section rendered. (The statement holds a plausible counterpart: FASTER PAYMENT TO BARCHESTER BAKEHOUSE · 07 Aug 2025 · £278.57 — amounts differ by £9.83 and the doc is dated 15 Sep **2026**.)

**Brief:**
The bank-match panel exists (Phase 4: `api/bank-match.ts` → `GET /documents/{id}/bank-match`, rendered in `DocumentPreview` with a Confirm-match button) — so the question is why nothing rendered here. Two candidate explanations to separate in diagnosis:
1. **Nothing to show, honestly:** the amounts (£288.40 vs £278.57) and dates (Sep 2026 vs Aug 2025) genuinely don't line up, so the matcher may have no suggestion — in which case the *product* gap is that the panel is silent instead of saying "no bank match found yet", leaving the accountant unable to tell "unmatched" from "panel broken". An explicit empty state on the bank-match section is the fix.
2. **A match exists and isn't shown:** if the server did suggest/confirm a transaction for this document, the section failed to render live — check the endpoint's answer for this doc id and whether the section fails-closed on a shape it can't parse.
Either way, Mubashir's expectation is right: a Ready document should always answer "which bank line does this belong to — or none yet, and why". Fold the diagnosis into the items 25/30/32 matching-lane investigation, since all four are one story: **the live matching data visible on documents, chat, and chase surfaces disagrees with the Bank screen.**

## Item 35 — Bank → Matched shows nothing despite confirmed matches; matched rows need document preview + transaction details

**Original (verbatim):**
> Here in the bank->matched tab all the document matched with the transaction must be shown with document preview option with the transaction details as like the all tab under the bank tab, not showing

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — Zeplow Inc. → Bank: header "0 UNEXPLAINED · £0.00 WITHOUT EVIDENCE", Matches sub-tab count **0**, Transactions with the **Matched** filter selected showing *"No transactions — upload a bank statement to bring them in"* — while at least one confirmed+published match exists (the Aldgate £994) and "Needs you (7)" is non-zero.

**Brief:**
Two layers again:
1. **Bug — the Matched lens is empty when matches exist.** The lens keys on `isMatched` (`matchState === 'CONFIRMED'` on live rows), so either the confirm-match ritual never wrote `CONFIRMED` server-side, or the slice's mapping/refetch loses it. Same root as items 25/30/32/34 — one investigation. (Also note the header claims "0 unexplained" while "Needs you (7)" — if 7 need attention and 0 are unexplained *and* Matched is empty, at least one of the three numbers is lying; capture all three predicates' inputs when diagnosing.) The **Matches** sub-tab live is deliberately a pointer per the S14 sweep — that decision may need revisiting now that matches are real live.
2. **Feature — richer matched rows:** each matched transaction should show its document (preview affordance, the `DocumentViewer`/`DocumentPreview` seam exists) beside the transaction details, same layout richness as the All tab. Today `matchedDocumentId` only crosses the contract for CONFIRMED rows, so the join is possible live — render the document name, open-preview button, and the match provenance (AI vs hand).

## Item 36 — A document with mostly-empty, 20%-confidence fields reached Ready after only a category was set

**Original (verbatim):**
> Another document with most of the fields with no data is showing and moved to the ready tab after only providing the category; wtf is this

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — a handwritten BC Window Cleaning receipt (£35, "Paid with thanks"): Supplier 90%, Total 99%, Document date 99% — but Customer/Invoice number/Tax/Currency/VAT/Type all at **20% confidence**, three of them showing "—" (no value), Type guessed RECEIPT at 20%, and **Category "Hotel" at 100%** (a manual correction — for window cleaning). Processing log: `code escalated → TO_REVIEW → coding updated → state READY`.

**Brief:**
Readiness (`resolveProcessedState` / `BASE_MANDATORY`) requires exactly Total + Supplier + Category — so filling Category alone flipped this document to Ready, with six fields at 20% confidence or absent, and a category that is plainly wrong for the goods. Mubashir's objection is the *gate*, not just this doc:
1. **Product decision needed on what Ready requires.** Options: widen the mandatory set (document date is already strong here; Type matters for the export's row kind); or gate Ready on **confidence** as well as presence — a document whose retained fields sit at 20% goes to Ready only after those fields are human-viewed (a "reviewed the low-confidence fields" interaction, not necessarily corrections). Whatever the rule, it's server-side (the readiness edge), and the Path-to-Ready panel must state it.
2. **Interlocks:** item 22's sanity layer should also catch category-vs-content dissonance ("Hotel" for a window-clean line item is exactly what a model second-opinion would flag); item 19's always-suggest work will reduce how often a human types a category unaided. A receipt legitimately has no invoice number/VAT — the answer is not "require everything", it's "require what this document type should have, at a confidence a human has seen".

## Item 37 — Verify the VT import file format: no column headers — will VT actually understand it?

**Original (verbatim):**
> Check if really this is the actual format to import to vt software, cause without any column name how there could be vt will understand where to put, what is it, if it is ok, then ok, just recheck again

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the produced import file (`2025-08-26-purchase-invoices`), one headerless row: `BC Window Cleaning | W9T15E9J · https://neoacc.neovogent.com/d/W9T15E9J · Imported from Neo Accounting | 35.00 | 0.00 | 35.00 | 35.00 | Hotel`.

**Brief:**
A verification task, his own framing ("if it is ok, then ok, just recheck"). The exporter (`apps/api/src/modules/exports-public-api`, VT Transaction+ Universal Input Sheet target) emits positional columns with no header row. To do: **check against VT Transaction+'s actual Universal Input Sheet documentation** — the Universal Input Sheet is a paste-into-workbook mechanism where columns are position-defined by the sheet itself (in which case headerless rows are correct *and* the screen/docs should say "paste into the Universal Input Sheet", teaching the accountant the workflow), vs. a CSV auto-import that expects headers (in which case the emitter is wrong). Also confirm column order matches VT's expected layout (supplier, narrative/reference, gross/VAT/net order, analysis account) and that the D43 source link riding in the narrative column survives VT's cell limits. Deliverable: a documented verdict with a citation to VT's format spec, plus — either way — a line of on-screen help on ExportView telling the accountant exactly how to use the file in VT ("open VT → Universal Input Sheet → paste"), because the question itself proves the product doesn't currently teach the import step.

## Item 38 — Invite dialog: clicking a client pill mid-form sends the invitation immediately

**Original (verbatim):**
> If I type the email first and click the client the email, the model gets disappeared and the mail get sent auto, after typing email then selecting role, then selecting client then clicking the invitation sent button, the invitation will sent to the email only then

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the "Invite a colleague" dialog (Team screen): work email filled, Role pills (Standard user / Client admin), client pills (Zeplow Inc.), Cancel / **Send invitation**.

**Brief:**
Order-dependent misfire: type the email, then click a client pill → the dialog closes and the invitation **sends by itself**. Only the full sequence email → role → client → explicit "Send invitation" should send. This is almost certainly the classic implicit-form-submit: the role/client pills are `<button>`s inside a `<form>` without `type="button"`, so clicking one submits the form (the first submit-capable button wins). Fix in the Team invite dialog (`TeamView`'s invite form over `api/team.ts`): `type="button"` on every non-submit button (and audit **every** form-hosted dialog in the app for the same — the intake form's pill steps, chase composer checkboxes-as-buttons, onboarding steps), plus, belt-and-braces, the send handler should refuse when role/client haven't been explicitly confirmed. An invitation email is an outward-facing side effect — firing it on a mis-click is exactly what the explicit button exists to prevent.

## Item 39 — Role capability matrix: standard users see actions they're forbidden to finish

**Original (verbatim):**
> There should be standard guard for what will be shown to the standard team member and what will not be; the standard user is being able to see the add client option after filling all the information it is telling you can't add; define all the rules for each type of user and what they can do and see; and according to that fix the code

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the Add-client intake, step 3 of 3 (Review), fully filled in by a standard user, refusing at the very end: **"NT-PRM-001 — Only a member of an accounting practice can add a client."** with the Create button still rendered below.

**Brief:**
Two distinct wrongs:
1. **The refusal arrives after the work.** A standard user walks all three intake steps and is refused at Create. The repo's own posture (Governance §11.2, the D44 "degrade honestly, never hide" pattern) permits showing the action — but honestly means the *first* screen says "adding clients needs {role}; you can compose but not create" (or the entry button is disabled-with-reason), never a 3-step form that dead-ends. Also suspicious: NT-PRM-001's message here ("only a member of an accounting practice") suggests the refusal may actually be the **wrong check** for this user (they *are* a practice member — was the session's practice scope missing?) — verify the server-side predicate before assuming role-gating; this may be a bug wearing a permissions message.
2. **The matrix doesn't exist as a document.** His ask: define, per role (practice super admin/owner, practice standard, client admin, client standard, portal roles), what each **sees** and what each **can do**, then align every surface to it. Today authority lives in scattered `PermittedAction`s (`approvals/assert-can.ts`, four actions) plus per-surface gating. Deliverable: a capability matrix doc (SoT-adjacent — Shakib should ratify it), then a sweep making every gated surface follow one of two sanctioned shapes: hidden (not this role's job at all) or visible-but-disabled-with-reason *before* any work is invested.

## Item 40 — Audit every modal for the overflow/scroll bug (deep-research task)

**Original (verbatim):**
> do deep research on each modal and check their overflow status, most of them if with overflow bug, there is content at the bottom but i'm not being able to scroll

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the intake Review step (dark theme): the "Create client & email the sign-in link" button is **cut off at the bottom edge** and the dialog will not scroll.

**Brief:**
Generalises item 23 from one dialog to the whole population: the shared `Modal`'s 2 Sep bounded-and-scrolls fix (`max-h-full` wrapper + `overflow-y-auto` children box) demonstrably fails in the real browser on multiple dialogs (publish dialog, intake form; his "most of them"). The pinning test is a **class-contract test in jsdom, which computes no layout** — so the mechanism was never actually verified in a browser. Task shape:
1. **Inventory every modal**: shared-`Modal` children (`RequestStatementDialog`, `PublishBatchDialog`, `CodingProposalModal`, intake, invite, offboard, viewer, purge…) *and* the dialogs that draw their own chrome (`AnalysisModal`, `DuplicateModal`, `ChaseModal`, `WorkflowEditor`, tour overlay, portal dialogs).
2. **Reproduce in a real browser** (headless Chrome/CDP, the repo's established audit pattern) at a short viewport (e.g. 1280×720): for each modal, assert bottom-most interactive element reachable by scroll. The likely mechanical root: a `max-h-full` chain broken by an unbounded ancestor, or flex children missing `min-h-0` — one fix in the Modal frame should cover the family, plus per-own-chrome-dialog fixes.
3. **Keep the smoke**: a browser-level "every dialog's last button is reachable" check, because jsdom can never catch this class of bug and it has now shipped twice.

## Item 41 — Portal People: the access dropdown says "Member", which defines nothing

**Original (verbatim):**
> Here "member" does not define what the job is, write specific word or words to define the access

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — Business portal → Settings → People → Add someone: Job title free-text ("Staff"), then **"What they can do here" dropdown showing "Member"** (red arrow), with the separate "Can send documents"/"Can see totals" checkboxes below.

**Brief:**
In `LivePortalPeople.tsx` the `access` enum renders as bare nouns ("Member", presumably "Owner"/"Admin" siblings) that tell the person adding staff nothing about what the level grants — especially confusing sitting directly above capability checkboxes that *do* describe themselves. Fix is copy, not architecture: label each access level with what it does — e.g. "Member — can use the portal, cannot manage people or the plan", "Admin — can manage people and business details", "Owner — full control, including the subscription" — either in the option labels themselves or as a description line under the select that updates with the choice (the pattern the checkboxes already use: "Leave this off for staff who photograph receipts…"). Keep the role words stable (the enum is the contract's); the description is the fix. All catalogue strings, portal-light, no server change.

## Item 42 — Portal People: members can only be deleted, never edited

**Original (verbatim):**
> Give edit option for the owner of the business or the client so that they can edit access of the member of their organization so that if there was any mistake the owner can edit them

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.10.10.jpeg` — Business portal → Settings → People ("Who can send documents"): two rows (Mubashir Khan · Owner · YOU; Neovogent UK LTD · Member · Staff), each with only a **trash icon** — no edit affordance anywhere. The only recovery from a wrong role/name/title is delete-and-re-add.

**Brief:**
`LivePortalPeople.tsx` (over `api/portalPeople.ts`) supports list, add, remove — no update. Mubashir wants the business owner (or whoever holds `canManagePeople`) to **edit an existing member**: access level, job title, name — so a mistake at add time is correctable in place. Two halves:
1. **Contract/server (likely G7):** check whether the portal people surface has an update operation; if the four contracted operations are list/create/remove(+one other), a `PATCH`/`PUT` member endpoint needs adding — with the same guards the remove path already has (last-owner protection: you cannot demote the last owner, same as you cannot remove them; server refuses regardless of UI).
2. **Web:** an edit affordance per row (pencil beside the trash) opening the same form as "Add someone" pre-filled — role, job title, name; the email is the sign-in identity, so decide whether it's editable (probably not in place: one address is one person — changing it is a new member, and the form should say so). Honest degradation for non-managers, same as the rest of the panel. Pairs naturally with item 41 (the access labels being edited need to describe themselves).

## Item 43 — Capture uploads arrive as "Unknown": give them a generated name carrying channel, member, business and date

**Original (verbatim):**
> This document was uploaded via the capture option, there should be a proper naming if the document tis received via capture option from the user portal capture; also if the capture is submitted by any team member of the client then make sure to include the name here in the Unknown; the name of this file could be: Capture-Mubashir-Zeplow-inc-5-sep-2026; or anything you suggest better

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.15.33.jpeg` — DocumentPreview of a portal-Capture upload (a webcam selfie, i.e. not a document): title **"Unknown"**, Zeplow Inc. · 04 Sep 2026 · £0.00, every field "—" at 0% confidence, Type OTHER, state To Review. (Also mislabelled "VIA SMS-LINK" — item 21's channel bug again.)

**Brief:**
A camera capture from the business portal has no filename of its own, and the document's display name falls back through supplier (unextracted here — the photo isn't a document, correctly classified OTHER and flagged-not-blocked per D46) to "Unknown". Mubashir wants a **generated display name for capture uploads**: channel + who + business + date, e.g. `Capture-Mubashir-Zeplow-Inc-5-Sep-2026` (his suggestion; a cleaner variant: `Capture — Mubashir · Zeplow Inc · 5 Sep 2026`, or with a page/sequence suffix for multi-page trays).

Building blocks already exist:
1. **Naming seam:** item 11 gave uploads a display-filename mechanism (`PortalUploadRequest.note` → display filename server-side). The capture path (`portalCamera.ts` → `frameToPage` → `sendPortalUpload`) can compose the default name at upload time — client-side into the same field, or better server-side from facts the server already holds (channel, session member, business, date — composed data, not client-trusted words).
2. **Member identity:** the signed-in portal session knows which member is acting (the People roster, item 41/42's surface) — that name should ride the provenance event and the generated filename. Verify what the session actually carries per member today; if the upload claims only carry the business, adding the member is a small contract/claims widening (G7 check).
3. **Fallback display:** even beyond capture, "Unknown" as a title is a poor fallback — prefer the generated channel-based name for any document whose supplier isn't extracted yet, so the inbox never shows rows the accountant can't tell apart.
Also fold the member name into the workspace-side provenance line ("uploaded-by-delegated-session" → "captured by Mubashir (Zeplow Inc)") — same fact, rendered where the accountant reads it.

## Item 44 — A client's team member shouldn't see the subscription/Plan section at all

**Original (verbatim):**
> The team member of a client don't need to see the plan subscribed

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.16.38.jpeg` — Business portal → Settings → **Plan**, rendered for a team member: status Active, price £8.50 + VAT per month, and a working **"Manage billing in Stripe"** button.

**Brief:**
The Plan section (`LivePortalSettings` → the plan panel over `PortalSummary.subscription` + `POST /billing/portal-sessions`) renders for every portal member. D48 makes the **client** the payer — in practice the business owner — and a staff member who photographs receipts has no business seeing the price or, worse, holding a live button that mints a Stripe billing-portal session (card, invoices, **cancellation**). Two layers:
1. **Server (the real guard):** `POST /billing/portal-sessions` must refuse a non-owner portal session — check whether it currently keys on anything beyond "valid portal session for this business". If it doesn't, that's the security half, not a cosmetic one.
2. **Web:** for the Plan section, this is the "hidden, not disabled" branch of the item-39 matrix — billing is not a member's job at all, so the Settings section list should omit Plan for non-owners (the `canManagePeople`-style fact, e.g. an owner/`access`-based gate; note `PORTAL_SECTIONS` is a total mapped type and section slugs are addresses — an unauthorised deep link to `/portal/settings/plan` must fall to the first visible section, which the existing unknown-section rule already handles once Plan is excluded from the member's list).
Feeds the item-39 capability matrix: portal Owner sees Business/Plan/People/…; Member sees Business (read-only?), Sending, Notifications, Security. Decide alongside items 41/42 so the People/Plan/access story lands as one ruleset.

## Item 45 — "Manage billing in Stripe" fails: diagnose the portal-session error

**Original (verbatim):**
> Check what is the error here

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.17.26.jpeg` — Business portal → Settings → Plan (dark theme): subscription Active, £8.50 + VAT, and under the "Manage billing in Stripe" button the red line **"We could not open Stripe. Try again in a moment — if it keeps failing, tell your accountant."**

**Brief (diagnosis, ranked):**
The red line is `LivePortalSettings.tsx`'s generic `fault` message (`portal.livePortalSettings.fault`) — it catches **any** failure of `openBillingPortal` → `POST /v1/billing/portal-sessions` and reports none of the actual error, so the cause is server/Stripe-side and needs the staging API logs (or a curl repro) to confirm. Ranked hypotheses, given what the billing module records about staging:

1. **Most likely: Stripe live mode has no saved customer-portal configuration.** `billingPortal.sessions.create` refuses in a mode whose default portal configuration was never saved in the Dashboard (Settings → Billing → Customer portal → Save). Staging was hand-switched to **live mode** from the dashboard side (the `rk_live_…` discovery, 2 Sep) — test-mode configuration does not carry over, and checkout working while the portal fails is exactly this failure's signature.
2. **The restricted key lacks the permission.** `rk_live_` is a *restricted* key; creating billing-portal sessions needs its own resource permission. If the key was minted with Checkout/Customers write but not Customer portal, this call alone is refused.
3. The `return-url.ts` origin-equality guard refusing the portal's `returnUrl` (if the staging portal is served from an origin the guard doesn't recognise).
4. The tenancy 404 (body naming a different business) — unlikely here, it's the session's own business.

**Verification path:** hit the endpoint once with the portal bearer and read the response code + `NT-` problem, and/or read the staging api task logs for the Stripe SDK error string; fixes 1–2 are Stripe-Dashboard-side (save the live-mode portal config; re-scope or re-mint the restricted key), not code. **Web follow-up regardless of cause:** the fault line violates the app's own error rule (frontend ten, item 5 — plain English **plus the `NT-` code**); route it through `errorLabel` so the next person can tell these four causes apart from a screenshot.

## Item 46 — Document-date correction needs the UK date picker (and better UX)

**Original (verbatim):**
> Here the date picker must be as described earlier and with better ux

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.19.09.jpeg` — DocumentPreview of the capture upload (the "gf" document, item 43's selfie): red arrow on the **Document date** field, corrected to **09 Aug 2027** at "100% confident".

**Brief:**
The Document date correction in `DocumentPreview` needs the same date-control treatment as items 16 and 28: a proper UK d/m/y selector with readable long-form display ("9 August 2027" style), never a locale-dependent native input or a bare text field. This makes **three surfaces** now asking for one date control — the statement-request dialog (16), ExportView's FROM/TO (28), and the document-date correction here — so the right move is a single shared UK date-picker component in `DynamicComponents/`, built once, adopted by all three (and any future date field), with the repo's Europe/London + d/m/y invariant baked in rather than re-decided per surface.

**Adjacent flag from the same screenshot (files under item 22's sanity-check umbrella):** the corrected date is **in the future** — 09 Aug 2027, a year ahead of today — and it was accepted silently and now reads "100% confident". A future document date is almost always a typo (or a d/m/y↔m/d/y slip) and materially wrong for accounting (it lands the document in a period that doesn't exist yet, which item 29 shows will strand it at export). The correction boundary should warn on a future date (and on implausibly old ones), with the item-22 "Ignore — I'm sure" escape. Also the same screenshot shows Supplier "gf" at 100% — the human-confirmed-equals-100% display reading as endorsement of junk, already noted in item 22's brief.

## Item 47 — A selfie was driven to Ready with fabricated fields; the pipeline never objected

**Original (verbatim):**
> I just put the category here of my selfie and the document is ready for publishing, the ai must be intellectual enough to understand what is what

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.20.43.jpeg` — the capture selfie (items 43/46) now **Ready**: Supplier "gf" 100%, Document date 09 Aug 2027 100%, Invoice number 876543, Total **£76,543.00** 100%, **Category "jhngbhf" 100%** — all human-typed junk — while Type still honestly reads **OTHER at 0%** and the image is visibly a person, not a document.

**Brief:**
The stress-test conclusion of the 36/22/46 thread: a document the extractor itself classified **OTHER** (a non-financial image, correctly flagged per D46) was walked to Ready by typing nonsense into the three `BASE_MANDATORY` fields, and nothing at any layer objected. Distinct failures, each with its own fix:

1. **Category accepted a free string.** "jhngbhf" is on no chart of accounts, yet the correction path (`parseCodingDraft` → `document.update-coding`) accepted it. The AI-side rule — *refuse any category not on the client's synced chart, never fuzzy-match* — exists precisely so codes stay real; the **manual correction boundary must validate against the same chart** (server-side, at the proposal). This is a bug by the product's own standards, not a new feature.
2. **Type plays no part in readiness.** A document whose Type is OTHER (or 0%-confidence) should not satisfy Ready with invoice/receipt-shaped fields: either Ready requires a confirmed financial Type, or an OTHER document's path-to-Ready starts with "confirm what this document is". Feeds the item-36 readiness-rule decision.
3. **The D46 flag isn't loud enough to matter.** Flag-never-block is right at *upload*; but the flag should follow the document — visible on the row, restated at publish review ("this document was judged not to be a financial document"), so a super admin approving the release sees it. Today the flag evidently doesn't reach the surfaces where it would change a decision.
4. **The AI second opinion (item 22) is the general answer** to "the ai must be intellectual enough": a correction pass that reads the typed values against the document's own content would trip on every field here (supplier not present in image, total not present, image contains no text at all).

Worth stating the design boundary honestly in whatever ships: the product cannot stop a determined human from asserting false facts through Review → Approve — that's D44's human authority working. What it must do is make the assertion *informed* (warnings, flags at review) and *validated where hard rules exist* (chart-of-accounts membership, arithmetic, type-vs-readiness). Items 22, 36, 46, 47 should be designed as one correction-integrity package.

## Item 48 — Supplier memory: a regular supplier's category should be remembered and re-suggested (Dext parity)

**Original (verbatim):**
> Ai must remember the supplier and set a category for it, if the supplier is regular then it will suggest the same category. this is a important feature Dext has

**Image:** none provided.

**Brief:**
Supplier→category memory: once a supplier's documents have been coded (by rule, AI-accepted suggestion, or human correction), the next document from the same supplier should arrive with that category **suggested automatically**, no manual rule required — the Dext "supplier memory" behaviour he's benchmarking against.

What already exists in the repo, and where the gap is:
1. **Explicit rules** (`rule.create`, the Bidfood beat): supplier→category, but *manually staged* — the accountant has to ask for one in chat and approve it. That's a rule engine, not memory.
2. **Prior-treatment tier:** the coding ladder's own escalation copy says *"This client has not bought from this supplier before, so there is no prior treatment to be consistent with"* (item 19's screenshot) — implying a consistency-with-history tier exists in `rules-suggestions`. **Verify what it actually consults**: if it only reads explicit `rules` rows (not past coded documents), then history-based memory is the missing tier; if it does read history, find why it doesn't fire for repeat suppliers.
3. **The shape of the fix** (server-side, in the coding ladder): a tier between exact-rule and model-reasoning — "this client's last N documents from this normalised supplier were coded X (M times, most recently {date})" → SUGGEST X with confidence scaled by consistency (5-for-5 = high; 3 different codes = low or escalate). Human corrections must feed it (a correction is the strongest signal of intended treatment). Suggestion only — the accepted flow stays the ordinary correction → Review → Approve path, same as item 19's tier, and it must respect the chart-membership rule (a remembered code that has since left the chart is not offered).
4. **Optional follow-on:** after the same treatment repeats N times, *offer* to formalise it as a rule ("You've coded Aldgate Meats to Food 5 times — make it a rule?") — staging the existing `rule.create`, so the two mechanisms converge instead of competing.
Sits directly on item 19's always-suggest work; specify the ladder's tier order once, covering both.

## Item 49 — Duplicate dialog is informational-only; build the real resolution per the prototype UI (D49)

**Original (verbatim):**
> What is this? Fix it according to the actual ui in this repo: https://github.com/MubasshirrKan/ai-accounting-operations-platform

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.23.29.jpeg` — the "Suspected duplicate" comparison dialog (Zeplow Inc., 77% similar): signal chips (identical total, same supplier, same date, OCR 67% similar; file hash differs, different uploaders), the two copies side by side (both BC Window Cleaning £35.00 · 26 Aug 2025), "View this document" on each, and the footer: **"Resolving a duplicate is coming to Review → Approve — in this build the flag and the comparison are informational."**

**Brief:**
His "what is this?" is aimed at that footer: the dialog detects and explains a duplicate and then offers **no way to resolve it** — no keep-this / keep-that / not-a-duplicate actions. This is a known, deliberately-shipped gap (the S14 sweep left "both duplicate-resolution footers [as] an informational note — the executor ships post-demo"), and he's now calling it due, with D49 as the instruction: **the prototype repo (`MubasshirrKan/ai-accounting-operations-platform`) is ID's design source of record — match its duplicate-resolution UI.**

**The prototype UI, verified from its source** (`src/components/DynamicComponents/DuplicateModal.tsx` in the prototype repo — read, not guessed): same header, signal chips and two-card comparison this build already has, **plus a footer of four resolution actions**, each behind a ConfirmStep stating its consequence:
1. **Different documents** — "The flag was wrong — these are two different documents. The flag is dismissed and both stay in the pipeline."
2. **Keep both** — "Two identical documents that both genuinely exist. Both stay and both will be published — an intentional duplicate."
3. **Attach to the original** — "One document, two images of it. They become one document with two images. The flag is cleared."
4. **Delete the copy** (red, the primary) — "The copy and its original are removed. A deleted document cannot be matched to a bank line later." The prototype's own comment calls this "the usual case, and recoverable."

Also in the prototype and missing here: **"View this document" expands an inline `DocumentPreview` inside the modal** ("This copy — the original, immutable", with a Hide control) rather than doing nothing/navigating away; and "Sent by" renders `pair.uploader` — a **person**, which is why this build showing a *filename* ("king fisser.jpg") reads wrong (item 43's member-identity work supplies the real value).

Work shape:
1. **Web:** port the four-action footer + confirm flows + inline expand from the prototype (the comparison layout is already ported; the actions were dropped).
2. **Server half:** resolution changes document state, so it's Review → Approve (the footer already promises exactly that). The prototype's `resolveDuplicate(pair.id, 'delete' | 'keep-both')` is display-tier — the real build needs the proposal kind (`document.resolve-duplicate` or equivalent; G7 contract addition + executor if absent). Note the real semantics need **four** outcomes where the prototype's local state collapsed three of them into `keep-both` — "attach to the original" is a genuinely different write (one document, two images) and needs its own server-side answer or an honest deferral.
3. **Delete should be the reversible deletion** (Move to Trash seam, item 13) — matching the prototype's "recoverable" promise — never a purge.
4. **Detail:** the "BC" vs "B C" supplier spellings render unexplained while a "Same supplier" chip sits above them — the dedupe normalised them for matching, and the display could say so.

## Item 50 — Expense claims: hide the unbuilt tab now; design and build the whole feature

**Original (verbatim):**
> If things are not build yet then why showing it to the production user? But for expense claims, set rule and design the whole architecture, in the client panel, give option to select that if the member allowed to submit expense claims, and if allowed by the super admin of the client account then while uploading of capturing any document by the member he can check as expense claim, then the document will arrive here, and in the cost, and research deeply how this could be on the VT software, and how in actual accounting the expense claim is calculated for the companies and how this entry must be captured, and according to our app how all the information is relevant and how this should be done

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.27.47.jpeg` — Zeplow Inc. → **Expense Claims** tab: an honest empty state ("Expense claims are not connected to the API in this build… The channel an employee would submit a claim through has not been built.") — honest, but still a tab a production user can open and get nothing from.

**Brief:**
Two rulings in one item:

**A. Immediate (small):** an unbuilt surface shouldn't be a visible tab for production users. The honest-empty-state posture was right for the demo cast; live, the tab should be absent until the feature exists (this also generalises: audit the client sub-tabs and main nav for other not-wired-live surfaces and apply one rule — absent live, present synthetic).

**B. The feature (large — full architecture, needs a design doc before any PR):** employee expense claims, end to end:
1. **Permission (client portal):** the client account's super admin/owner grants per-member "may submit expense claims" — extends the member access model (items 41/42's People form; it already has the "Can send documents"/"Can see totals" checkbox family — this is a third capability, and needs the member-edit path from item 42 to be correctable).
2. **Submission:** a permitted member uploading or capturing a document can mark it **"expense claim"** at send time (Upload tab and Capture tray both). The mark rides the signed upload claims like item 11's note — data, never instructions — and records who claimed it (item 43's member identity is a prerequisite: a claim without a claimant is meaningless).
3. **Arrival (practice app):** claimed documents land in the Expense Claims tab as claims-by-member (claimant, status: submitted → approved → reimbursed), **and** in Costs once approved — they are real costs of the business, distinct only in who paid.
4. **Research task — the accounting treatment (do before designing the data model, and cite sources):**
   - How UK small-company bookkeeping records an employee/director expense claim: the expense is recognised at receipt date with input VAT reclaimable (given a valid VAT receipt), credited not to the bank but to a liability — the employee/director as a creditor (directors' loan account for directors) — and the later reimbursement payment clears that liability and is what appears on the bank statement (so the bank-matching lane must expect the *reimbursement*, possibly one payment covering many claims, not per-receipt lines).
   - How VT Transaction+ expects such entries: which VT input shape (payments/journals, which creditor account convention) the export file should emit for a claim vs a normal purchase — verify against VT's documentation the way item 37 does; the current exporter emits purchase-invoice rows and a claim is not one.
   - Mileage and subsistence rules (HMRC flat rates) — probably out of ID scope, but the research should say so explicitly rather than the model discovering it later.
5. **Fit to this app's spine:** claim approval is a state change → Review → Approve proposal(s); the claimant needs portal-side visibility of their claim's status; reimbursement matching joins the bank lane. Contract changes throughout — **G7, and big enough that the deliverable is a design document for Shakib's sign-off first**, not a PR.

## Item 51 — Rule-setting via chat: guided flow with confirmation, in-chat client picker, and landing in Approvals → Workflows

**Original (verbatim):**
> This is something was told in the sot that the rule can be set via chatting with the ai; if the user wants to set any rules like discussed in the given screen shot then the ai will ask for the confirmation will add that to the specific client, here in this given screenshot no client is mentioned, then the ai must ask for selecting client from drop down directly designed in real time to show the user and on selecting the rule will be written by ai for the specific task and then the rule will be implemented and will be shown in the client->approvals->workflow

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.32.27.jpeg` — chat, scope chip "All clients": user twice asks to "set ruels for Barchester Bakehouse Ltd" (auto-publish when ready; then auto-approve when ready). The AI refuses both — correctly on the substance ("publishing always requires your approval on the review screen", "every document needs a human to review and approve") — and ends with a dangling *"Would you like to create a coding rule instead?"* with no way to act on it.

**Brief:**
The refusals themselves are right and must stay: auto-publish and auto-approve are exactly what Governance §10/D44 forbid — no rule may release documents without a human. What's missing is the **journey** the SoT promises around rules chat can set:
1. **Continue the conversation with affordances, not dangling questions.** "Would you like to create a coding rule instead?" should arrive with an actionable card (Yes — draft it / No), not require the user to re-type. Today the rule flow only fires when the utterance already parses as a codeable rule (`LIVE_RULE` — the Bidfood beat); a refusal that *offers* the alternative should hand off into the same flow.
2. **Client resolution via an in-chat dropdown.** When the scope is "All clients" and the AI can't resolve the client (or, as here, wants confirmation even though the name was typed), it should present a real-time client picker inside the chat — the component pattern already exists (`ChatClientPicker`, built for uploads held pending a client answer). Never guess a client for a rule; always confirm the resolved one.
3. **Confirmation before staging.** The AI writes the rule (server-side draft, the existing `drafts.ts` discipline — exact supplier casing, chart-membership-validated category), shows it, asks "add this to {client}?", and staging remains the explicit-click `rule.create` proposal → Review → Approve, unchanged.
4. **Visibility after approval:** the implemented rule must appear in **Client → Approvals → Workflows**. Check what that tab currently lists — if approved `rules` rows don't surface there (or anywhere per-client), that's a real gap independent of chat: a rule that can't be seen can't be audited or retired.
5. **Scope note for Shakib:** if "auto-publish once Ready" is ever wanted as a *rule kind*, that is a D42/D44 amendment, not a chat feature — record the ask, don't build it. Chat's rule vocabulary today is coding rules; any wider rule taxonomy (chase policy, VAT treatment, routing) needs contract + engine work and its own decision.

## Item 52 — Workflow "Describe it instead" only understands the preset phrasing; wire real AI parsing

**Original (verbatim):**
> Only the preset prompt is working here in the workflow setup option, fix it and use the ai here so that custom request can be complied by ai

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.34.14.jpeg` — the "New workflow" editor with "Describe it instead": the "FILLED IN FROM YOUR DESCRIPTION" panel showing the one description that parses (thresholds £500/£2,000, Manager → Finance Director stages, "publishes automatically once fully approved", applied to Zeplow Inc.) — any custom phrasing fails to fill the form.

**Brief:**
The "Describe it instead" path in `WorkflowEditor` parses the description with a deterministic local parser that effectively recognises only the demo's scripted sentence — a `DEMO-MOCK`-class leftover. Mubashir wants a real model behind it so any phrasing compiles into the structured workflow (name, applies-to, clients, stages with roles/thresholds/sides, branches).

Three layers, in dependency order:
1. **Check what workflows even are, live.** The Workflows tab and this editor are (per the S14 sweep's inventory) synthetic-side surfaces — verify whether a saved workflow reaches any server table or lives only in browser state. If there's no contract for workflows, that's the real gap: AI-parsing a form whose Save evaporates on reload is polish on a mock. Contract + persistence first (G7), then intelligence. (Cross-ref item 51: the same tab is where chat-set rules should land — one workflows story, not two.)
2. **The AI parse belongs server-side, in the §9 chat-framework discipline:** the free-text description goes to the pinned model wrapped as `<untrusted_content>`, the output is a Zod-validated workflow draft (the structured shape the form edits), refusals named, eval case added. Never a client-side model call, and the draft fills the form for the human to correct — exactly the "every field below is editable" promise the panel already makes.
3. **D42/D44 flag:** the preset parse produces "Publishes automatically once fully approved" — a workflow stage chain that ends in auto-publish collides with super-admin-only release (D44) unless the final stage *is* the super admin's approval. Whatever the parser (preset or AI) emits, the vocabulary must say "released by the super admin", not "publishes automatically" — same copy rule as everywhere else, and a design question for the workflow schema itself.

## Item 53 — Workflow "+ Add branch" only ever adds the same hardcoded branch

**Original (verbatim):**
> Adding brunch keeps adding only the same rule, make sure to fix it

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.35.07.jpeg` — the workflow editor's CONDITIONAL BRANCHES section: clicking **+ Add branch** appends another copy of the identical canned branch, "Amount over £2,000 adds the Finance Director", every time.

**Brief:**
Same `WorkflowEditor` mock family as item 52: "+ Add branch" pushes a fixed demo branch object rather than opening a branch composer, so the only possible branch is the scripted one, duplicated on every click. The fix rides item 52's decision entirely: once workflows have a real schema (branch = condition {field, operator, threshold} → effect {add stage/approver}), "+ Add branch" becomes a small form (or an AI-drafted line under item 52's describe path) creating a *distinct*, editable branch — and duplicate identical branches should be refused or collapsed. Not worth touching in isolation: fixing the button while branches remain browser-state mock (item 52 layer 1) changes nothing real. Fold into the one workflows work-package (51 + 52 + 53).

## Item 54 — Tasks: no server behind teams/tasks — plan and build the feature completely

**Original (verbatim):**
> Task assign option is not build yet, make sure to plan this out and setup the feature completely

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.36.15.jpeg` — Team → Tasks: the amber banner "Teams and tasks are demo data. They have no server behind them yet, so nothing here is saved", the "+ New task" button disabled with the honest tooltip ("There is no operation behind this yet, so anything typed here would be lost on the next reload"), and an empty task table (Task / Client / Assigned to / Due / Status).

**Brief:**
The Tasks tab is a known, honestly-labelled mock (the S14 sweep disabled its writers with reasons — this screenshot is that posture working). Mubashir is now commissioning the real feature: practice-side task management — create a task, scope it to a client, **assign it to a colleague**, due date, status lifecycle, plus the "recurring per-client checklists" the footer already promises.

Work shape (feature-sized, plan before PR):
1. **Contract + schema (G7):** a `tasks` model (title, client scope, assignee = practice member, due date, status, recurrence) and CRUD operations. Decide the write path: task create/assign is plausibly ingest-class (`x-nt-side-effect: ingest`, like intake — a task is coordination, not a client-state change), which keeps it off the Review → Approve spine; that's a Governance call to confirm with Shakib rather than assume.
2. **Assignment realities:** assignees come from the live practice-members read (`api/team.ts`, already real); notification on assignment wants the email seam (and ties into item 12's blocked notifications question — a task bell and a document bell are the same missing read surface).
3. **Web:** the table, filters and per-client scoping already exist as the synthetic board — wiring is the ClientsView/M7 pattern (widen the real endpoint, one board, live rows through the same components; the synthetic cast stays for demo mode).
4. **Recurring checklists** (the footer's own promise, and the sub-tab's stated job — "recurring per-client checklists scoped to this product's job"): monthly/quarterly per-client recurrence generating task instances — needs a worker tick; decide whether recurrence ships in v1 of this feature or the doc explicitly defers it.
5. **Cross-refs:** the Teams sub-tab is the same mock family (its writers were disabled in the same sweep) — the plan should say whether Teams ships with Tasks or stays out; and "Ask AI about workload" stays real either way. Deliverable: a short design doc for Shakib (scope, contract delta, side-effect class), then build.

## Item 55 — Export history missing two previous exports

**Original (verbatim):**
> There's option for export history but it didn't capture two of my previous export and not showing here

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at (04.3x).jpeg` (Image #41) — ExportView: client selector still on **"Choose a client"**, Export button disabled, and Export history reading *"Nothing has been exported for this client yet. Pick a period above and export it."*

**Brief:**
Three candidate explanations, and the screenshot itself points at the first:
1. **No client is selected.** The history is client-scoped, and with the selector on "Choose a client" the panel still says "Nothing has been exported **for this client** yet" — a misleading empty state for a null selection. If selecting Zeplow shows his exports, the bug is *copy/UX*: with no client chosen the history should say "Choose a client to see its export history", not imply an empty record. (Check whether the history query even runs with no client — it may be answering honestly for `undefined`.)
2. **The "two previous exports" may be the two *failed* attempts** (items 28/29 — both refused with NT-EXP-001, nothing was exported). History records completed exports; a refused attempt produces no artefact. If that's what he's missing, the product question is whether failed attempts should be listed — arguably useful ("you tried 01–05/09, nothing matched"), but "history = what was actually exported so a month isn't imported twice" (the panel's own stated purpose) argues for successes only, plus clearer refusal messaging at the time.
3. **A real recording bug:** his one *successful* export (item 37's file) must appear under Zeplow's history — if it doesn't after selecting the client, the create isn't writing the history row and that's a genuine server bug to chase.
**Diagnosis order:** select Zeplow → does the successful export show? Then fix the null-client empty-state copy regardless, and decide the failed-attempts question. (Note the FROM/TO here also render US-format `08/01/2026` — item 28's date-control work covers this screen.)

## Item 56 — Analytics export is a raw metric dump; design a real client-wise report (and research what competitors ship)

**Original (verbatim):**
> Export option from the analysis part is super dumb, design the full thing, client wise port, progress, time saved, duplicate documents etc. and include more from next accounting software, what they are providing, include all

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.41.13.jpeg` — the file the Analytics screen exports (`pipeline-analytics`): a three-column Scope/Metric/Value dump, every row scope "practice" — internal metric keys (`autoPublishedPct`, `itemDelay`, `approvalAge`…) with bare numbers, no client dimension, no period, no explanation.

**Brief:**
The Analytics export serialises the screen's internal KPI object and nothing more. Mubashir wants a designed report:
1. **Client-wise breakdown** — one row/section per client: documents processed, published, to-review, chases sent/answered, duplicates caught, correction rate, unmatched lines, subscription state — the practice roll-up as a summary, not the whole file.
2. **Progress over time** — period-scoped (this month vs last), so the report answers "is this client getting healthier".
3. **Time saved** — an estimate (documents auto-processed × a stated per-document manual-handling constant; the assumption printed in the report, never silent) — the headline number an accountant shows their own boss.
4. **Duplicates** — caught duplicates per client (money not double-entered is the product's own best story).
5. **Competitor research task:** survey what Dext/AutoEntry/Hubdoc-class products ship as practice analytics (Dext's practice insights: client health scores, submission methods, processing turnaround, missing-paperwork rates…) and fold the relevant set in — his "include all" is a research-then-design instruction, same shape as items 37/50: document what they provide, decide what applies, cite it.
Two defects visible in the dump worth fixing regardless: **`autoPublishedPct` is D42-forbidden vocabulary** (nothing auto-publishes in ID — whatever it measures needs renaming to what it actually counts, in the metric key's rendered label if not the key); and **`unmatched: 1489`** against the Bank screen's "0 unexplained" for the same practice is the items-25/30/35 predicate disagreement surfacing in yet another place — the report must use `isUnexplained`/the server counts, one definition, like everything else. Deliverable: report spec first (columns, period handling, file format — XLSX with a sheet per section beats CSV here), then build.

## Item 57 — Practice Team: full member management (edit, remove, access control) for the accountant

**Original (verbatim):**
> Give full member control here for the accountant, deleting, editing, removing and all member access control form here design the full setup and implement

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.42.14.jpeg` — Team → Colleagues (live): two members (Neo Vogent · Practice admin · Owner · All clients; Mubashir Khan · Standard user · 1 client), one outstanding invitation ("Link works until 11 Sep · Invited — awaiting setup") — and **no affordance on any row**: no edit, no remove, no access change, no invitation revoke/re-send.

**Brief:**
The live Team surface is deliberately read-only-plus-invite today (`api/team.ts` wraps exactly `GET`/`POST /practice-members`; the synthetic editors were hidden live by the S14 sweep because their writes had no server). Mubashir is commissioning the write half — the practice-side twin of item 42:
1. **Contract (G7):** update member (role, client access list), remove member, revoke invitation, re-send invitation. None exist today.
2. **Guards, server-side:** the owner cannot be removed or demoted (D44 — release authority must always exist; same last-owner rule the portal People panel already enforces); a member cannot remove themselves blind; role changes bounded by the existing rule that practice-admin cannot be granted by invite ("no way to hand that over yet" — whether *editing* to practice admin is allowed is part of the same open question, Shakib's call). ⚠ This is auth/permission logic — root CLAUDE.md stop-and-ask territory; design sign-off before a PR opens.
3. **Client-access control:** per-member client scoping exists at invite time ("which clients they can reach"); editing it post-hoc is the operationally important half (staff join/leave client engagements constantly). Empty list = all clients, per the invite form's stated rule — keep the semantics identical in edit.
4. **Invitations:** revoke (kills the link before expiry) and re-send (fresh link, supersedes the old — the setup-link re-send seam is precedent). An expired invitation should offer re-send from its own row.
5. **Web:** per-row actions (edit opens the invite-shaped form pre-filled; remove behind a ConfirmStep naming the blast radius), honest degradation for non-admin viewers (item 39's matrix).
Direct sibling of item 42 (portal member edit) — one member-management design covering both sides, plus item 38's form-submit fix in the same dialogs.

## Item 58 — Chat uploads ingest immediately; the AI should ask what to do with the document first

**Original (verbatim):**
> If any document is uploaded in the chat the ai directly forwards it to the inbox tab intead it should ask what to do with it, and the exiting one with suggestion that should it move it to the inbox for review or current thing

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.44.59.jpeg` — chat: a PDF attached (`A2_biffa-waste-services-ltd_invoice.pdf`), and the assistant answering immediately: *"Uploaded 1 document for Zeplow Inc.. Extraction is running — they land in Inboxes under To Review."* — no question asked, the ingest already fired.

**Brief:**
`ChatUpload` currently runs the full ingest journey the moment a file lands (channel `CHAT_UPLOAD`; it only pauses to ask when the *client* is ambiguous). Mubashir wants an **intent step first**: the AI acknowledges the file and asks what to do with it, offering the current behaviour as the suggested default — an actionable card like: **"Send to the inbox for review"** (suggested — today's behaviour), plus whatever else chat can honestly do with a document (e.g. "tell me what this is" once a read-before-ingest path exists). Design notes:
1. **Hold, then act:** the pattern exists — the client-ambiguous flow already HOLDS files and continues on an explicit answer (`ChatClientPicker`). This extends the same hold to every chat upload, with the question card in place of auto-fire. One-click default keeps the common case at one extra click.
2. **Don't lose the file on silence:** a held file whose question is never answered should stay attached to the conversation (and say so), not evaporate.
3. **Option scope needs honesty:** "discuss it here without ingesting" implies a read path for un-ingested bytes, which doesn't exist — the honest v1 option set is probably "Send to {client}'s inbox" / "Send to a different client" / "Cancel — don't upload", growing later. Whatever is offered must be real (the S12 rule: no buttons whose action can't happen).
4. Possible refinement to keep the power users fast: a setting or "always do this" tick on the card — his phrasing ("the existing one with suggestion") suggests he wants the ask every time, so default to asking.

## Item 59 — Chat history vanishes on reload

**Original (verbatim):**
> Chat history gets vanished after reloading, fix this issue

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.46.08.jpeg` — the AI Workspace left panel after a reload: RECENT HISTORY reads **"No conversations yet."** despite the session's earlier conversations (items 25/51/58 all happened in this workspace today).

**Brief:**
Conversations live only in `AppContext` React state: live mode sends each turn to `POST /v1/chat/turns` and renders the reply, but nothing persists the conversation client-side, and the contract has **no conversations read surface** (no `GET /chat/conversations`) to rehydrate from — so every reload starts the workspace empty. With the API on, the seeded conversations are also correctly absent (M2), leaving nothing at all.

Fix layers, in order of correctness:
1. **Server persistence + contracted read (G7, the real fix):** conversations and their turns stored server-side (RLS-scoped like everything else), plus `GET /chat/conversations` (+ turns) for the list and reopen. Check first what the chat-framework already records server-side — §9's runtime may already log turns for audit/eval purposes, in which case the read surface is the missing half rather than the write.
2. **What not to do:** `localStorage` is not the answer — the repo's own bar (one key, `nt.theme`, "worthless to an attacker") explicitly excludes conversation content, which is client financial data on a possibly-shared machine.
3. **Reopen semantics:** a rehydrated conversation must render the same cards (proposal cards re-mount showing their draft; staged proposals live in Approvals — the existing remount rule already handles this), and the seed↔server scope mapping must survive the round trip.
Also worth checking: "Pinned clients" survived the reload in the screenshot (Zeplow listed) — if pins persist somewhere, find where and make sure that mechanism passes the same storage bar.

## Item 60 — Chat upload claims success but the document never appears in the Inbox

**Original (verbatim):**
> one file was uploaded in to the chat and it said it moved it to the inbox, but there is no file in the inbox that was uploaded form the chat ui

**Image:** none provided (the upload is item 58's screenshot — `A2_biffa-waste-services-ltd_invoice.pdf`, answered with "Uploaded 1 document for Zeplow Inc.. Extraction is running — they land in Inboxes under To Review").

**Brief:**
The chat reported a completed upload and the Inbox shows nothing — either the claim is false (the journey failed after the copy rendered) or the document exists under a scope the board doesn't display. Diagnosis order:
1. **Does the document exist server-side?** Check `GET /documents` (or the DB) for the Biffa PDF. This splits the bug in half immediately.
2. **If it exists:** what `businessId` does it carry? The chat upload resolves the business through the seed↔server id bridge (`serverClientIdFor`, with the `biz_<id>` fixture-convention *fallback* when the businesses slice hasn't answered) — a fallback id that doesn't match the real `biz_*` row would land the document where no board's client filter finds it. Same id-bridge family as items 25/30/32/34/35.
3. **If it doesn't exist:** the three-call journey (intent → presigned PUT → complete) failed after the success copy rendered — check whether `ChatUpload`'s message fires on completion or optimistically, and whether a PUT/complete refusal is being swallowed. The chat's own rule elsewhere (the portal's "That did not send" lesson) is that failure after the bytes left must be worded carefully — but success before completion is plainly wrong.
4. Also check the 402 path: a lapsed/absent subscription refuses uploads (`NT-BIL-001`) — if the chat swallowed a 402 into a success sentence, that's the worst version of this bug.
Whichever half it is, the fix includes the copy: "Uploaded 1 document… they land in Inboxes" may only render after the complete call succeeded, and a failure names its code.

**✅ RESOLVED (Mubashir, same session):** the file **arrived later** — it was pipeline latency (extraction + the board's poll), not a lost upload. The id-bridge theory is off the table for this one. What survives from this item:
1. **Copy fix stands:** the chat's success message should set the expectation honestly — where the document lands *and* that it takes a moment ("Extraction is running — it appears in {client}'s inbox within a minute or two"), so a user checking immediately doesn't read absence as loss. An "it's arrived" follow-up notification would be the real fix (item 12's blocked notifications surface, again).
2. **Follow-up correction (his words: "in the inbox tab show the Received via column too"):** the client Costs tab shows **Received via**; the **Inboxes screen's** tables don't. Add the same channel column there (`InboxesView` — the data is already on every document row; it's a column definition, plus the honest labels from item 21). Small, standalone, do it with item 21's channel-label sweep so the column arrives showing true words rather than `sms-link` slugs.

## Item 61 — There's a Trash button but no visible Trash for the client; define how the trash holds files

**Original (verbatim):**
> If there's a trash button then there should be a trash tab in the settings to see the trash, and how will the trash hold the file? Clear that out

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.48.18.jpeg` — Zeplow → Costs → To Review: a row selected, **Move to Trash** in the bulk bar (red arrow) — and no Trash tab anywhere on the client screen to see what was trashed or bring it back.

**Brief:**
Two halves:
1. **Reachability.** A Trash *does* exist — the practice **Documents** screen gained a Trash tab (2 Sep, `api/document-lifecycle.ts`: deletion/restoration/the Trash listing) — but from the client context where the button lives, the trashed document just disappears with no visible destination. Fix: make the trash reachable from where things are trashed — a Trash view scoped to the client (a sub-tab on the client's Documents/Costs area, or his suggestion: under the client's Settings tab), listing that client's deleted documents with **Restore** and (permission-gated) **Delete permanently**, reusing the existing lifecycle endpoints and the `document.purge` proposal. Same-surface rule as item 35: the count/affordance and the list belong together.
2. **"How will the trash hold the file? Clear that out" — the retention policy doesn't exist and must be written.** The 2 Sep work deliberately promised **no recovery window** ("a figure would be a promise the product does not keep" — nothing enforces one). Mubashir is now asking for exactly that promise, so it's a product decision for Shakib: how long a trashed document is held (e.g. 30 days then auto-purge? held forever until purged by hand?), whether auto-purge respects D43 (a document linked from an export file refuses purging — `NT-DOC-002` — so auto-purge must skip those or the policy must say "held forever once exported"), and then the confirmation copy states the real policy. If auto-purge is chosen, it's a worker tick + audit trail; if held-forever, the Trash view needs the storage story said out loud. Either answer is fine; an unstated one isn't.
