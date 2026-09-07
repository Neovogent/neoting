# Mubashir review — running notes

Started 2026-09-05. Items are logged here one by one as they arrive, before any fix work begins.
Previous round: **15 of 15 done** — 13 landed in #253 (`6105dad`), the last two halves (item 9's
chat system, item 12's live arrival bell) in #254 (`d9c6d98`).

Format per item:
- **Original** — what Mubashir said, verbatim (translated if the source was Bengali, with the original kept).
- **Image** — path(s) to the linked screenshot(s).
- **Brief** — what I understood: the actual problem, where it likely lives, and what "fixed" looks like.

---

<!-- Items get appended below as they arrive. -->

## Items 1–15 — backlog, reconstructed from PR #253 (`6105dad`)

Mubashir's original words and screenshots for these were not captured in this file (the round predates it); the descriptions below are reconstructed from the PR body and commit messages. **All 15 are done: 13 landed in #253, and the two halves that were parked as scope questions (item 9's chat system, item 12's live arrival signal) landed in #254 once Shakib supplied the verbatim wording and waived the ceremony.**

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

## Overlap map — where items are one piece of work

Items keep their own entries (original words + images preserved); this map is the combining view. **Items 23 + 40 are physically merged** (one defect at two altitudes); everything else groups into work-packages:

| Package | Items | One-line scope |
|---|---|---|
| **A. Matching-lane truth** | 25 · 30 · 32 · 33 · 34 · 35 | One investigation: the live match data shown on chat, chase, document and Bank surfaces disagrees with itself (empty Matched lens, matched lines offered for chase, claimed docs re-offered, missing bank-match panel, wrong "nothing missing" answer, dead Chase button in the same dialog) |
| **B. Correction integrity** ✅ **RESOLVED (#256, 5 Sep; the model halves 6 Sep in package J)** | 22 · 36 · 46(flag) · 47 → feeds 29 | One design: sanity checks at the correction boundary (arithmetic, future dates, chart-membership for Category), readiness rules (Type/confidence), D46 flag visibility at review — the whole chain item 29's export failure exposed |
| **C. Export chain** | 28 · 29 · 37 · 55 · 56(partial) | Date rendering, refusal UX, VT format verification + on-screen how-to, history panel, analytics-report vocabulary |
| **D. One UK date control** ✅ **RESOLVED (7 Sep 2026)** | 16(period) · 28 · 46 | `DynamicComponents/UkDateField.tsx` — d/m/y typing through the repo's EXISTING `parseUkDate` (split out of the spreadsheet importer, so there is one answer to "what date did a human mean" and it cost zero bytes), long-form restatement, the native picker kept behind a calendar button, and `UkMonthField` for the statement period. Adopted on all three surfaces. ⚠ **28 and 46 are fully closed; 16 is only its period input** — the range/year modes, the channel checkboxes and the preview step need `statementPeriod` to stop being one month, which is contract + engine work. Evidence in `assets/2026-09-07-items-59-18-16/` |
| **E. Channel & provenance** ✅ **RESOLVED (PR #260)** | 21 · 43 · 60(follow-up) · 62(provenance half) | Split chase-portal vs business-portal channels, honest labels everywhere, uploader/member identity on uploads and captures, Received-via column on Inboxes — all four entries below carry their ✅ blocks and evidence (`assets/2026-09-05-channel-provenance/`) |
| **F. Portal & practice access control** ✅ **RESOLVED (6 Sep 2026)** | 39 · 41 · 42 · 44 · 57 (+38's form-submit fix) | `docs/Access_and_Approval_Matrix.md` with Shakib's three rulings recorded inline, self-describing access labels, member edit on both sides (the portal's was one button — its server half already existed), **Plan hidden from members AND the billing endpoints' missing authority check closed**, invite dialog fixed. Evidence in `assets/2026-09-06-access-control/` |
| **G. Approvals spine + matrix** ✅ **RESOLVED (6 Sep 2026)** | 20 · 24 · 26 · 27 · 66 | `docs/Access_and_Approval_Matrix.md` **Part 2** with Shakib's four rulings inline — three tiers over every proposal kind and all 33 ingest operations, five kinds promoted to tier 1 (three of them overturning arguments written in the repo), the super-admin fast path, idempotent staging (`NT-PRP-007`) with a cleanup script, the full Deny-with-reason loop (`DENIED` state, the email, the `READY → TO_REVIEW` drop wearing the reason), role-aware D44 copy from one shared fact, and the coding modal dismissing itself. Governance §10's spine untouched throughout. Evidence in `assets/2026-09-06-approvals/` |
| **H. Workflows & rules** | 51 · 52 · 53 | One package: workflows contract/persistence first, then AI describe-parse, real branch composer, chat rule flow landing in the Workflows tab |
| **I. Modal overflow** | **23 + 40 (merged)** | Fix the Modal frame, audit every dialog in a real browser, keep a reachability smoke |
| **J. Coding intelligence** ✅ **RESOLVED (6 Sep 2026)** | 19 · 48 (+ 22/47's model halves) | The ladder, specified once and built: supplier memory shown at last, a model tier over the three escalations that meant *nothing was known*, and the model second opinion on manual corrections. Evidence in `assets/2026-09-06-coding-intelligence/`; §9.8 gate `pnpm test:eval:coding` |
| **K. Feature builds (design-doc first)** | ~~18~~ · 50 · ~~54~~ | ✅ **18 RESOLVED (7 Sep 2026)** — `PortalDocumentList` on Home and Upload, status filter, paging, preview + download. ⚠ Its server half was NOT "already wired": the portal bearer's grant holds only the current sign-in's uploads, so every row of the client's own list 404'd, and Shakib ruled the read open to the client's whole business. ✅ **54 RESOLVED (7 Sep 2026)** — tasks and teams both have servers: nine operations, no proposal kind (item 66 tier 3), recurrence without a scheduler, assignment notifications on item 12's bell. ⚠ Shakib took Teams IN against the plan's recommendation, and the second-access-model objection was designed out rather than overruled — no `access_level` column, and `tenancy-check.sql` §12 asserts no policy consults `team_members`. Remaining in this cluster: expense claims end-to-end |
| **L. Retention & deletion policy** ✅ **RESOLVED (7 Sep 2026)** | 61 · 67 | `docs/Retention_and_Deletion_Policy.md` with Shakib's five rulings recorded inline — **30 days then auto-purge** (exported documents held indefinitely, D43), one window for documents and removed clients alike, three reversible offboard scopes, **erasure on request with no automatic date**, and `business.reactivate`. Plus the orphan fix (a removed client's documents leave the un-scoped boards; `clientNameFor` never renders a cuid) and one defect found on the way: an archived-then-deleted document was counted by the header and listed by nothing. Evidence in `assets/2026-09-07-retention-deletion/` |

**Since these entries were written, another pass closed items 9 and 12** (see the section above): chat conversations are now **server-persisted** — and the notifications read surface + header bell now exists, which unblocks the cross-refs in items 54 (assignment notifications) and 60 (arrival signal).

⚠ **This line said "item 59 is likely already fixed; verify before scheduling it". The verification was done on 7 Sep 2026 and it was NOT fixed** — the persistence worked perfectly and a fixed conversation id (`'draft-initial'`) made the saved transcript unreachable on reload AND overwrote it on the next session. See item 59's ✅ block. The instruction to verify rather than assume is exactly what found it; the guess in the same sentence was wrong.

Standalone items not in a package: 17 (sign/tone), 31 (chase draft reactivity/editability — touches G for the compose seam), 45 (Stripe portal config diagnosis), 49 (duplicate resolution, prototype-verified), 58 (chat upload intent step), 64 (setup-link panel → portal-access card).

Late additions and where they land: **63** (missing list on the Chases tab) sequences after package A; **65** (data-aware AI-tab suggestions + proactive task analysis) leans on A's counts; **66** joined package G (it's the approval matrix itself); **61 + 67** form package L (one retention/deletion policy); **60** is resolved (file arrived late) leaving only its Received-via-on-Inboxes follow-up, which is package E's; **59** ✅ **RESOLVED 7 Sep 2026** — and it was NOT closed by the items-9/12 pass, whatever this line used to predict.

✅ **The standalone five closed together on 6 Sep 2026** — **31 · 49 · 58 · 63 · 65**, one branch, one commit each (`fix/review-items-31-49-58-63-65`). Each entry below carries its ✅ block; evidence in `assets/2026-09-06-standalone-five/`. Two owner rulings taken in-session: the §8.2 copy amendment (long chase lists summarise, server template AND preview) with accountant-editable wording built rather than deferred, and the `document.resolve-duplicate` contract delta (kind + `GET /v1/duplicates`) with "attach to the original" deferred by name. The sequencing held: **63 and 65 both waited on package A (#255) and read its one predicate / its served counts rather than minting new ones.** That closes the standalone list **in code, entirely** — 17 and 64 landed 5 Sep, 31/49/58 here — leaving **45** as the only one still outstanding, and it is not a code item: it is diagnosed (#259) and waits on one click in the Stripe dashboard, which is the owner's to make. ⚠ An earlier draft of this line said 17 was unclosed; it was resolved on 5 Sep and the claim was simply wrong.

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

**◐ PARTLY RESOLVED (7 Sep 2026, branch `fix/review-items-59-18-16`) — package
D's date control landed; the rest is a recorded ask.**

**What was done — the period input, which is the half that made the dialog
unusable.** The `<input type="month">` in the screenshot renders as an unlabelled
free-text box in several browsers (that is the `12` he typed) and the confirm
gated on a `YYYY-MM` regex he had no way to discover. It is now `UkMonthField` —
two selects, **the month as a NAME** — so there is nothing to parse, nothing to
mis-order, no locale to get wrong and no picker to be unavailable. Below it the
dialog restates the ask in words: *"Asking for the August 2026 statement."* The
confirm gates on the control, not a regex. Evidence:
`assets/2026-09-07-items-59-18-16/08-item16-the-statement-month.png`.

**What is NOT done, and why it is an ask rather than a half-build:**

| Asked for | Blocked on |
|---|---|
| Range / by year / single-date modes | `chase.send`'s `statementPeriod` is a single `YYYY-MM` on the wire and the engine composes the message from it. A contract widening AND an engine change — the message template, the portal ask, and `toChaseItem`'s statement projection all read one month. |
| ~~Send-via-SMS / send-via-email checkboxes~~ ✅ **RULED AND BUILT (7 Sep 2026)** | The owner chose **shown but greyed out** over hidden. A LIVE tickbox would have been the lie launch M8 removed; a DISABLED one wearing its reason says something true — the product knows the channel and this release does not have it — and it stops an accountant wondering whether a text went out as well. It submits nothing: email is the only value, so nothing rides on the request until `SMS_SENDER=aws` reaches a practice. Pinned in `RequestStatementDialog.test.tsx`. |
| Both previews before confirming | The message is composed **server-side at review** (D44) and the review card already shows it verbatim. A second, client-side mirror of the preset template would be a second opinion about what will be sent. The honest version is a preview step that asks the server to compose without staging — a new read on `chase.send`, so contract work. |
| AI-personalised copy | The entry says explicitly: noted for later, not now. |

**For Shakib:** the first row is the one that unblocks the other three — decide
whether `statementPeriod` becomes a range (`periodStart`/`periodEnd`, or a
`{kind, value}` union) and the rest follows in one package.

---

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

**✅ RESOLVED (5 Sep 2026, branch `fix/review-items-17-45-64`).**

**What was done:** money INTO the account wears a **plus** — `txnAmountLabel` in `BankView.tsx` renders `+£543.98` in green off `isCredit` (the signal `api/bank.ts` reconciles from the server's signed pence), NEVER off the local sign of `amount`; money out stays unsigned and unpainted. The same rule reaches the MatchPicker and CashCodePanel headers, and the CSV export (`csvAmount`) signs by the server's own convention — in positive, out negative — because a file has no colour column to carry direction. And **missing evidence is red both ways**: "Credit — no document" keeps its wording and wears the same red as "No document" (screenshot 01; the same red ramp classes, so it inherits whatever the light-theme gap does). Chase candidacy untouched — credits stay non-chaseable (#255). Both rules pinned in `BankView.test.tsx`; the sweep found the chase composer renders no amounts and the live composer cards list debits only by construction. Evidence: `assets/2026-09-05-standalone-17-45-64/01–02`.

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

**✅ RESOLVED (7 Sep 2026, branch `fix/review-items-59-18-16`).**

**⚠ The brief's premise was wrong, and finding that out was most of the work.**
`getDocumentOriginal` does declare the portal principal — but under that bearer
the boundary was the session's GRANT (`id = ANY(app_granted_item_ids())`), and a
grant is widened only by the upload path, so it holds exactly what the CURRENT
sign-in uploaded. Signed into American Burger's portal and probed all five rows
its own list returns, **including the `SMS_PORTAL` one the client sent
themselves: every one answered 404.** A per-row [Open] would have failed on every
row on the screen.

**Shakib's ruling, taken in session:** *"any document in their own list."* So the
server reads under the practice SYSTEM context narrowed **in the query** by
`portalVisibleDocuments(facts)` — the exported `where` that
`GET /portal/documents` has always built its list from. The set a client can see
and the set a client can open are now one set by construction, archived and
deleted exclusions included, so an accountant who withdraws a document withdraws
it from both surfaces with one edit. Said plainly in
`documents/CLAUDE.md`: this trades a database guarantee for an application one on
this endpoint, deliberately. **The cost is named there too** — a forwarded CHASE
link's anonymous holder can now open any document of that business;
`resolveOnboarding` closes it and also stops the chase portal previewing its own
upload, so the narrower door is a one-line change the day it is wanted.

**The web half:** `views/business/PortalDocumentList.tsx`, one row component on
two surfaces — Home's recent few and the Upload tab's browsable list with a
status filter over the server's five words, a count, and one more page of fifty
per press. Per row: status pill, date, amount, **how it arrived in the client's
own words** ("Sent from here", "Emailed", "WhatsApp", "Added by your
accountant"), [Open] and [Download].

Four decisions worth knowing:

- **⚠ No practice-internal state, and a test guards it.** `PortalDocument`
  carries no `state`/`inbox`/`categoryCode`/`failureCode`, so the component has
  **no mapping table from anything to anything**; `PortalDocumentList.test.tsx`
  asserts over the rendered text that `TO_REVIEW`, `SMS_PORTAL`, `NT-DOC…` and
  friends never appear.
- **Only an image previews in place.** Framing the PDF renders on desktop Chrome
  and fails where this surface lives — iOS Safari shows page one of a framed PDF
  with no way to the rest. Anything else is handed over as a real anchor, which
  is also what makes it work: the presigned URL is fetched on the press, so the
  gesture has expired and a `window.open` would be blocked by Safari.
- **The presigned URL never leaks as a `Referer`** (`rel="noreferrer noopener"`,
  `referrerPolicy="no-referrer"`) and is fetched per press, never stored.
  `DocumentViewer` is not reused — the portal is the lightest route in the
  product and nothing it imports may become shared with a practice screen.
- **A refusal blames nobody.** One 404 covers "not this client's" and "your
  accountant took it back", so the copy claims to know neither.

**"Other document control functions" — deliberately NOT built**, and the reason
is the entry's own: the accountant's pipeline owns document state, and a client
deleting evidence out of a practice's books is not a portal power. Renaming after
the fact is the one plausible addition and is not in this package.

Cost: **+2,018 B** on the portal route (239,939 → 241,957 B by closure), leaving
8,043 B of headroom on the product's most protected surface.

Walked live: the list, a client opening the receipt they photographed, and the
status filter — `assets/2026-09-07-items-59-18-16/03-item18-the-browsable-list.png`,
`assets/2026-09-07-items-59-18-16/04-item18-a-client-opens-their-own-receipt.png`,
`assets/2026-09-07-items-59-18-16/05-item18-filtered-by-the-five-words.png`,
`assets/2026-09-07-items-59-18-16/06-item18-home-rows-open-too.png`.

⚠ **A seed defect found on the way:** several seeded documents (`doc_014` and
friends) have rows but **no bytes in MinIO**, so opening one shows the object
store's `NoSuchKey` XML. Not this package's code — the same would happen on the
accountant's viewer — but it will be the first thing a demo hits. Logged here
rather than fixed.

---

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

**✅ RESOLVED (6 Sep 2026 — the coding-intelligence package, with item 48).**

**What was done:** the exact document in the screenshot now answers. Upload the Aldgate Meats invoice to a restaurant and the panel reads **"Suggested — not applied — as Cost of sales: Food and drink. Beef, chicken and lamb from a known meat wholesaler, purchased as food stock for this restaurant."** — 75% confident, `RULE: INDUSTRY_CONTEXT_REASONING`, with **Cost of sales: Purchases** offered as a second choice and one tap to accept. That sentence is the model's own; the code is one the client's chart carries; and the Category row still shows `—` until a human approves the correction (screenshots `assets/2026-09-06-coding-intelligence/01` before, `02` after).

**His three rules, each answered:**

1. **Never a null.** The model tier fires over exactly the three escalations that mean *the deterministic layer knows nothing* — `NO_LINE_DETAIL`, `NO_MATCH_ON_CHART`, `NEW_SUPPLIER_NO_HISTORY` — which is what he overruled. The other seven stay terminal because each names something specific (the sums do not reconcile, a licence term is not printed, an amount sits on the practice's own capitalisation policy, the lines split across treatments one column cannot hold). Escalating on those is the right accounting answer, not an abstention.
2. **"No category printed on the invoice" is never a reason to abstain.** Rule 9 of the coding prompt says so in as many words, and the client's own trade is in the prompt: the seeded business-type label plus their intake answers, wrapped (§24.4). ⚠ The same meat to a cleaning agency does **not** code to food — that is an eval case (`aldgate-002`).
3. **Higher-capable model.** `TASKS.codingSuggestion` moved `workhorse → judgment` (opus-4-6), Shakib's decision in session. ⚠ **The cost estimate it was first taken on was 42% low** — 1.74p guessed, **2.47p measured** (`scripts/measure/coding-cost.ts`) once a real chart and real intake answers were in the prompt. A document that reaches the rung costs 3.81p against the £0.02 blended guardrail, which holds while fewer than **27%** reach it. Shakib re-confirmed the pin on the measured figure.

⚠ **The rate is the number to watch, and it is measurable now** — `scripts/measure/coding-escalation-rate.ts`, which needed no new instrumentation because `document_events` already records a coding row per document. It counts by BASIS rather than outcome, because supplier memory is a suggestion that costs nothing and counting it as a model call would inflate the estimate. Nobody has run it against a real corpus; on the walkthrough client it read **75%** when the client was brand new and **33%** eight documents later, as memory took over — which is the shape the whole ladder is designed to produce, and why the rate has to be watched rather than assumed.

**Two things the live recording taught, both now in the code:**

- ⚠ **The model reported 0.97 confidence** on a zero-shot categorisation of a brand-new supplier, where the published figures are 62.5% top-1 and ~36% zero-shot and the module's own brightest line caps at 0.9. The prompt asks for honesty and got 0.97 anyway — so `MODEL_MAX_CONFIDENCE` bounds it at 0.75. A display bound, never a gate; ordering below the ceiling is preserved.
- ⚠ **The model rung cannot run inside a transaction.** `decide()` was called inside the pipeline's write transaction, which `scopedDb` gives 10 seconds. The ladder now runs in a short transaction of its own (phase 2.5) and the model call happens with nothing open — the `modules/approvals` ledger-follow-up rule, applied. Phase 3 drops the suggestion if a rule coded the document in between, so *a suggestion never rides beside a rule* holds by construction.

**The §9.8 gate:** `pnpm test:eval:coding` — a second eval runner (different prompt, tool schema, task class and version constant from chat's). Recorded live and replayed offline: **ladder 12 cases / 30 assertions 100%, second opinion 5 cases / 7 assertions 100%, injection 0 leaks.** It drives the REAL `decide()` → `reconsider()` → `codingSuggestionFor()`, so it measures the ladder that ships rather than a re-implementation of the tier order.

## Item 20 — Coding correction: modal + blurred backdrop must dismiss after the confirmation shows

**Original (verbatim):**
> After changing the category of an invoice manually the modal backdrop with the blend balk screen must disappear after showing the confirmation

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — after approving a category correction: the green toast "Correction approved — Category is now human-confirmed." sits at the top, but the whole DocumentPreview underneath is left **blurred behind a dark scrim** — the coding-proposal modal's backdrop never clears, leaving a dead screen the user has to close by hand.

**Brief:**
The manual-category flow (DocumentPreview → correction → `CodingProposalModal`, the create → Read review → Approve ritual) shows its success state but does not release the dialog: the backdrop/scrim and blur stay after "Correction approved". Expected behaviour: show the confirmation, then **auto-dismiss the modal and backdrop** (brief delay or immediate close with the confirmation surfaced as a toast on the underlying screen), returning the user to the now-updated document detail. Fix lives in `apps/web/src/components/DynamicComponents/CodingProposalModal.tsx` (and possibly its host in `DocumentPreview`) — on approve-settled, call the modal's `onClose` after the confirmation renders instead of parking on the outcome banner. Note the Approvals queue deliberately keeps decided cards mounted with an outcome banner (`ApprovalsLiveQueue`) — that pattern is right for a queue and wrong for a modal over a document; don't "fix" the queue while fixing this. Pure web change, no contract impact.

**✅ RESOLVED (6 Sep 2026, package G — the approvals package).**

**What was done:** after you approve a category correction the confirmation
shows and then the dialog and its blurred backdrop close themselves, putting
you back on the updated document. No more dead screen to dismiss by hand.

**Where it landed:** `CodingProposalCard` gained `onSettled`;
`CodingProposalModal` holds the timer and calls `onClose` 1.4 s after the
confirmation renders. ⚠ **It fires on the SERVER settle, never on the click** —
`ReviewGate` shows its banner optimistically and a refusal a moment later swaps
the card to its red `failedOnCard` alert, so dismissing on the click would throw
away the one screen telling somebody their correction was not saved. The dwell
is not zero either: a dialog that vanishes the instant you click leaves a person
unsure anything happened. The timer is a ref cleared on unmount, and the `Modal`
frame (items 23+40, #258) is untouched.

The Approvals QUEUE keeps its decided-card outcome banners — that pattern was
added because the settle refetch used to unmount them instantly, it is right for
a queue and wrong for a modal over one document, and both files now say so.

**Verified LIVE, both halves.** The success path: the confirmation on screen
(`docs/reviews/assets/2026-09-06-approvals/09-coding-modal-confirmation.png`),
then the dialog and its backdrop GONE, back on the updated document with
Category reading `COS_FOOD_AND_DRINK` "✓ Confirmed by you" and the state moved
to READY (`…/10-coding-modal-dismissed-itself.png`). And the half that matters
more: a REFUSED correction keeps the dialog open with its red alert
(`…/08-coding-modal-refusal-keeps-it-open.png`), because the dismissal fires on
the server settle and not on the click. Both are pinned in
`CodingProposalModal.test.tsx` with fake timers.

⚠ Walking the success path took five seed defects with it — the document detail
did not render at all on seeded data. See the last section of this file.

---

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

**✅ RESOLVED (5 Sep 2026, PR #260 — the channel-provenance package; the derivation option, no `DocumentChannel` enum change needed).**

**What was done:** the split is read off provenance the server already had. The portal session knows which door is acting (`facts.chaseId`: a chase-link session names a chase, a signed-in one does not), so the upload intent now signs a per-row label into the claims — `uploaded-via-chase-link` for a chase session, `Uploaded by {member} ({business})` (or the `uploaded-via-client-portal` slug) for a signed-in one — completion writes it to `documents.submitter_label`, and `DocumentSummary` gained `submitterLabel` (moved from the detail half, entirely additive) so LIST rows carry it. The web then maps `SMS_PORTAL` per row: only an explicit chase-link row reads **"Chase link"**; everything else — including every pre-existing `uploaded-by-delegated-session` row, which the old code could not tell apart — reads **"Client portal"**, the superset that is true of both, so the reported lie is fixed on historical rows too. The words are one catalogue now (`lib/channelLabels.ts`), consumed by every render site the brief lists: the Costs column no longer shows the raw slug, DocumentPreview's header reads **VIA CLIENT PORTAL / VIA CHASE LINK** (screenshots `docs/reviews/assets/2026-09-05-channel-provenance/04`, `05`), DocumentsView's tables and filter, AnalyticsView's mix ("Business portal" reworded "Client portal" so chart and cells agree), and InboxesView's filter (which also gained the missing `chat` option). Nothing anywhere says SMS. The SoT §8.3 audit string `uploaded-by-delegated-session` stays byte-exact on the chase event trail. Pinned in `documents.test.ts` (contract-exhaustive channel table + the split), `channelLabels.test.ts`, `InboxesView.test.tsx`, `portal-upload.service.test.ts`, and the delegated-upload integration test against real RLS; walked live end to end (all five doors — `03-costs-received-via-honest-words.png` shows Chase link, Client portal, Chat upload, Email, WhatsApp and Uploaded-by side by side). A first-class `CLIENT_PORTAL` enum value remains open as an owner decision; recorded in `packages/contracts/CLAUDE.md`, not taken unilaterally.

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

**✅ FULLY RESOLVED — the deterministic layer 5 Sep 2026 (PR #256), the MODEL-backed second opinion 6 Sep 2026 (the coding-intelligence package).**

**The model half, added 6 Sep 2026.** The deterministic checks answer arithmetic; only a reader can answer *is the thing a person typed actually on this document?* It now does. Type a supplier the document does not name and the review card says **"“Bidfood Wholesale Ltd” does not appear anywhere on this document — the document names a different party, or none. Check you are looking at the right document before approving."** — in the SAME ⚠ Checks section, beside the £9,000 tax warning, above the same "these checks gate nothing" line (`assets/2026-09-06-coding-intelligence/04`). Three shapes: a supplier not on the document, a total not on it, and an account that argues with what was bought ("Hotel" for a window-clean).

Four decisions worth knowing, three of them measured rather than designed:

- ⚠ **The model returns an ENUM per field and no prose.** The sentence is ours, composed from what the HUMAN typed. That card is frozen into the hash a super admin echoes and every other string on it is server-composed; a model-authored sentence there would be the one piece of text on the approval path written by the document itself.
- ⚠ **`NOT_CHECKABLE` is a first-class verdict and raises nothing.** Measured live against item 47's selfie: shown a document the pipeline read NOTHING off, the model answers "I cannot tell", not "absent" — and it is right. The deterministic layer already covers that shape, so the model staying quiet is the two layers not saying the same thing twice, which is what keeps a warning worth reading.
- **Never blocking.** Unreachable, over budget, refused, unparseable: all `null`, all silence, deterministic checks unchanged. It runs inside the review transaction with a hard 4-second cap — a slow answer is discarded rather than waited for, because an accountant who cannot approve a coding fix is a worse outcome than one who does not get a hint.
- **The seam is #256's**, unchanged: same `CorrectionCheck` shape, same ⚠ Checks section, same [Ignore] flow, zero web bytes.

**What was done:** type £9,000 of tax on a £994 invoice and the product now stops you before anything is saved: *"Tax £9,000.00 is larger than the total £994.00 — a document whose tax exceeds its total will produce NO line in the export file."* Exactly the two buttons the ruling asked for: **[Ignore — I'm sure]** (the accountant always wins — the value goes through exactly as typed) and **[Go back and fix]** (the typed value returns to the field for editing). Ignoring does not bury the warning: it is printed again on the approval card, and the server writes it into the review record, so the approval that follows is an informed one. The same treatment covers a tax and a total pointing in opposite directions. And the "100% confident" badge on human-typed values is gone — a value a person typed now reads **"Confirmed by you"**, because a human answer is not a probability and the old badge read as the system endorsing whatever was typed. Screenshots: `docs/reviews/assets/2026-09-05-correction-integrity/` (04, 05, 06, 07).

**Where it landed:**
1. **The shared check emitter** — `validation-dedupe/correction-checks.ts`, pure, integer pence: tax exceeding the total (the exact £9,000-on-£994 shape, message naming both figures and the export consequence), tax/total sign disagreement, document date in the future, document date > 7 years old, and money/category typed onto a non-financial document (item 47's condition). Property-tested over magnitude ranges. The shape is the seam items 19/48's model tier plugs into.
2. **Client-side** — `apps/web/src/lib/correctionChecks.ts` mirrors it rule-for-rule; the correction dialog (`CodingProposalModal`) opens on the WARNING with **[Ignore — I'm sure] / [Go back and fix]**. Ignore proceeds with the ORIGINAL typed value and the ignored warning is RESTATED inside the Review → Approve card; Go back returns the typed value to the field. Pinned in `DocumentPreview.test.tsx`.
3. **Server-side** — the engine runs the same checks when the proposal review is first opened (`computeCorrectionAdvisory`, read under the caller's own RLS scope) and freezes them into the rendered summary as a **"⚠ Checks — read before you approve"** section, so the advisory is part of what the approve hash covers. ⚠ Why review-time rather than compute-at-creation: the `UpdateCodingPayload` schema is the contract's and `.strict()`, so computed facts cannot ride the payload without a G7 change — the reasoning is recorded on `RenderContext` in `render-summary.ts`.
4. **The "100% confident" endorsement is gone** — a human-confirmed field now reads **"Confirmed by you"** (`documents.documentPreview.confirmedByYou`), never a percentage; the machine-read rows keep theirs.
Verified end to end in the app (local, seeded stack — the walkthrough document is dated Aug 2026): retyping the £9,000 tax warns, Ignore stages, the review restates, and correcting it back makes the period's export succeed (see item 29 below). Zeplow's own stuck July-2025 document on staging is PUBLISHED with the bad tax and therefore locked against correction — unarchiving with clear-publishing-data, correcting, and re-releasing is the staging repair path.

## Items 23 + 40 (combined) — Modals can't scroll: Approve unreachable in the publish dialog; every modal needs the overflow audit

*One defect, reported twice at two altitudes: item 23 is the release-blocking instance, item 40 generalises it to the whole modal population.*

**Original — item 23 (verbatim):**
> Scroll not working wtf have you checked, not being able to publish

**Original — item 40 (verbatim):**
> do deep research on each modal and check their overflow status, most of them if with overflow bug, there is content at the bottom but i'm not being able to scroll

**Images:**
- Item 23: `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — `PublishBatchDialog` ("Release 1 item for export", Zeplow Inc.) with the staged review card mounted ("Release for export — AWAITING REVIEW", server-computed preview: Items 1, Gross £994.00, VAT £9000.00). The card is cut off mid-heading at "THE ACCOUNTING ENTRY THIS RELEASE WILL PUT IN THE IMPORT FILE" and **the dialog will not scroll**, so [Read review]/Approve below the fold are unreachable — publishing is impossible. (The VAT £9000 is item 22's bad correction flowing through, separate issue.)
- Item 40: `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the intake Review step (dark theme): the "Create client & email the sign-in link" button is **cut off at the bottom edge** and the dialog will not scroll.

**Brief:**
The shared `DynamicComponents/Modal`'s 2 Sep bounded-and-scrolls fix (`max-h-full` wrapper + `overflow-y-auto overscroll-contain` children box) demonstrably fails in the real browser — pinned only by a class-contract test in jsdom, **which computes no layout**, so the mechanism was never browser-verified. Confirmed on at least the publish dialog (`PublishBatchDialog` + `LiveProposalCard`, which grows by the server's whole review) and the intake Review step; his "most of them" says to assume the family.

Likely mechanical suspects (check in the browser, not jsdom): the `max-h-full` chain broken by an unbounded ancestor (the flex `items-end`/centred wrapper — every ancestor must actually bound height); flex children missing `min-h-0`; the dialog's own inner scrollboxes (e.g. the publish dialog's `max-h-52` list) trapping scroll.

**Severity: release-blocking** — the publish dialog is the only publish path since the S14 sweep, and Published gates Export (D42/D43). Work shape:
1. Fix in the Modal frame first, so every shared-frame dialog benefits at once.
2. **Inventory every modal** — shared-`Modal` children (`RequestStatementDialog`, `PublishBatchDialog`, `CodingProposalModal`, intake, invite, offboard, viewer, purge…) *and* the own-chrome dialogs (`AnalysisModal`, `DuplicateModal`, `ChaseModal`, `WorkflowEditor`, tour overlay, portal dialogs) — and reproduce at a short viewport (e.g. 1280×720) in headless Chrome/CDP, the repo's established audit pattern: for each modal, the bottom-most interactive element must be reachable by scroll.
3. **Keep the smoke**: a browser-level "every dialog's last button is reachable" check, because jsdom can never catch this class and it has now shipped twice.

**✅ RESOLVED (5 Sep 2026, the modal-overflow package).**

**What was done:** the dialogs scroll now. The publish flow completes at 1280×720 — stage → Read review → scroll → Approve clickable (screenshots `docs/reviews/assets/2026-09-05-modal-overflow/10–14`), and the intake Review step reaches its Create button (`15–16`). Every dialog in the app was then walked in a real headless Chromium at BOTH viewports (1280×720 and 390×844) with the window forced short enough that the dialog had to scroll, asserting the bottom-most interactive element scrolls into view and is hit-testable — the audit table is in PR #258's body, with the per-dialog screenshots committed beside this file.

**Root cause, per dialog family:** the 2 Sep bounded-and-scrolls fix was mechanically defeated by one flexbox rule — a flex item whose overflow is not `visible` has an automatic minimum size of ZERO, and nearly every dialog card carries `overflow-hidden` for its rounded corners. So inside the shared frame's column-flex scroll box the card was **shrunk to fit instead of overflowing**, and its own `overflow-hidden` clipped the tail: `scrollHeight === clientHeight`, nothing to scroll, last button unreachable. The jsdom class test could never see this because every class was present and correct — the defeat lived entirely in layout. Fix: `[&>*]:shrink-0` on the frame's scroll box (one class, every shared-frame dialog fixed at once). Second family: `ConfirmStep`, `OffboardClientDialog` and InboxesView's two synthetic confirm dialogs used `items-center`/`items-end` scrims with **no scroll at all** — a too-short viewport clipped both ends by construction; they now centre/anchor the card by auto margins on a scrolling scrim (auto margins collapse to zero on overflow). Third: `BusinessPortalLauncher`'s InviteForm branch sat bare inside a bounded `overflow-hidden` card with no scroll box — it has one now. The own-chrome dialogs on the `items-start` + scrolling-scrim pattern (AnalysisModal, ChaseModal, DuplicateModal, StatementModal, the view previews, the portal shells) were mechanically sound all along and audited as such.

**The smoke that stops a third shipping:** `scripts/measure/modal-reachability.mjs` — no-dependency raw-CDP, spawns headless Chromium at 1280×500, walks intake-to-Review and publish-to-server-review, and fails unless the last button genuinely scrolls into view and is hit-testable; it also **refuses to pass when the dialog doesn't overflow**, so it cannot rot into a non-proof. Verified both ways: green on the fix, exit 1 with the exact `scrollHeight === clientHeight` signature when the fix is removed. e2e/ is still an S0 scaffold, so this lives with the other measure scripts; invocation is documented in its header and in `apps/web/CLAUDE.md`'s Modal section, which now records the root cause and demotes the jsdom class test to a tripwire.

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

**✅ RESOLVED (6 Sep 2026, package G).**

**What was done:** the dialog stops lecturing you. As the super admin you now
read *"You can approve this after reading the review — it opens as soon as you
stage, and nothing is Published until you do."* Everybody else still reads who
releases, and more plainly when their role is not the release role.

**No contract delta was needed** — option 1 in the brief turned out to be
already done. `Me.isOwner` is required in the contract and answered from the
same acting membership `role` comes from; package F landed it. Recorded as a
finding at `docs/Access_and_Approval_Matrix.md` gate ⚖9 rather than a gate.

**Where it landed:** `holdsReleaseAuthority(session)` in `api/auth.ts` is
`canRelease(role) && isOwner` — `mayRelease` in `assert-can.ts`, verbatim — and
is the ONLY place any surface reads it, so the whole D44 family branches from
one fact and cannot drift: `PublishBatchDialog`, `RequestStatementDialog`,
`OffboardClientDialog` (whose generic "after it is approved" is deleted, since
`business.offboard` is tier 1 now and that sentence let a standard user think
their confirm was the decision), `LiveProposalFlow` and `CodingProposalCard`.

⚠ The old rule is retired, its REASON is not: no branch says *"you have
permission"*. They say what the flow does next, because the server is still the
rule and a `/me` thirty seconds stale is exactly how its refusal arrives.

**Plus ⚖5's live consequence, which is the other half of this item.**
`document.update-coding` is tier 1 now and `updateCodingProposal` drove
create → review → approve behind one click, so a standard user's third call
answered 403 and the card said *"That correction was NOT saved"* — true of the
value, wrong about the act. It stages and stops: the button reads **Send for
approval**, the note names who releases, and the optimistic field update does
not fire.

**Verified LIVE:** `docs/reviews/assets/2026-09-06-approvals/01-d44-copy-role-aware.png`.

---

## Item 25 — Chat gives a confidently wrong answer: "nothing missing" for a client with a screen full of undocumented transactions

**Original (verbatim):**
> Ai is giving wrong answer, nothing was chased or finished, make sure to maintain proper ai memory and analysis if asked any question, without proper thinking and analysis ai must not reply

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — chat, Practice Admin, 1 client in scope. User: *"What is still missing for Zeplow Inc.?"* Assistant: *"Here you go: **Nothing missing for Zeplow Inc. — every detected gap is closed or already chased.**"* — while the Bank screen (item 17's image) shows a page of Zeplow rows tagged "No document", and no chase was ever sent or completed.

**Brief:**
The MISSING intent's answer contradicts the product's own Bank screen. The reply is the `LiveMissingCard` empty-state copy, and that card is read-only over the live bank slice (unmatched + non-suppressed via `isUnexplained`) plus open chases — so the falsehood is almost certainly **data plumbing, not model reasoning**: the card computed over an empty/mis-scoped set. Prime suspects: the chat scope's business id not resolving to the server's Zeplow id (the seed↔server id bridge — `navigation.businessId` rewrite or `isSameClient` failing for this cast), the bank slice not being hydrated in the chat context, or the server's grounded answer being generated without reading the transactions at all. Diagnose which layer produced the sentence first (client card empty-state vs. server §9 grounded turn).

Mubashir's general rule on top of the specific bug: **the AI must not answer a data question without actually analysing the data** — if the grounded read fails or returns nothing verifiable, say so ("I can't verify right now") rather than emitting a confident all-clear. An empty result set and a failed/mis-scoped read must render differently: "nothing missing" may only be said when the transactions were actually read and genuinely all matched/chased. Add an eval case for this exact turn (client with unmatched undocumented lines → the answer must enumerate them), since §9.8's gate is where accuracy claims live.

**✅ RESOLVED (5 Sep 2026, PR #255 — the matching-lane package).**

**What was done:** the AI never actually looked — that question button on the client's AI tab was showing a pre-written answer over an empty local list; it never asked the server anything. Now clicking it sends the question to the real AI, which reads the client's actual bank data and lists exactly what's missing (screenshot: `docs/reviews/assets/2026-09-05-matching-lane/21-chat-missing-answer.png` — the answer enumerates the real undocumented lines, settlement credits correctly absent). And when the data *can't* be read — a failed load, a client that didn't resolve, a read still in flight — the card now says "I can't verify right now" instead of pretending everything is fine. "Nothing missing" only ever appears when the data was genuinely checked and is genuinely clean.

**Where it landed:** the root cause was that the turn **never existed** — ClientDetailView's `scoped()` fabricated the exchange locally (canned user message, "Here you go:", intent `SHOW_MISSING` → `ActionCard` over the synthetic `missing` array, EMPTY by design live since M2). Fixes: (1) live, the three AI-tab prompts queue through a new `pendingUtterance` bridge in AppContext and `InputRow` submits through the REAL chat lane (`POST /chat/turns` — pinned model, grounded answer, model meta on the reply); synthetic keeps the injected-card flow byte-for-byte. (2) `LiveMissingCard` consults `slices.bankTransactions`: failed/never-made reads, unresolvable scopes (the id-bridge failure shape), loading and truncation all answer honestly. Pinned in `LiveMissingCard.test.tsx` — client-side fix, so a component test rather than an eval case, per the package's acceptance. ⚠ The same fabricated-turn pattern still exists on **ClientsView's drill columns** (`SHOW_MISSING_TABLE` / `SHOW_MATCHES` over empty live arrays) — flagged as follow-up, not fixed here.

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

**✅ RESOLVED (6 Sep 2026, package G).** All three asks.

**1 · Duplicate suppression.** Staging the same act twice is refused server-side
with `409 NT-PRP-007`, and the dialog says *"This release is already awaiting
review — the same documents were staged for this client and nobody has decided
it yet"* with an **Open Approvals** button. The `Idempotency-Key` never helped:
each click carried a fresh one and was honestly a separate REQUEST — what they
were not was a separate ACT.

⚠ Identity is NOT the payload hash. The engine rewrites publish/chase/statement
payloads at creation with live facts, so two identical clicks a minute apart
hash differently the moment anything moves. `proposal-identity.ts` extracts the
RECORD IDS, which survive the rewrite; total over `ProposalKind`, and `null`
("never dedupe this kind") is a real answer — `rule.create` is the deliberate
one, because two rules over one client are two rules. Three entries are traps a
naive key would have set, each with a test: archive vs UNarchive over the same
documents are opposite acts, revoke-link keys on LINKS not documents, and a
duplicate ruling keys on the ORDERED pair.

**Cleanup for the queue as it stands:** `scripts/cleanup-duplicate-proposals.ts`
(`--dry-run` by default). Same identity function as the server, keeps the newest
of each group, CANCELS the rest with `outcome.supersededBy`. Nothing is deleted.
⚠ Its first draft printed *"Scanned 0 … nothing to do"* against a database
holding six, because `action_proposals` is RLS-FORCED and an unscoped read
answers empty without erroring — the trap `backfill-import-fingerprints.ts`
records one table over. It now sweeps practice by practice through `scopedDb`,
and the walkthrough is what caught it.

**2 · The super-admin fast path.** Governance §10's spine survives intact: a
tier-1 action staged by the super admin does not QUEUE — the same
stage → Read review → Approve happens inline, and the record written is
byte-for-byte the record a queued approval writes. ⚠ It automates [Read review]
and nothing else; Approve still mounts only after the server's own render
arrives and a human still presses it. Ruled at
`docs/Access_and_Approval_Matrix.md` ⚖6.

**3 · Per-member attribution.** The queue rendered `createdByUserId` raw. It now
falls through a resolved name (from the practice-members read) → **"you"** →
**"a colleague"**, and never to the id: a CUID is not a degraded name, it
identifies nobody and reads as the screen having failed.

**Verified LIVE:** the queue reading *"PROPOSED BY PRIYA RAMAN"* over three
identical release cards (`docs/reviews/assets/2026-09-06-approvals/00-queue-duplicates-and-proposer-name.png`);
the duplicate refusal with its link
(`docs/reviews/assets/2026-09-06-approvals/02-duplicate-refused-with-link.png`); the fast path — staged,
and the server's review already open with Approve mounted, no [Read review]
press (`docs/reviews/assets/2026-09-06-approvals/03-fastpath-review-opened-itself.png`); and the cleanup
script cancelling two of three seeded twins with `supersededBy` set.

---

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

**✅ RESOLVED (6 Sep 2026, package G).** The whole loop, approved at
`docs/Access_and_Approval_Matrix.md` gate ⚖7.

1. **Deny with a required reason.** `POST /v1/action-proposals/{id}/denial`, and
   the reason is required where cancellation's is optional — withdrawing your
   own work owes nobody an explanation, refusing somebody else's does. On the
   card, Deny sits beside Approve and the first press opens a field somebody can
   read back; ⚠ **Approve is withheld while it is open**, because somebody
   mid-sentence about a refusal must not have Approve one mis-click away.
2. **A state of its own.** `ProposalState` gains **`DENIED`** — not `CANCELLED`
   with a flag, because `?state=` is what History filters on and telling *"the
   proposer withdrew it"* from *"the principal refused it"* is the entire product
   of this feature. And `DENIED`, not `REJECTED`: `DocumentState.REJECTED` and
   the `document.reject` KIND already mean a document judged unusable.
3. **Who may deny follows who may approve, per tier** — the same
   `assertCanApprove` the approve path calls, first in the ladder.
4. **The email.** The reason, verbatim, to whoever staged it. Sent AFTER the
   commit: an SMTP round trip may never hold a tenant transaction open, so a
   send failure cannot un-deny anything and must not — the decision is on the
   proposal, in the audit chain and on the document.
5. **The document goes back.** A denied `publish.batch` drops its documents
   `READY → TO_REVIEW` wearing *"Denied by {name}: {reason}"*. Only rows still
   READY move; one that has moved on is skipped, never forced. The tag cost
   **zero web bytes** — `failureMessage` already becomes `Document.statusNote`
   and the client tables already render it as the amber pill.

**On the document state machine, as the brief asked:** `READY → TO_REVIEW` was
already legal. What did not exist was a way to attach a REASON to it —
`DocumentTransition`'s non-failure branch carries `failure?: never` so that
`REJECTED`/`FAILED` can never be written without one. A third union member lets
`TO_REVIEW` carry an OPTIONAL reason; that mechanical guarantee is untouched,
and `TO_REVIEW → READY` now clears it so a corrected document stops carrying why
it was sent back.

⚠ **The Approvals History TAB is still the synthetic table.** The reason renders
on the proposal CARD, read off the server's own `outcome`; a live History over
`?state=DENIED` is a separate, unbuilt job, named as such in both CLAUDE.mds.

**Verified LIVE, end to end:** the reason field with Approve withheld
(`docs/reviews/assets/2026-09-06-approvals/04-deny-reason-and-approve-withheld.png`); *"Denied — nothing was
executed. The proposer was told why."* with the reason
(`docs/reviews/assets/2026-09-06-approvals/05-denied-confirmation.png`); Bidfood and British Gas back in To
Review wearing *"Denied by Shakib Rahman: The VAT on the Bidfood invoice is
wrong…"* (`docs/reviews/assets/2026-09-06-approvals/06-documents-sent-back-with-the-reason.png`); and the
email in MailHog, subject *"Not approved: Release 2 documents for export — gross
£1697.16, VAT £282.86 — American Burger Ltd"*, reason on its own line
(`docs/reviews/assets/2026-09-06-approvals/07-denial-email-to-the-proposer.png`).

---

## Item 28 — Export date inputs render US-format MM/DD/YYYY; must be UK-readable

**Original (verbatim):**
> Why the fuck there is this 2025 recommendation here to export data?? The date selector must be in in this format 3rd March 2026 - 12th December 2026 type, not 07/30/2025

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — ExportView: FROM/TO inputs showing **07/30/2025** (month-first), after taking the "Use 30/07/2025 – 30/07/2025 instead" suggestion; below, the NT-EXP-001 refusal for that single-day 2025 period.

**Brief:**
Two halves — the "2025 recommendation" half is item 29's (the suggestion is *correct*, see below); the format half is real: `ExportView`'s FROM/TO are native `<input type="date">`, which render in the **browser/OS locale** — his environment shows US month-first, violating the repo invariant (UK d/m/y everywhere, Europe/London rendering). A native date input's display format cannot be forced from HTML, so the fix is a UK-formatted date control: keep the native picker for input but render the chosen value as UK long-form ("30 July 2025", his ask is "3rd March 2026" style), or replace with the app's own picker. Same treatment for the refusal text's dates (currently 30/07/2025 — already d/m/y, fine) and the "Use … instead" button label. Also ties into item 16's ask for a proper UK date-range selector — one date-control decision should serve both.

**✅ INTERIM FIX LANDED (5 Sep 2026, PR #257 — package C).**

**What was done:** the export form now restates the chosen period in UK long form beside the native inputs — *"Period: 30 July 2025 – 30 July 2025"* (`ukLongDate` in `ExportView.tsx`, built on a UTC date and rendered in UTC so the calendar date never shifts; pinned by test). Every date in the refusal copy and the "Use … instead" button was already d/m/y and stays so. **The full fix — the shared UK date-picker replacing the native inputs — is package D's**, noted in the code where the inputs live; the long-form line stays even then, because words cannot be misread in any locale.

**✅ FULLY RESOLVED (7 Sep 2026, branch `fix/review-items-59-18-16`).** Package D
landed and both native inputs are gone: `UkDateField` types day-first
(`dd/mm/yyyy`, parsed by the repo's existing `parseUkDate`) and restates each
date in long form under its own field. **The "Period: 30 July 2025 – 30 July
2025" line stays**, and the code now says why it outlived the bug that prompted
it: the period is a third fact — that these two dates are the span being exported
— and it is the sentence an accountant checks before producing a file. The screen
test that asserted the field's value was ISO (`^\d{4}-\d{2}-01$`, on screen) is
rewritten: **that expectation was the defect written down**, and it now asserts
d/m/y on screen and ISO on the wire. Evidence:
`assets/2026-09-07-items-59-18-16/07-item28-export-dates-day-first.png`.

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

**✅ (a), (b) and (d) RESOLVED (5 Sep 2026, PR #256).**

**What was done:** the release review can no longer present a doomed document neutrally. If a document in the batch will produce no line in the export file, the card's TITLE says so — *"(⚠ 1 document will produce no export line)"* — and the FIRST thing on the card names the document and says, in plain words, that its tax is larger than its total and what to do about it. Nothing is blocked (the super admin still decides); it is simply impossible to approve unread. Proven live end to end: typed the £9,000 tax (warned — item 22), released with the warning showing on the review, corrected the tax back, released again clean, and **the export succeeded** — "Your export is ready" (screenshots 10, 11, 12).

**The mechanics:** (a) is item 22's warning layer (see its entry). (b): the release review now leads with a **"⚠ Checks — read before you release"** section — a document that will produce NO line in the export file is the FIRST thing on the card and is counted in the card's title ("⚠ 1 document will produce no export line"), and the sign-mismatch refusal message is augmented at proposal time with the plain sentence ("Tax £9000.00 is larger than the total £994.00 — correct the tax or the total, then propose the release again"). The advisory is applied identically at creation and at the executor's recompute (`applyEntryAdvisories` in `publish-batch.ts` — `sameEntryPreview` fingerprints it, so one-sided application would refuse every approval). (d) verified live: with the tax corrected back, the 30/07/2025 export succeeds. (c) — the export refusal naming the document and the fix path — stays with package C (item 29's copy half). The exporter itself is unchanged, as ruled.

**✅ (c) RESOLVED (5 Sep 2026, PR #257 — package C).**

**What was done:** the `NT-EXP-001` "found but none exportable" refusal now names every refused document — supplier, date (UK d/m/y), amount, and the specific check it failed — and the export screen renders each with an **"Open the document"** button that routes straight to it (`/clients/<id>?doc=<documentId>`, the same preview param `ClientDetailView` already opens). Proven live: the £9,000-tax shape was recreated on the seeded Adobe document and the screen answered *"Adobe, dated 30/08/2026, £61.99 — This document's figures do not add up…"* with the button landing on that document's preview (screenshots `assets/2026-09-05-export-chain/05` and `06`).

**The mechanics:** **no contract change was needed** — the facts ride the problem's existing `errors` member under `documents/<id>`, the same shape `assertEveryNamedIdSurvived` already used, and `ntFetch` already carried `errors` into `NtProblemError.fieldErrors`, so the G7 stop-condition never fired. The web branches on the code and the field-path prefix, never on message prose (the existing rule, kept). Server half in `exports.service.ts` (`noneExportable` + `describeDocument`, money formatted server-side through `formatPenceDecimal`); pinned in `exports.service.test.ts` (both refusal reasons named, item 29's own £9,000-tax shape included) and `ExportView.test.tsx` (the rendered facts, the route, and no button when no documents are named). The exporter itself remains unchanged — `canonical-row.ts` refusing mixed signs is the design.

## Item 30 — Chase composer includes matched/published and credit lines as chase candidates

**Original (verbatim):**
> One document was sent and was published from the transactions from the bank statement but the chase engine has included it for chasing, the ai in the chat section is very poor

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — a chase item-selection list (all rows pre-ticked): includes **FASTER PAYMENT TO ALDGATE MEATS LTD £994.00** (highlighted) — the transaction whose document was sent, matched and published — plus several **credit** lines (negative Worldpay settlements, Just Eat credit). Every transaction in the statement appears ticked as a chase candidate.

**Brief:**
The chat-side chase composer is offering lines that must never be chased: (1) the Aldgate Meats £994 line is **matched to a published document** — its evidence exists in the product; (2) credit/settlement lines (Worldpay payouts, Just Eat) are the exact category the `isUnexplained` predicate exists to exclude. The repo's own rule (2 Sep, "Unexplained is one predicate now") says `LiveChaseComposerCard` and `LiveMissingCard` read the unexplained set — unmatched + non-suppressed via `isUnexplained` — so either this surface isn't using the predicate, or the underlying data is wrong in chat scope: the live bank slice's `matchState`/`matchedDocumentId` not reflecting the confirmed match (same data-plumbing suspicion as item 25 — these two are almost certainly one root cause: **the chat lane's view of Zeplow's bank data disagrees with the Bank screen's**), or the seed↔server id bridge mis-scoping the client so the card composed over the wrong/unfiltered set. Diagnose items 25 and 30 together: reproduce in the live app, log what set each card actually received, and check whether the match-confirm + publish actually wrote `matchState: 'CONFIRMED'` on that transaction server-side. Also: every row **pre-ticked** is wrong even for genuine candidates — chasing is opt-in per line, default should be unticked or curated, not "tick everything".

**✅ RESOLVED (5 Sep 2026, PR #255).**

**What was done:** two problems, both fixed. First, the system was never marking money-in lines (Worldpay settlements, Just Eat payouts) or bank charges as "nothing to chase" when a statement imported — so they all counted as missing receipts and were offered for chasing. Every imported line now gets that judgement the moment it lands: money coming in and bank fees can never be chased, because no receipt exists to ask for. A one-time cleanup fixes the lines already imported (Zeplow's 631 settlement credits drop out of the missing counts the moment it runs on staging). Second, the list used to arrive with **everything pre-ticked** — nothing is ticked now until the accountant picks the lines, the card says so ("chasing is opt-in per receipt, nothing is pre-selected"), and Stage stays off until at least one line is chosen. The server also now refuses outright to build a chase over a line that's already matched or shouldn't be chased, whatever a screen sends it. Screenshot: `docs/reviews/assets/2026-09-05-matching-lane/30-chase-composer.png` — only the genuine unexplained debits, all unticked. On the Aldgate line specifically: **the match and publish were saved correctly all along** (checked in the staging database directly — the 06 Aug £994 row is CONFIRMED, human-matched, document PUBLISHED); the composer screenshot predates that confirm.

**Where it landed:** (1) the suppression verdict is written at ingest (`statement-ingest.ts`: credit `amountPence > 0`, or the SoT Stage 7 descriptors via the chase seam's `isChaseSuppressed`), pinned by the integration suite; (2) `db/backfill-chase-suppression.ts` repairs pre-fix rows (per-practice `scopedDb`, false→true only, idempotent — **run on staging after deploy**); (3) `prisma/seed.ts` writes the same rule; (4) `computeChaseSendPayload` refuses matched/SUGGESTED/suppressed lines (detection's own predicate, enforced where the server decides); (5) `LiveChaseComposerCard` defaults UNTICKED with an honest error state when the bank slice failed instead of "nothing to chase". The pre-fix drift: only chase *detection* re-scanned descriptors at read time while every count read the always-false column — the exact two-doors disagreement `banking-matching/CLAUDE.md` warns about.

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

**✅ RESOLVED (6 Sep 2026, this branch — all four halves, with Shakib's two in-session rulings).**

1. **Reactivity was already structurally fixed by #255** — the draft derives from the CURRENT
   checked set (`selected`, the opt-in `included` set), so unticking recomposes it immediately.
   What was missing was the pin: `LiveChaseComposerCard.test.tsx` now ticks two lines, unticks
   one, and asserts the draft stops naming it.
2. **The copy summarises, server AND preview (Shakib's ruling, 6 Sep):** above three items
   `composeChaseSms` (the message that actually emails, shown verbatim at Read review) writes
   *"we're missing receipts for 12 payments between 3 Aug and 28 Aug, including X and Y"* —
   count, period, two named examples, still no amounts (the 4 Sep §8.2 rule). Three or fewer
   keep the named-list shape. `composeChaseBody` (the client draft) mirrors it and the card
   now labels the draft *"a preview of the message the engine composes at review — never a
   promise of exact words"*. A side effect worth recording: a thirty-descriptor recitation
   could exceed the contract's 500-char body cap and refuse the STORED payload at review as
   NT-PRP-006; the summary makes the template fit by construction, and the compose seam now
   refuses an over-cap body at CREATE with words a human can act on.
3. **Editable message — BUILT (Shakib's ruling: build now, not defer).** The seam:
   `ChaseSendPayload.messages[].accountantMessage` (optional, ≤240 chars — contract change,
   in-session approval). The engine still owns the greeting and the signed portal link
   (`composeCustomChaseBody` in `chase/sms-copy.ts`); the accountant's words replace only the
   middle sentence, are trimmed once at compose so payload = review = sent bytes, and Read
   review renders the woven body verbatim plus a *"Wording: written by the proposer"* line so
   the releasing super admin knows these are human words, not the template. "Never free-typed
   by a caller" still holds for the parts that carry authority. Works for both message kinds
   (transaction chase and statement request). The card's textarea sends it.
4. **The prefilled mobile is gone.** The namesake lookup was surfacing the SEEDED primary
   contact's fictional `+447700900001` (served live via `BusinessSummary.primaryContactMobile`
   since the 5 Sep widening) as if someone had chosen it. The field now starts empty — blank
   means the engine resolves the REGISTERED primary contact at compose, which was already the
   honest path — and stays as an override only. Pinned by test.

## Item 32 — Match suggestion calls a name-only hit "Probable" when amount and date are wildly different

**Original (verbatim):**
> the is so stupid in the portal that the matching is not understanding that the date and amount id so different, but only the name is same then how this could be the same doc for the transactoin?

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the "Needs you" candidate dialog: transaction **FASTER PAYMENT TO ALDGATE MEATS LTD · 26 Aug 2025 · £674.46**, candidate **Aldgate Meats Ltd · £994.00 · 30 Jul 2025** tagged "Probable 48%", note "Merchant name normalises to the same supplier, but the amounts differ."

**Brief:**
Two problems in one dialog:
1. **Scoring:** the suggestion engine (`apps/web/src/lib/matching.ts` — explicitly display-tier, float-pounds, "flagged for a post-demo rewrite in pence") treats supplier-name equality as enough for "Probable" even when the amount is £320 off and the date a month apart. Amount/date disagreement should crush the score; a name-only coincidence for a repeat supplier (a butcher a restaurant pays weekly!) is the *expected* case, not a probable match. The rewrite this module already owes is now user-visible.
2. **Already-claimed document offered again:** this same £994.00 / 30 Jul 2025 Aldgate document is already matched and published against the 06 Aug £994.00 transaction (item 30's image shows it). The `claimed` set in `lib/matching.ts` exists precisely so one receipt cannot answer two bank lines — either it isn't consulted on this dialog's candidate list, or live rows' missing `matchedDocId` (the known contract gap: only CONFIRMED rows carry `matchedDocumentId`) leaves the claimed set empty in live mode. Same data-plumbing family as items 25/30.

**✅ RESOLVED (5 Sep 2026, PR #255).**

**What was done:** for a supplier you pay every week, the name matching means nothing — every payment to Aldgate matches "Aldgate" — so for payments, a name alone is no longer enough. The amounts now have to be close (within 10%) or the document isn't offered at all: the exact £674.46-vs-£994.00 shape from the screenshot now produces **no suggestion** instead of "Probable 48%". Refunds are the deliberate exception — a partial refund genuinely won't match the invoice amount, so those still get shown as a question for a human. And a document that's already matched to one transaction can never be offered again for a different one: the £994 Aldgate invoice is claimed by its confirmed match, and the dialog now knows it.

**Where it landed:** both halves in `lib/matching.ts`, without starting the pence rewrite and with no contract change. (1) The probable tier splits by sign: a DEBIT requires amount agreement (`PROBABLE_AMOUNT_TOLERANCE = 10%`, confidence scaled by the gap); a CREDIT keeps the name-only question (the seeded £212.40 Bidfood refund pin stands). (2) `matchCandidates`/`assessTransaction` take an optional `claimedDocIds` set; BankView builds it from `matchedDocId`, which live rides exactly the CONFIRMED rows — the contract's design, worked with, not around. `autoMatches` feeds its evolving claimed set in too, so a claimed winner lets the genuine runner-up through. Pinned in `matching.test.ts` with the review's exact Aldgate shape verbatim.

## Item 33 — "Chase for it" button in the candidate dialog does nothing

**Original (verbatim):**
> This chase button is not working

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the same candidate dialog (11 Aug 2025 · £556.20 · same Aldgate candidate), red arrow on the **"Chase for it"** button; clicking it has no effect.

**Brief:**
The per-transaction candidate dialog (BankView's "Needs you" verdict modal) offers "Chase for it" alongside "Cash code instead" / "This is the one", and the chase button is inert in the live build. Per the S14 sweep the synthetic chase composer paths are gated off live — so this button most likely either lost its handler in the gating, or points at a local writer that live mode suppresses without the disabled-with-tooltip treatment the sweep gave everything else. Expected behaviour live: stage the real engine chase for this one transaction (the same `chase.send` seam item 15 wired for the Bank-tab bulk selection). Find the handler in `BankView.tsx`'s verdict dialog and either wire it to `requestChase`/proposal staging or disable it honestly with the reason until it can act.

**✅ RESOLVED (5 Sep 2026, PR #255).**

**What was done:** the button was opening an old demo screen with no real data behind it, so clicking looked dead. It now stages a real chase for that one transaction: click it and the screen says *"Chase queued for 1 transaction — the message is composed at review and sends when it is approved in Approvals"*, and the actual request — with the real message and a working secure upload link — is sitting in the Approvals queue waiting for release. Screenshot: `docs/reviews/assets/2026-09-05-matching-lane/15-chase-queued-banner.png`.

**Where it landed:** `MatchPicker`'s `onChase` calls `stageLiveChase([txn])` when live — item 15's server-composed `chase.send` seam, narrowed to the one transaction — with the queued/failed banner above the table reporting the outcome; synthetic keeps the local composer. Proven end to end: the `chase.send` proposal row exists server-side with the composed body and a signed portal link.

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

**✅ RESOLVED (5 Sep 2026, PR #255).**

**What was done:** the panel only spoke when there *was* a match — no match, still loading, and a broken read all looked identical: blank. It now always answers one of four things: here's the matched transaction · *"No bank match found yet — no imported transaction lines up with this document"* · "checking…" · or "couldn't read it" with a Try-again button. For the Barchester document specifically the honest answer was "no match yet" — checked against the staging database first, it genuinely has no match (the amounts differ by £9.83 and the dates are a year apart, so the matcher rightly suggested nothing) — and the screen now says so instead of staying silent. Screenshots: `docs/reviews/assets/2026-09-05-matching-lane/40-docpreview-no-match.png` and `41-docpreview-confirmed-match.png` (both states).

**Where it landed:** `DocumentPreview`'s bank-match section renders unconditionally when live, with the four states above; the fail-closed parse path now fails VISIBLY (`role="alert"` + retry) instead of rendering as nothing. Pinned in `DocumentPreview.test.tsx` — the old "renders nothing" test was pinning the defect and was replaced with three state tests.

## Item 35 — Bank → Matched shows nothing despite confirmed matches; matched rows need document preview + transaction details

**Original (verbatim):**
> Here in the bank->matched tab all the document matched with the transaction must be shown with document preview option with the transaction details as like the all tab under the bank tab, not showing

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — Zeplow Inc. → Bank: header "0 UNEXPLAINED · £0.00 WITHOUT EVIDENCE", Matches sub-tab count **0**, Transactions with the **Matched** filter selected showing *"No transactions — upload a bank statement to bring them in"* — while at least one confirmed+published match exists (the Aldgate £994) and "Needs you (7)" is non-zero.

**Brief:**
Two layers again:
1. **Bug — the Matched lens is empty when matches exist.** The lens keys on `isMatched` (`matchState === 'CONFIRMED'` on live rows), so either the confirm-match ritual never wrote `CONFIRMED` server-side, or the slice's mapping/refetch loses it. Same root as items 25/30/32/34 — one investigation. (Also note the header claims "0 unexplained" while "Needs you (7)" — if 7 need attention and 0 are unexplained *and* Matched is empty, at least one of the three numbers is lying; capture all three predicates' inputs when diagnosing.) The **Matches** sub-tab live is deliberately a pointer per the S14 sweep — that decision may need revisiting now that matches are real live.
2. **Feature — richer matched rows:** each matched transaction should show its document (preview affordance, the `DocumentViewer`/`DocumentPreview` seam exists) beside the transaction details, same layout richness as the All tab. Today `matchedDocumentId` only crosses the contract for CONFIRMED rows, so the join is possible live — render the document name, open-preview button, and the match provenance (AI vs hand).

**✅ RESOLVED (5 Sep 2026, PR #255).**

**What was done:** three numbers on one screen were each lying in a different way, and all three are fixed. The **header** ("0 unexplained · £0.00") was being recalculated from whatever filter was selected — clicking the Matched filter made it zero *by definition*; it now always states the client's true position, whatever tab or filter is active. The **Matches count** was reading an old demo list that is always empty in the real app; it now counts the real confirmed matches, and the Matches tab shows each one as a card — the document, the transaction, and an "Open document" button to see the receipt. And **matched rows** in the transaction list now show *which* document they matched, with a preview button, instead of just a green tag. Screenshots: `docs/reviews/assets/2026-09-05-matching-lane/10-bank-transactions.png`, `11-bank-matched-lens.png`, `12-bank-matches-tab.png` — the Matched lens listing the confirmed row with its document, Matches counting 1, the header truthful on every lens. Also worth knowing: the confirmed match itself **was stored correctly on the server the whole time** (checked in the staging database directly); the screens were the problem, not the matching.

**Where it landed (all in `BankView.tsx`):** (1) the headline is computed over the client scope only (`clientScopedTxns`), lens-independent, and `needsYouCount` shares the base — header, Needs-you and lens counts are mutually consistent (unexplained ⊆ unmatched by predicate construction); (2) the Matches sub-tab count and cards derive from `transactions.filter(isMatched)` joined to the hydrated documents slice by `matchedDocumentId` — one derivation, so the count and the list cannot disagree (this replaced the S14 pointer card, honest when no live match could exist, a lie once real ones did); (3) matched rows carry the document name + preview in the evidence and actions columns. ⚠ Match provenance (AI vs hand) does NOT cross the contract (`matchState` + `matchedDocumentId` only), so the live card says "Confirmed" rather than guessing who decided — carrying `matchedBy` on `BankTransaction` is the recorded contract follow-up. The lens-empty half of the original screenshot is explained by timing (the confirm landed 20:40 on 4 Sep; a slice hydrated before it would predate the refetch) — everything else in the screenshot was real and is fixed above.

## Item 36 — A document with mostly-empty, 20%-confidence fields reached Ready after only a category was set

**Original (verbatim):**
> Another document with most of the fields with no data is showing and moved to the ready tab after only providing the category; wtf is this

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — a handwritten BC Window Cleaning receipt (£35, "Paid with thanks"): Supplier 90%, Total 99%, Document date 99% — but Customer/Invoice number/Tax/Currency/VAT/Type all at **20% confidence**, three of them showing "—" (no value), Type guessed RECEIPT at 20%, and **Category "Hotel" at 100%** (a manual correction — for window cleaning). Processing log: `code escalated → TO_REVIEW → coding updated → state READY`.

**Brief:**
Readiness (`resolveProcessedState` / `BASE_MANDATORY`) requires exactly Total + Supplier + Category — so filling Category alone flipped this document to Ready, with six fields at 20% confidence or absent, and a category that is plainly wrong for the goods. Mubashir's objection is the *gate*, not just this doc:
1. **Product decision needed on what Ready requires.** Options: widen the mandatory set (document date is already strong here; Type matters for the export's row kind); or gate Ready on **confidence** as well as presence — a document whose retained fields sit at 20% goes to Ready only after those fields are human-viewed (a "reviewed the low-confidence fields" interaction, not necessarily corrections). Whatever the rule, it's server-side (the readiness edge), and the Path-to-Ready panel must state it.
2. **Interlocks:** item 22's sanity layer should also catch category-vs-content dissonance ("Hotel" for a window-clean line item is exactly what a model second-opinion would flag); item 19's always-suggest work will reduce how often a human types a category unaided. A receipt legitimately has no invoice number/VAT — the answer is not "require everything", it's "require what this document type should have, at a confidence a human has seen".

**✅ PARTLY RESOLVED (5 Sep 2026, PR #256) — the TYPE gate landed; the confidence question is a WRITTEN OPTION for Shakib.**

**What was done:** filling in Category alone can no longer flip a junk document to Ready. A document the pipeline read as OTHER — not an invoice, not a receipt — cannot reach Ready no matter what is typed into its fields, until a human corrects its Type to a financial type. The Path-to-Ready panel says so as its FIRST line ("This document cannot be Ready until its Type is corrected to a financial type") with a Correct-the-Type button right there, and once the Type is corrected the document moves on normally. Proven live: an OTHER-typed upload with supplier, total AND category all present landed in To Review instead of Ready, and moved to Ready the moment its Type was corrected (screenshots 01, 02). The second half of this item — should Ready also require that a human has LOOKED at the low-confidence fields — is a product decision, written up below for Shakib rather than invented.

- **Landed, in detail:** readiness now requires a confirmed financial type. `evaluateReadiness` (`validation-dedupe/readiness.ts`) lists `type` FIRST in `missing` when `docType` is `OTHER` **or null** — so a document the extractor classified OTHER (or never classified) cannot reach READY whatever its fields say, the publish minimum inherits the same rule (`NT-PUB-001` now names the type), and the web mirrors it (`readinessOf`, `missingMandatory`, and DocumentPreview's Path-to-Ready panel says "confirm what this document is" as its FIRST line with a Correct-the-Type button). STATEMENT is deliberately not gated under 'type' (it can never reach READY on its fields, and 'type' would mislabel the reason). Extraction's pipeline passes `docType` into the readiness call, so the gate holds from first read.
- **⚠ OPEN DECISION for Shakib — the confidence half.** Should Ready additionally require that retained low-confidence fields were human-viewed? The options, honestly costed: (a) **do nothing more** — the type gate plus item 22's warnings already stop the observed abuse shapes; (b) **a "reviewed the low-confidence fields" interaction** — a per-document human-viewed marker for fields under a threshold; needs a place to store the view event (likely a `document_events` row, no schema change) and a UI affordance, and the threshold itself collides with the standing invariant that *confidence thresholds are eval-calibrated and must not be invented* (`readiness.ts`'s marked seam — there is no calibrated number yet); (c) **widen the mandatory set** (document date, type-specific field sets) — heavier, and "require everything" is the wrong answer for receipts. **Recommendation: (a) now, (b) when eval calibration lands a real threshold.** Not implemented — no ruling exists.

## Item 37 — Verify the VT import file format: no column headers — will VT actually understand it?

**Original (verbatim):**
> Check if really this is the actual format to import to vt software, cause without any column name how there could be vt will understand where to put, what is it, if it is ok, then ok, just recheck again

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the produced import file (`2025-08-26-purchase-invoices`), one headerless row: `BC Window Cleaning | W9T15E9J · https://neoacc.neovogent.com/d/W9T15E9J · Imported from Neo Accounting | 35.00 | 0.00 | 35.00 | 35.00 | Hotel`.

**Brief:**
A verification task, his own framing ("if it is ok, then ok, just recheck"). The exporter (`apps/api/src/modules/exports-public-api`, VT Transaction+ Universal Input Sheet target) emits positional columns with no header row. To do: **check against VT Transaction+'s actual Universal Input Sheet documentation** — the Universal Input Sheet is a paste-into-workbook mechanism where columns are position-defined by the sheet itself (in which case headerless rows are correct *and* the screen/docs should say "paste into the Universal Input Sheet", teaching the accountant the workflow), vs. a CSV auto-import that expects headers (in which case the emitter is wrong). Also confirm column order matches VT's expected layout (supplier, narrative/reference, gross/VAT/net order, analysis account) and that the D43 source link riding in the narrative column survives VT's cell limits. Deliverable: a documented verdict with a citation to VT's format spec, plus — either way — a line of on-screen help on ExportView telling the accountant exactly how to use the file in VT ("open VT → Universal Input Sheet → paste"), because the question itself proves the product doesn't currently teach the import step.

**✅ VERIFIED, EMITTER CORRECT AND UNCHANGED (5 Sep 2026, PR #257 — package C).**

**What was done:** the format was verified against VT's published documentation (citations below and in the module CLAUDE.md), the screen's stale pre-A10 import instructions were rewritten to the verified route, and the success panel gained an on-screen "Importing into VT" how-to. Two layers of evidence now:
1. **A10 (27 Aug 2026) had already verified against a REAL VT installation** — and rewrote the target in the process: the Universal Input Sheet has no usable import for our shape; the real route is **`Transaction ▸ Journal ▸ Import…`**, data format "Payments list/purchase invoices list" / "Receipts list…", which is **positional and headerless by design** (a header row would import as a transaction). One file per (date, direction) in a ZIP, because VT applies one user-typed date to a whole file. Raw evidence: `Desktop/A10-vt-roundtrip/VERDICT.md`, SoT §24.3.1.
2. **VT's published documentation now confirms it, with citations** (module CLAUDE.md carries the full table): [Importing a journal](https://www.vtsoftware.co.uk/transplushelp/importing-a-journal.html) documents the route, CSV, positional column layouts and *"In Date, enter the date; all lines of the journal will have this date"*; [VT's own dialog screenshot](https://www.vtsoftware.co.uk/transplushelp/images/hmfile_hash_21a76634.png) names both data formats; [Method 1: Importing](https://www.vtsoftware.co.uk/transplushelp/importing.html) shows the UIS import **cannot take split-analysis transactions**, which our exports use — so abandoning the UIS was right twice over. No published cell-length limit contradicts the 104-char Column B observation. The exact A–G order is documented in-app only ("More info about this format"), so the real-VT test remains primary evidence for the order; nothing published contradicts it. So: **headerless is correct — VT's list formats are column-order-defined, and row 1 is data.**

**And the screen now teaches the step (the reviewer's question proved it didn't):** `ExportView`'s success panel carries an "Importing into VT" block — the journal route, the type-the-date-from-the-filename rule, the one-off supplier mapping — mirroring the ZIP's own `HOW-TO-IMPORT.txt`. In the same pass the screen's STALE pre-A10 copy was fixed: it still said "(Universal Input Sheet)" on the format dropdown and taught `Transactions → Universal Input Sheet → Import from CSV File`, a dialog A10 proved cannot import. The D42 copy test now pins the journal-route phrasing present and "Universal Input Sheet" absent.

## Item 38 — Invite dialog: clicking a client pill mid-form sends the invitation immediately

**Original (verbatim):**
> If I type the email first and click the client the email, the model gets disappeared and the mail get sent auto, after typing email then selecting role, then selecting client then clicking the invitation sent button, the invitation will sent to the email only then

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the "Invite a colleague" dialog (Team screen): work email filled, Role pills (Standard user / Client admin), client pills (Zeplow Inc.), Cancel / **Send invitation**.

**Brief:**
Order-dependent misfire: type the email, then click a client pill → the dialog closes and the invitation **sends by itself**. Only the full sequence email → role → client → explicit "Send invitation" should send. This is almost certainly the classic implicit-form-submit: the role/client pills are `<button>`s inside a `<form>` without `type="button"`, so clicking one submits the form (the first submit-capable button wins). Fix in the Team invite dialog (`TeamView`'s invite form over `api/team.ts`): `type="button"` on every non-submit button (and audit **every** form-hosted dialog in the app for the same — the intake form's pill steps, chase composer checkboxes-as-buttons, onboarding steps), plus, belt-and-braces, the send handler should refuse when role/client haven't been explicitly confirmed. An invitation email is an outward-facing side effect — firing it on a mis-click is exactly what the explicit button exists to prevent.

**✅ RESOLVED (6 Sep 2026, the access-control package — branch
`fix/access-control-38-39-41-42-44-57`).**

The diagnosis in the brief was exactly right. `Chip` — the role and client pills
— is declared two hundred lines from the `<form>` it renders inside, and a
`<button>` inside a form defaults to `type="submit"`, so clicking one ran
`onSubmit`: the dialog closed and the invitation email left, mid-form, in the
order a person naturally works. `type="button"` on `Chip`, on `IconBtn` beside
it, and on the shared `FormControls.Toggle` — the last because that module is
the app's one shared form-control home, where a stray submit would be inherited
by every dialog at once.

**The audit was done mechanically, and the result is worth keeping.**
`grep -rl '<form' apps/web/src` returns exactly FIVE files, and this dialog was
the only defect among them; `LiveBusinessPortal`, `InviteView`, `LoginView` and
`SignupView` all type every button already. The three surfaces the brief named
by guess — `ClientIntakeForm`, the chase composer, `BusinessOnboardingView` —
**host no `<form>` at all**, so they have no implicit submit and no Enter-key
path either. Recorded in `TeamView.test.tsx` so nobody re-runs the search.

`TeamView.test.tsx` pins the BEHAVIOUR rather than the attribute (a
`type="button"` assertion would pass forever and catch nothing — the next pill
is a fresh button with the same default): the wire stays silent until Send
invitation is pressed, including a loop that clicks every non-footer button the
dialog offers. Verified red with the one attribute removed, and walked live —
screenshot `38-01` in the evidence folder shows the dialog still open, and the
invitation unsent, after the pill click.

**The belt-and-braces half the brief also proposed — the send handler refusing
until role and client are "explicitly confirmed" — was deliberately NOT built.**
`role` has a legitimate default and an empty client list legitimately means
every client, so there is no unconfirmed state to refuse; it would be a new flag
guarding a door that is now shut.

## Item 39 — Role capability matrix: standard users see actions they're forbidden to finish

**Original (verbatim):**
> There should be standard guard for what will be shown to the standard team member and what will not be; the standard user is being able to see the add client option after filling all the information it is telling you can't add; define all the rules for each type of user and what they can do and see; and according to that fix the code

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — the Add-client intake, step 3 of 3 (Review), fully filled in by a standard user, refusing at the very end: **"NT-PRM-001 — Only a member of an accounting practice can add a client."** with the Create button still rendered below.

**Brief:**
Two distinct wrongs:
1. **The refusal arrives after the work.** A standard user walks all three intake steps and is refused at Create. The repo's own posture (Governance §11.2, the D44 "degrade honestly, never hide" pattern) permits showing the action — but honestly means the *first* screen says "adding clients needs {role}; you can compose but not create" (or the entry button is disabled-with-reason), never a 3-step form that dead-ends. Also suspicious: NT-PRM-001's message here ("only a member of an accounting practice") suggests the refusal may actually be the **wrong check** for this user (they *are* a practice member — was the session's practice scope missing?) — verify the server-side predicate before assuming role-gating; this may be a bug wearing a permissions message.
2. **The matrix doesn't exist as a document.** His ask: define, per role (practice super admin/owner, practice standard, client admin, client standard, portal roles), what each **sees** and what each **can do**, then align every surface to it. Today authority lives in scattered `PermittedAction`s (`approvals/assert-can.ts`, four actions) plus per-surface gating. Deliverable: a capability matrix doc (SoT-adjacent — Shakib should ratify it), then a sweep making every gated surface follow one of two sanctioned shapes: hidden (not this role's job at all) or visible-but-disabled-with-reason *before* any work is invested.

**✅ RESOLVED (6 Sep 2026, the access-control package).**

**Both halves, and the first one was a misdiagnosis waiting to happen.** The
brief's suspicion was right: `NT-PRM-001` was the WRONG SENTENCE, not the wrong
check. `ClientIntakeService.createClient` refuses on
`ctx.practiceId === undefined`, and a `PRACTICE_STANDARD` invited **with a
client list** gets one membership per assigned client carrying `practice_id`
**NULL** — deliberately, because that null is the whole mechanism that makes
RLS confine them (`app_can_access_business`'s third branch would otherwise hand
them every client of any practice they carry a `practice_id` on).
`loadScopeForUser` therefore has no practice to put in the context, `GET /me`
answers `practice: null`, and every predicate of that form refuses them **while
their role still reads `PRACTICE_STANDARD`**. The screenshot's user is item 57's
*"Mubashir Khan · Standard user · 1 client"*. Confirmed live: `/me` for the
walked colleague answers `{"practice":null,"role":"PRACTICE_STANDARD"}`.

**The matrix exists**, at `docs/Access_and_Approval_Matrix.md` — the
visibility/action half, filled from what the code enforces today, with every
changing cell marked, and package G adds the approval-tier half (item 66) to the
same file. Two sanctioned degraded shapes and no third; the rule of thumb it
applies is **hide when the role has no legitimate interest in the fact,
disable-with-reason when they do**.

**Shakib's ruling (gate ⚖1, 6 Sep 2026): the predicate stands, the surfaces are
HIDDEN, the message is replaced.** Writing a `practiceId` onto scoped
memberships so they *could* add clients was put to him and refused — it would
defeat the client list entirely.

- **Server, both refusals** (they wore the same lie): intake now says *"Your
  sign-in reaches only the clients it was given, so it cannot add new ones. A
  practice admin at your accounting firm can."*, and `requirePractice` in
  `practice-team.service.ts` the same shape for the team list. Both are true of
  the other caller that arrives with no practice scope — a client-workspace
  user, whose accountant *is* the practice.
- **Web**: `actsForWholePractice(session)` reads `me.practice !== null`, never
  the role — a role test would be wrong in BOTH directions, hiding the surface
  from a practice-wide standard user who may use it and showing it to the scoped
  colleague who may not. `AppContext.availableTabs` is the ONE list the rail,
  the phone nav and the address→tab resolution all read, so a hidden tab cannot
  survive as a working deep link. `ClientsView` hides Add Client and refuses
  `?add=1`; `ClientIntakeForm` refuses before the mode chooser, and that guard
  is in the shared component because it has two doors (the board's button and
  the chat's `ADD_CLIENT` intent).

Every non-authenticated session answers `true`, so synthetic mode is
byte-for-byte unchanged (METH_MODE §1).

**Walked live end to end** — invite a scoped colleague, accept the emailed
invitation, sign in as them: the Team tab is absent from the nav
(`39-01`), `/team` renders the AI Workspace rather than a dead end (`39-02`),
`?add=1` opens nothing (`39-03`), the chat door refuses before step 1
(`39-04`), and on the wire `POST /v1/businesses` → `403` with the new sentence
while `GET /v1/practice-members` → `403` with its own. Evidence in `docs/reviews/assets/2026-09-06-access-control/`.

## Item 40 — merged into Items 23 + 40 above

Same defect as item 23 at population scale; the combined entry (original words and image for both items preserved) is at **Items 23 + 40** earlier in this file. **✅ RESOLVED with it (5 Sep 2026)** — the population audit is that entry's resolution.

## Item 41 — Portal People: the access dropdown says "Member", which defines nothing

**Original (verbatim):**
> Here "member" does not define what the job is, write specific word or words to define the access

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep) — Business portal → Settings → People → Add someone: Job title free-text ("Staff"), then **"What they can do here" dropdown showing "Member"** (red arrow), with the separate "Can send documents"/"Can see totals" checkboxes below.

**Brief:**
In `LivePortalPeople.tsx` the `access` enum renders as bare nouns ("Member", presumably "Owner"/"Admin" siblings) that tell the person adding staff nothing about what the level grants — especially confusing sitting directly above capability checkboxes that *do* describe themselves. Fix is copy, not architecture: label each access level with what it does — e.g. "Member — can use the portal, cannot manage people or the plan", "Admin — can manage people and business details", "Owner — full control, including the subscription" — either in the option labels themselves or as a description line under the select that updates with the choice (the pattern the checkboxes already use: "Leave this off for staff who photograph receipts…"). Keep the role words stable (the enum is the contract's); the description is the fix. All catalogue strings, portal-light, no server change.

**✅ RESOLVED (6 Sep 2026, the access-control package).**

Copy, as the brief said, and the enum words did not move — `access` is the
contract's `WorkspaceRole` and the last-owner rule keys on it, so a protection
defeated by retyping a label is not one. What was added is a sentence per level
**under the select, changing with the selection**, in the `Field` note slot every
other explanation on that form already uses; a static line describing three
levels would describe none of them.

Each sentence says what the level grants AND what it withholds, because the
boundary is the whole question somebody adding staff is asking:

- **Owner** — full control: the people on this list, your business's own
  details, and the subscription.
- **User administrator** — can add, change and remove people on this list.
  Cannot see or change the subscription, or your business's details.
- **Member** — day-to-day use only. Cannot change who has access, your
  business's details or the subscription.

All three are checked against what the server actually enforces
(`business.people.manage` = `BUSINESS_ADMIN | USER_ADMIN`,
`business.profile.manage` = `BUSINESS_ADMIN`, and item 44's billing guard
landing in the same package), so the copy is not describing a rule that only
exists on the screen. What a person may SEND and SEE is deliberately not
claimed — those are the two per-person boxes below, and a sentence about the
level would contradict them for anyone whose boxes differ from their level's
default.

Walked live: `41-01` in `docs/reviews/assets/2026-09-06-access-control/` shows the description
following the choice from Member to User administrator.

## Item 42 — Portal People: members can only be deleted, never edited

**Original (verbatim):**
> Give edit option for the owner of the business or the client so that they can edit access of the member of their organization so that if there was any mistake the owner can edit them

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.10.10.jpeg` — Business portal → Settings → People ("Who can send documents"): two rows (Mubashir Khan · Owner · YOU; Neovogent UK LTD · Member · Staff), each with only a **trash icon** — no edit affordance anywhere. The only recovery from a wrong role/name/title is delete-and-re-add.

**Brief:**
`LivePortalPeople.tsx` (over `api/portalPeople.ts`) supports list, add, remove — no update. Mubashir wants the business owner (or whoever holds `canManagePeople`) to **edit an existing member**: access level, job title, name — so a mistake at add time is correctable in place. Two halves:
1. **Contract/server (likely G7):** check whether the portal people surface has an update operation; if the four contracted operations are list/create/remove(+one other), a `PATCH`/`PUT` member endpoint needs adding — with the same guards the remove path already has (last-owner protection: you cannot demote the last owner, same as you cannot remove them; server refuses regardless of UI).
2. **Web:** an edit affordance per row (pencil beside the trash) opening the same form as "Add someone" pre-filled — role, job title, name; the email is the sign-in identity, so decide whether it's editable (probably not in place: one address is one person — changing it is a new member, and the form should say so). Honest degradation for non-managers, same as the rest of the panel. Pairs naturally with item 41 (the access labels being edited need to describe themselves).

**✅ RESOLVED (6 Sep 2026, the access-control package) — and it was ONE BUTTON,
because the brief's feared contract gap does not exist.**

Investigated before anything was written. `PATCH /portal/people/{personId}` is
contracted (with `email` deliberately absent and the last-owner demote refused
as `NT-VAL-001`), implemented in `portal-people.service.ts` behind
`assertCan(actor, 'business.people.manage')`, exported from
`api/portalPeople.ts` as `updatePerson` — and `PortalPersonEditor` in
`LivePortalPeople.tsx` already rendered the whole edit case: its own title
*"Change what they can do"*, the email read-only with the reason printed under
it, and the last-owner demote gate in `gateFor`. **The list simply never called
`setEditing(person)`; only `setEditing('new')`.** So no contract delta, no new
authority, and nothing for Shakib to rule — recorded as gate ⚖4 in the matrix.

The pencil sits BEFORE the trash so the recoverable act is nearest the reader,
and it carries no disabled-with-reason guard of its own: there is no person on
the list who cannot be EDITED. The last owner may be renamed and retitled —
only DEMOTING them is refused, which is `gateFor`'s job inside the form, where
the offending value is. `canManagePeople` still gates both affordances together,
unchanged: a pencil that opens a form whose save is a guaranteed 403 is the
failure this package exists to remove, one surface over.

`LivePortalPeopleRow.test.tsx` pins the button, that it opens the editor
PRE-FILLED with the row that was pressed (an edit form opening blank would
silently blank the fields it was opened to fix), the locked email with its
reason, and that a plain member gets neither affordance. Walked live — `42-01`
and `42-02` in `docs/reviews/assets/2026-09-06-access-control/`.

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

**✅ RESOLVED (5 Sep 2026, PR #260 — the channel-provenance package).**

**What was done:** a capture is never "Unknown" again. The member identity was already there — `PortalSessionFacts.contactId`, written by both sign-in routes — so no claims widening was needed (the G7-adjacent gap the brief feared does not exist). At intent time the server recognises the app's own capture mint (`capture-YYYY-MM-DD-N.jpg`) and composes the display filename ITSELF from facts it holds — session member, business row, Europe/London date: **`Capture — Owner American Burger · American Burger Ltd · 5 Sep 2026.jpg`** on the real walkthrough row (screenshot `03`), with the tray sequence kept when > 1 and a client-typed note (item 11's seam) still winning. The provenance line reads the member now: the row's label and the processing-log event say **"Captured by {member} ({business})"** instead of `uploaded-by-delegated-session` (screenshot `04` — title, VIA CLIENT PORTAL header and log line all on one card); the chase journey's event keeps the SoT §8.3 string, its holder being unnamed by design. Fallback display generally: any row with no extracted supplier is titled by its filename (`displayTitle` — display only; `supplier: 'Unknown'` stays the data sentinel readiness and publish-eligibility compare against, so nothing became publishable by being renamed). Composer pinned in `portal-provenance.test.ts` (mint recognition, London date on the BST boundary, name clamping) and `portal-upload.service.test.ts`; walked live with a real fake-camera capture.

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

**✅ RESOLVED (6 Sep 2026, the access-control package). ⚠ It was a LIVE SECURITY
HOLE, not a cosmetic one — the brief's hypothesis 1 was correct.**

`billing.controller.ts`'s `principalFor`, shared by
`POST /v1/billing/checkout-sessions` and `POST /v1/billing/portal-sessions`,
checked that the portal session's business equalled the body's `businessId`
**and nothing else**. That is the right answer to *whose subscription is this*
and no answer at all to *may this person touch it*, so any contact of the
business holding a portal bearer — a `BUSINESS_STANDARD` added to photograph
receipts included — could mint a Stripe customer-portal session and reach the
card, every invoice and **cancellation**. The button was live, not decorative.

- **Server (the real fix).** `business.billing.manage` is the fifth
  `PermittedAction`, `BUSINESS_ADMIN` only, binding BOTH doors — starting a
  subscription and cancelling one are the same authority seen from two ends. It
  is ordered AFTER the business match, so a caller naming somebody else's
  business still gets the 404 that confirms nothing. ⚠ A `USER_ADMIN` is
  refused: that role holds people management and *"nothing else"*, and an office
  manager who can add a new starter is not thereby somebody who may cancel the
  company's subscription. `PortalSessionContextResolver.resolveActor` reads the
  role FROM THE ROW every time, bounded by `facts.businessId`.
- **A fifth action rather than reusing `business.profile.manage`** (which
  selects the same person today) — Shakib's ruling at gate ⚖2: the refusal
  message is the whole user-facing product of a permission check, and *"Only an
  owner at your business can change its own details"* said to somebody who
  pressed a billing button is a wrong answer in a right status code.
- **Web — the HIDDEN branch, as the brief expected.**
  `PortalSummary.canManageBilling` (contract addition, ruled at ⚖2) mirrors
  `PortalPeople.canManagePeople`: a fact for honest degradation, never a gate.
  `hiddenSectionsFor` in `portalTabs.ts` removes Plan from a member's list, which
  makes `/portal/settings/plan` **unrecognised for them** — so the existing
  "an unrecognised section is the first section" rule catches the deep link with
  no new branch, no 403 page and no dead end on a phone, exactly as the brief
  predicted. The web parse defaults it CLOSED.

`LivePortalSettings` also now renders its panel from the VISIBLE list rather
than the `section` prop it was handed, so no future caller can paint £8.50 by
passing a string.

**Walked live, both sides of one business.** Owner: Plan in the list, price on
screen, `canManageBilling: true`, and the billing POST reaches Stripe's own
`NT-BIL-001` (no subscription on the seeded row). Member: **no Plan section**
(`44-02`), `/portal/settings/plan` renders Business (`44-03`), no price, and
`POST /v1/billing/portal-sessions` → **`403 NT-PRM-001` — "Only an owner at
your business can manage the subscription. Ask them."** Evidence in `docs/reviews/assets/2026-09-06-access-control/`.

## Item 45 — "Manage billing in Stripe" fails: diagnose the portal-session error

**✅ DIAGNOSED — DASHBOARD STEP OWED (5 Sep 2026, PR #259).** Root cause is Stripe refusing `billing_portal/sessions` in live mode: either the live-mode customer-portal configuration was never saved, or the hand-minted `rk_live_` restricted key lacks the separately-granted Customer Portal permission (hypotheses 3/4 ruled out statically). `docs/runbooks/stripe-billing.md` §9 carries the one CloudWatch query that says which, and the exact dashboard fix for each — **the click is the owner's to make; this item closes when it's made and the button works on staging.** Code side landed in #259: the Stripe client distinguishes refusal from outage in the problem detail, and both Plan panels render the server's words with the `NT-` code in front (`NT-BIL-003` written up as a contract delta, not minted).

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

**🔶 DIAGNOSED — one dashboard step owed (5 Sep 2026, branch `fix/review-items-17-45-64`).**

**Root cause, from the code and the module's recorded facts** (the AWS session on this machine had expired, so the log line itself is the owner's one remaining read): hypotheses 3 and 4 are RULED OUT statically — staging allowlists both web origins in `BILLING_RETURN_ORIGINS` (`infra/envs/staging/services.tf:317`) and the portal sends its own session's `businessId`; the panel showing **Active** also rules out `NT-BIL-001` (the webhook resolved that business BY its Stripe customer id, so the binding exists). What remains is Stripe refusing `billing_portal/sessions` **in live mode** — hypothesis 1 (no live-mode customer-portal configuration saved; the config §7 verified on 28 Aug was the SANDBOX's, and Stripe portal configs are per-mode) or hypothesis 2 (the hand-minted `rk_live_` key lacking the separately-granted **Customer Portal** permission). Both are 4xx refusals that `http-stripe-client.ts#refuse` collapsed into one "temporarily unavailable" NT-SRV-001 — which the panels then swallowed for the generic sentence in the screenshot.

**The owner's step:** run the one CloudWatch query in `docs/runbooks/stripe-billing.md` §9 (`aws logs filter-log-events --log-group-name /nt/staging/api --filter-pattern '"Stripe billing_portal/sessions failed"'`) and apply the matching dashboard fix — save the live-mode Customer portal config (Settings → Billing → Customer portal → Save), and/or grant the restricted key **Customer Portal: Write** (the picker does NOT call it "Billing Portal Sessions"). Both are clicks in the Stripe dashboard; nothing in the repo can make them.

**Code shipped regardless of which it is:** `refuse()` now tells the truth per failure class — a Stripe 4xx answers *"refused the request — the billing account needs attention from the practice, not a retry"* while 5xx/429/network keep the try-again words (the code stays `NT-SRV-001`; `ErrorCode` is a closed contract enum, so a named `NT-BIL-003` is a written-up G7 delta, not minted). `LivePortalSettings` renders the session's own fault string (already NT-coded by `messageFor`) instead of the generic `m.fault`, and `BusinessSettingsView`'s `PlanPanel` renders `errorLabel(error)`. Fault path pinned in `LiveBusinessPortal.test.tsx` and `http-stripe-client.test.ts`; runbook §5/§7/§9 updated (per-mode config warning, the stale `rk_test_` row corrected, the diagnosis table). Evidence — the line diagnosing itself, forced locally through the never-through-checkout refusal: `assets/2026-09-05-standalone-17-45-64/05` (**NT-BIL-001 — This client business has never been through checkout…**).

## Item 46 — Document-date correction needs the UK date picker (and better UX)

**Original (verbatim):**
> Here the date picker must be as described earlier and with better ux

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.19.09.jpeg` — DocumentPreview of the capture upload (the "gf" document, item 43's selfie): red arrow on the **Document date** field, corrected to **09 Aug 2027** at "100% confident".

**Brief:**
The Document date correction in `DocumentPreview` needs the same date-control treatment as items 16 and 28: a proper UK d/m/y selector with readable long-form display ("9 August 2027" style), never a locale-dependent native input or a bare text field. This makes **three surfaces** now asking for one date control — the statement-request dialog (16), ExportView's FROM/TO (28), and the document-date correction here — so the right move is a single shared UK date-picker component in `DynamicComponents/`, built once, adopted by all three (and any future date field), with the repo's Europe/London + d/m/y invariant baked in rather than re-decided per surface.

**Adjacent flag from the same screenshot (files under item 22's sanity-check umbrella):** the corrected date is **in the future** — 09 Aug 2027, a year ahead of today — and it was accepted silently and now reads "100% confident". A future document date is almost always a typo (or a d/m/y↔m/d/y slip) and materially wrong for accounting (it lands the document in a period that doesn't exist yet, which item 29 shows will strand it at export). The correction boundary should warn on a future date (and on implausibly old ones), with the item-22 "Ignore — I'm sure" escape. Also the same screenshot shows Supplier "gf" at 100% — the human-confirmed-equals-100% display reading as endorsement of junk, already noted in item 22's brief.

**✅ The FLAG half is RESOLVED (5 Sep 2026, PR #256).**

**What was done:** correcting a document's date to the future — like the 09 Aug 2027 in the screenshot — is no longer accepted silently. The dialog now says *"The document date 09 Aug 2027 is in the future. A future date is almost always a typo, and it files this document into an accounting period that does not exist yet"* — with the item-22 **[Ignore — I'm sure] / [Go back and fix]** buttons, and the same for a date more than 7 years in the past (screenshot 09). Ignored warnings are restated on the proposal review, and the "100% confident" display is "Confirmed by you" now (item 22's entry). The date-PICKER half (UK d/m/y control, better UX) stays with package D (items 16/28/46's shared control) — not this package's.

**✅ The PICKER half is RESOLVED too (7 Sep 2026, branch
`fix/review-items-59-18-16`).** The Document date row opens `UkDateField` instead
of a free-text box: `dd/mm/yyyy` typing, a calendar button on the native picker,
and the long-form line underneath — `03/08/2026` reads back as **"3 August
2026"**, never 8 March. `isDateLabel` decides which rows get it, read off
`FIELD_PRESENTATION`'s own `kind` (the same table `parseCodingDraft` branches on)
rather than matching on the label's words, so a third date field cannot quietly
be served a text box. `commit` is untouched — the control emits `YYYY-MM-DD`,
which the date branch already accepted — so **the future-date and 7-years-past
warnings above still fire on exactly the same boundary**. And the control refuses
`31/02/2026` outright rather than rolling it to 3 March, which is the failure
`parseUkDate`'s read-the-components-back rule exists for. Evidence:
`assets/2026-09-07-items-59-18-16/09-item46-document-date-correction.png`.

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

**✅ FULLY RESOLVED — 1, 2 and 3 on 5 Sep 2026 (PR #256); 4's model pass on 6 Sep 2026 (the coding-intelligence package).**

**What was done:** the selfie experiment now fails at every layer it previously sailed through. Typing "jhngbhf" into Category is **refused outright** — a category must be a real code on that client's chart of accounts, checked on the server, never fuzzy-matched, and the refusal says so in plain words on the card (screenshot 08). The selfie **cannot reach Ready** while its Type reads OTHER — item 36's gate. Typing money onto it warns *"This does not appear to be a financial document"* with the Ignore/Go-back choice (screenshot 03). And the "not a financial document" verdict now FOLLOWS the document: a red flag on its row in every list, on its preview header, and restated on the release review — so a super admin releasing it is told the pipeline judged it not to be a financial document and that a person typed its figures afterwards. Still never blocked at upload (the D46 rule stands); just impossible to miss.

**The detail:**
1. **The chart-membership REFUSAL landed, server-side at proposal creation.** `assertUpdateCodingAllowed` (`validation-dedupe/proposals/validate-update-coding.ts`, called from the engine's `create()` for every `document.update-coding`): a typed `categoryCode` must be EXACTLY a code on the client's chart — refused naming the string and the rule, never fuzzy-matched (the drafts.ts rule, applied to the manual boundary at last). The chart arrives through a structural reader seam composed in `approvals.module.ts` from `ChartOfAccountsService.resolve` (the same instance/transaction the entry preview uses); an unreadable chart SKIPS the check rather than deadlocking coding. "jhngbhf" is now a 422 with the reason on the card.
   **⚠ G7 DELTA, WRITTEN NOT MADE — the web has no chart read surface.** The correction dialog should offer the client's chart codes (select/datalist) instead of free text, but no contract operation serves a chart to the browser (`rules-suggestions`' own TODO: "the accountant cannot edit the chart… no contract operation exists"). Proposed delta for Shakib: `GET /v1/businesses/{businessId}/chart-of-accounts` returning the stored `{ code, name }[]` (the exact pairs `ChartOfAccountsService` already serves two server-side consumers), read-only, workspace session. Until then the dialog stays free text and the server refusal is the rule — which is the correct precedence anyway.
2. **Type in readiness** — landed; item 36's entry has the detail.
3. **The D46 flag follows the document.** On its ROW: ClientInbox's doc cell and flag column, DocumentsView's status column and the DocumentPreview header all wear "Not a financial document" (red) when the type is OTHER. On the RELEASE REVIEW: `publish.batch`'s entry preview carries a `not-a-financial-document` warning per document whose MACHINE extraction read OTHER — keyed on the machine's own verdict from extraction history, deliberately not the current column, so a human's later Type correction does not erase what the super admin needs to see ("the pipeline judged this not a financial document; its figures were asserted by a person afterwards"). Rendered in the ⚠ Checks section that now leads the release card. Flag-never-block stands at upload, exactly as ruled.
4. **The deterministic second opinion** landed as item 22's check layer, which also fires here ("this does not appear to be a financial document" on money/category corrections over an OTHER-typed or nothing-extracted document, with Ignore). **The MODEL-backed pass landed 6 Sep 2026** through the same `CorrectionCheck` seam — item 22's entry has it in full.
   ⚠ **On THIS document it deliberately says nothing, and the measurement is the interesting part.** Shown the selfie — every extracted field null, no readable text — the live model answers `NOT_CHECKABLE` rather than "absent", which is the honest verdict: it is reading what the pipeline extracted, and from a picture of a person that is nothing. The brief predicted it would "trip on every field here"; it does not, and it should not. The deterministic layer already flags this exact shape, and a model repeating it would be two warnings for one fact. Where the model earns its keep is the document that reads perfectly with a typed value that names somebody else.

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

**✅ RESOLVED (6 Sep 2026 — the coding-intelligence package, with item 19).**

**⚠ The verification point 2 asked for came back the surprising way: the prior-treatment tier ALREADY read history, and had done since A6.** `loadHistory` walks this client's last 200 documents, keeps only the codings a HUMAN confirmed (a category a rule applied is not evidence — that would make one approved decision look like a growing consensus), matches them on the NORMALISED supplier key so `NISBETS LTD` and `Nisbets Ltd` are one supplier, and `decide()` answers on them.

**What was missing was a CONSUMER.** `extraction/coding-advice.ts` returned `null` for every ladder outcome that was not `REVIEW`, and a remembered treatment answers `CODE`. So a supplier the client had coded by hand produced an empty Category with no sentence beside it — on screen, indistinguishable from a supplier nobody had ever seen. The memory was read, the ladder used it, and the product never said so. `codingSuggestionFor()` is the one mapping now.

**Proven live:** correct the first Aldgate invoice by hand, approve it, upload the next one — and it arrives reading *"Suggested — not applied — as Cost of sales: Food and drink. This client has coded this supplier that way once, by hand, most recently 6 Sep 2026, and never differently."* (`assets/2026-09-06-coding-intelligence/03`).

**The two rules point 3 asked for, both built:**

- **Confidence scaled by consistency**, computed rather than looked up: 0.6 for one hand-coding, +0.08 each, capped at **0.9** — the same ceiling `TRAINING_NEVER_CAPITAL` carries, because nothing may read as more certain than a bright line in a standard. Five-for-five reaches it — demonstrated live as well as in the eval corpus (screenshot `06`); screenshot `03` shows 0.6 because at that point the client had coded them once. Mixed codes offer nothing and fall through to the tiers that read the document — §24.4.6's *a change of treatment is itself worth surfacing*; offering the more frequent code would present a disagreement as a consensus.
- ⚠ **A remembered code the chart no longer carries is not offered**, and the ladder falls THROUGH rather than answering with it. Offering it produces a suggestion the export cannot give a ledger prefix and that the correction boundary (item 47's chart-membership refusal) rejects on the way back in — an affordance whose only outcome is a 422. The review reason names it instead of claiming nothing codes the supplier yet.

**Point 4 — "make it a rule?" — IS built** (6 Sep 2026, second pass). It was the one half deliberately left out of the first pass and then asked for by name.

Code the same supplier by hand three times and the suggestion panel grows a second block: **"Make it a rule?"** with the server's own sentence — *"Code Aldgate Meats Ltd to Cost of sales: Food and drink from now on. This client has coded them that way 5 times, by hand, and never differently."* — and one button that stages an ordinary `rule.create`, the same kind and the same door the chat's rule beat uses.

⚠ **`buildSupplierRuleProposal` already owned every refusal and had simply never been called** since A6, so the new file is small: it adds a threshold (`RULE_OFFER_THRESHOLD = 3` — a rule outlives the document that argued for it, so offering too early is worse than offering one document later) and the shape a surface renders. The offer is absent when a rule already codes the supplier, when the treatment is not the client's own, when the history disagrees with itself, and when there is no exact spelling to key on.

⚠ **The scope key is the supplier's EXACT spelling and travels verbatim** — server → contract → browser → payload. The pipeline matches by exact string equality, so a key anything tidied would produce a rule that is written, reviewed, approved and never fires. Other spellings the rule will not match are named on screen rather than papered over.

**It needed one contract change** (`CodingSuggestion.ruleOffer`, additive and optional — Shakib's instruction on 6 Sep), and no new endpoint: the offer rides the suggestion the document already carries.

**The whole loop, proven live:** five hand-codings → the sixth invoice arrives at **90% confident** on `SUPPLIER_MEMORY` with the offer beside it → Create this rule → Read review → Approve → a real `rules` row, active, stamped with the approval → **the next invoice arrives READY, coded by the rule, carrying no suggestion at all** — the standing invariant *a suggestion never rides beside a rule*, observed rather than asserted. Screenshots `06` and `07`.

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

**✅ RESOLVED (6 Sep 2026, this branch — with Shakib's in-session contract ruling; "attach" is the recorded deferral).**

**What already existed:** the four-action footer, the per-action ConfirmSteps and the inline
DocumentPreview expand were ALL ported with the comparison layout — they were gated off LIVE
behind the informational footer, because resolving had no server half. The real gap was the
server, and the reviewer found it precisely.

**The server half (Shakib's ruling: kind + read surface now, attach deferred):**
- **`document.resolve-duplicate`** is the sixteenth `ProposalKind`. Payload
  `{documentKeepId, documentCopyId, resolution: different-documents | keep-both | delete-copy}`.
  **No prisma change was needed** — the `duplicates` schema anticipated exactly this (verdicts
  `CONFIRMED_DIFFERENT` / `KEEP_BOTH` / `CONFIRMED_DUPLICATE`, `decided_by_user_id`,
  `decided_at`). The executor (`validation-dedupe/proposals/resolve-duplicate.ts`) resolves both
  documents through the approver's RLS, refuses a cross-client "pair", and upserts the verdict —
  the detector's row when one exists (either column order), a fresh row marked
  `signals: {resolvedBy: 'accountant'}, score: 0` when the pair was derived client-side.
  **`delete-copy` moves the copy to TRASH** (`deleted_at`, restoration undoes it — the item-13
  seam, exactly as the brief demanded, never a purge) and writes the same `document_events` Trash
  row the deletion endpoint writes, so the document's own log has no gap. Idempotent by outcome;
  a later ruling supersedes an earlier one. `RELEASE_KINDS: false` (internal, reversible — flagged
  for ratification like every entry). The review card restates the ConfirmStep consequences and
  what is checked at approval.
- **`GET /v1/duplicates`** (the new read, `DuplicatesController`/`Service` — validation-dedupe's
  first controller, the chase-module precedent) serves the recorded pairs + verdicts, RLS-scoped,
  so a ruled-on pair STAYS ruled across reloads and colleagues. `DuplicateVerdict` joined the
  contract's prisma-mirrored enums.

**The web half:** live, the four actions are REAL — each stages the proposal via
`ProposalFlowModal` (lazy, off both chunks until pressed; the review card IS the confirmation, so
no local ConfirmStep in front — the bulk-move lesson). **Attach renders disabled wearing its
reason** ("merging two images into one document is not built yet") — S12, never a button that
does something else. `useDuplicateResolutions` (`api/duplicates.ts`, view-chunks only) subtracts
decided pairs from the derived flags in InboxesView and ClientInbox; an approved resolution
refetches it and closes the comparison. Synthetic keeps the local ConfirmStep flow byte-for-byte,
and the #258 scroll frame is untouched (nothing changed about the modal's box).

**Detail (item 49.3):** package E's member identity landed, so "Sent by" now renders the server's
`submitterLabel` — a person — when one is known, and otherwise the field is labelled honestly
**"File"** with the filename, because "Sent by: king fisser.jpg" was the lie being reported.

**Deferred, named:** "Attach to the original" (one document, two images) — no schema shape for a
second image exists; it needs its own design (a `document_images` child table or a supersedes
link) and is exactly the heavy merge write the brief said to split out. Also open: the pair-side
supplier-normalisation note (49.4) — cosmetic, not done.

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

**✅ A RESOLVED · ⏸ B AWAITING YOUR SIGN-OFF (7 Sep 2026, PR TBD).**

**A — the tab is gone live, and the rule is general.** `ClientDetailView` now
filters its own tab list: **a tab that cannot read anything from the server is
absent live and present synthetic.** One filtered list feeds both the tab strip
and the `fromSlug` address resolution, so live `/clients/{id}/expense-claims` is
an unrecognised slug that falls to Overview rather than a hidden surface you can
still deep-link into — the pattern `AppContext.availableTabs` already
established for item 39's capability matrix.

**The audit you asked for found exactly one such surface.** `api/slices.ts` is
what says so: of the seven slices in `SliceName`, `expenseClaims` is the only
one nothing ever asks the API for, so it reports `'seed'` in every build. Every
other client tab reads a slice that hydrates — the Chases tab picks its live or
seed shape rather than hiding, which is right for a surface that *does* work.
The main nav has no unwired member at all: `SIDEBAR_TABS` is gated by the
capability matrix, not by build mode. The tour's `expense-claims` step needed no
change; `TourProvider` is already synthetic-only. Walked live and synthetic
(assets `2026-09-07-item-50/`): live 12 tabs, no Expense Claims, the old address
lands on Overview; synthetic 13 tabs, unchanged, the address still opens the
tab.

**B — the design document is `docs/Expense_Claims_Design.md`. Nothing is built.**
The research is done and cited; six rulings are waiting for you in its §10.
Three findings worth reading before the rulings:

1. **The VT shape needs no new emitter and no new format.** VT derives the double
   entry from *which account Column A names*, and the same "Payments
   list/purchase invoices list" format already serves both purchase invoices and
   bank payments here. A claim is that row with the **claimant's creditor
   account** in Column A and the supplier moved into Column B — Dr expense, Dr
   input VAT, Cr claimant. The reimbursement is **already** what `buildBankRows`
   emits, with its contra pointed at the same creditor: one statement line, one
   row, clearing however many claims it covers. `vt-transaction-plus-emitter.ts`
   is untouched; the change is one line in `document-to-canonical.ts`.
2. **Mileage and subsistence are recommended OUT of ID, with reasons rather than
   a scope call.** They have no document to photograph — so no D43 source link,
   which is a violation by construction, not an omission — HMRC blocks input VAT
   on any flat allowance however good the paperwork (VIT42500, Notice 700 §12),
   and the rates are live data: the car rate had been 45p since 2011/12 and
   changed to **55p for 2026/27**, during this project.
3. **⚠ A pre-existing gap the feature must not be built on top of.**
   `canSendDocuments` is stored and editable but **never checked on the upload
   path** — it appears nowhere in `portal-upload.service.ts` or the portal
   controller. A member with the box unticked can still upload. That is
   Governance §11.2's exact prohibition, and "may submit expense claims" would be
   the third capability on a mechanism whose second is presentation-only. The doc
   recommends fixing that first, as its own change; it is a permission fix, so it
   is your call (⚖C).

The doc also argues **against** building what the synthetic UI mocks: no stored
`ExpenseClaim` aggregate, no second approval ladder beside Review → Approve, and
`claimantId` as a tier-1 field on the existing `document.update-coding` rather
than a new proposal kind (item 66 ⚖5(a) makes it tier 1 automatically). The
batched contract delta is §9, written down rather than applied.

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

**✅ RESOLVED — package H, 7 Sep 2026** (with items 52 and 53; the whole
workflows story landed as one work-package, as this entry asked).

All four sections, walked live and screenshotted under
`docs/reviews/assets/2026-09-07-workflows-package-h/`:

1. **The dangling offer is a card** (`13-item51-refusal-WITH-an-actionable-offer`).
   The refusals are UNTOUCHED and still the model's own words — *"Auto-publish
   rules aren't something this surface can set up… Publishing always requires
   your manual approval before anything is released."* Beneath them now sits
   **Draft a coding rule instead? · Yes — draft it / No thanks**, and Yes opens a
   two-field composer (supplier, code it to) that re-asks in the assistant's own
   vocabulary and enters the same `LIVE_RULE` beat. `ChatTurn.offer` is
   SERVER-SET and deterministic — keyed on the model's own intent, the
   `EXPORT_GUIDANCE` precedent, so no prompt change and no §9.8 re-record.
2. **The in-chat client picker** (`15`, `16`). *"Pick a client first"* with
   nothing to press is gone; `ChatTurn.awaiting = 'client'` renders
   `ChatClientPicker` — the one built for held uploads, reused as this entry
   requires, with its copy made a prop so it can say what it is picking for —
   and the utterance is re-sent VERBATIM with the chosen client attached.
   ⚠ The walkthrough found the hook was in the wrong place: with no client
   there is no chart, so the model often cannot classify a rule ask at all and
   answers asking for a category list. The picker is therefore offered on the
   UTTERANCE when no client is in scope, not only on a `LIVE_RULE` turn.
3. **Confirmation before staging** (`17`, `19`) — already true and left alone:
   `LiveRuleCard` names the client, shows the rule in full, and stages through
   an explicit click → Review → Approve.
4. **It lands in Approvals → Workflows** (`21`). `GET /v1/rules` and a **Coding
   rules in force** list now sit under the Workflows tab: the chat-set rule
   shows as *"Aldgate Supplies → categoryCode OFFICE_COSTS · from chat"*.

⚠ **The gap this entry predicted was real and bigger than expected.** §4 asked
*"check what that tab currently lists"*. It listed nothing from the server at
all — `ApprovalWorkflow` was a prisma table with **zero** operations in the
contract and **zero** references in `apps/api`, so the entire Workflows surface
was browser state. `rule.create` rows were visible nowhere in the product. Both
are fixed; see item 53 for the contract and the persistence.

⚠ **And one long-standing bug the journey walked straight into:
`ChatTurn.draft` had NEVER parsed in the browser.**
`CreateActionProposalRequest`'s members are `allOf` of two `.strict()` halves —
the orval gap `packages/contracts/CLAUDE.md` documents — so
`createChatTurnResponse` failed on every turn carrying a draft and the chat
answered *"The assistant answered in an unexpected shape (draft)"*. The whole
LIVE_RULE beat was dead on this surface for as long as the field has existed.
`api/chat.ts` now lifts the draft out and narrows it separately, the repo's
third workaround for that one gap.

**§5 — the scope note for Shakib, recorded and NOT built.** No rule kind
releases anything. "Auto-publish once Ready" remains a D42/D44 amendment rather
than a chat feature, and the chat's rule vocabulary is still coding rules only.
The workflow surface added no rule taxonomy either — an approval workflow
decides what PAUSES, never what publishes.

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

**✅ RESOLVED — package H, 7 Sep 2026.**

**Layer 1 — what workflows even are, live: nothing.** The check this entry
asked for came back worse than it guessed. `ApprovalWorkflow` has been a prisma
table since the init migration with **zero** operations in
`packages/contracts/openapi.yaml` and **zero** references anywhere in
`apps/api`; the Workflows tab composed, saved, toggled and deleted policies
entirely in React state. Nothing writes the `approvals` table either — the
shipped Review → Approve spine is `ActionProposal`, and `ApprovalWorkflow` /
`Approval` are SoT Stage 9 design tables only `prisma/seed.ts` had ever touched,
in a stage shape no surface has ever read. So contract and persistence landed
first, per this entry's own dependency order. See item 53 for that half.

**Layer 2 — the AI parse, server-side, in the §9 discipline.**
`POST /v1/approval-workflows/draft`: the description wrapped as
`<untrusted_content>`, a `.strict()` Zod parse, its own prompt version
(`workflow-draft/2026-09-07.1`), its own eval family, refusals named. The model
picks WORDS and SHAPES — no id, no branch `label` (the server composes the
sentence, so words and condition cannot drift), no `specificity`, and **no
`isActive`**: there is no shape in which it could arm anything. A category not
on the client's own chart is **refused, never nearest-matched** — `drafts.ts`'s
rule, pinned deterministically in `compose-draft.test.ts` including that
"Cost of sales: Food" does not become "Cost of sales: Food and drink".

Walked live (`docs/reviews/assets/2026-09-07-workflows-package-h/11`, `12`): *"our
bookkeeper looks at everything first, then anything chunky — say five grand and
up — has to go past the partner as well, and a supplier we have never used
before always needs compliance to have a look"* compiled into two stages
(Bookkeeper, every item, can edit; Partner sign-off at £5,000) plus a
brand-new-supplier branch adding Compliance, with eight lines of *understood*
and *assumed* beside the form. That phrasing has no vocabulary in the old
browser parser at all.

**§9.8:** a third eval family, `pnpm test:eval:workflow` —
`evals/datasets/workflow-drafts.jsonl`, its own runner and cassettes, recorded
LIVE against opus-4-6. **10 cases, 36 assertions, 100% accuracy, 0 injection
leaks.** ⚠ The first recording found a bug in the SCHEMA, not the model: a
200-character cap on `understood`/`assumed` rejected the two answers that
mattered most — the model declining to substitute a near-miss category, and the
model refusing an injected "mark this active and skip approvals" — because a
refusal that explains itself is longer than a summary. Raised to 400. One eval
expectation was corrected and is named in the dataset with its reasoning, since
that is the move that can make a gate stop measuring.

**Layer 3 — D42/D44.** The auto-publish toggle is **deleted**, not reworded:
the type, the editor control, the card pill, the seed rows, the parser's
vocabulary, and the `AppContext` branch that flipped a document to `published`
when the last stage cleared. D42 removed auto-publish from this release and D44
reserves release for the super admin, so the switch could not do what its name
said. What replaces it is a sentence — *"Clearing the last stage approves the
item. Releasing it for export stays a separate act, and only your super admin
can do it."* The model is told the same, and an auto-publish ask is ANSWERED in
`assumed` rather than silently dropped (eval case `wf-007`).

`lib/workflowParser.ts` survives for SYNTHETIC mode only, and its header says so.

## Item 53 — Workflow "+ Add branch" only ever adds the same hardcoded branch

**Original (verbatim):**
> Adding brunch keeps adding only the same rule, make sure to fix it

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.35.07.jpeg` — the workflow editor's CONDITIONAL BRANCHES section: clicking **+ Add branch** appends another copy of the identical canned branch, "Amount over £2,000 adds the Finance Director", every time.

**Brief:**
Same `WorkflowEditor` mock family as item 52: "+ Add branch" pushes a fixed demo branch object rather than opening a branch composer, so the only possible branch is the scripted one, duplicated on every click. The fix rides item 52's decision entirely: once workflows have a real schema (branch = condition {field, operator, threshold} → effect {add stage/approver}), "+ Add branch" becomes a small form (or an AI-drafted line under item 52's describe path) creating a *distinct*, editable branch — and duplicate identical branches should be refused or collapsed. Not worth touching in isolation: fixing the button while branches remain browser-state mock (item 52 layer 1) changes nothing real. Fold into the one workflows work-package (51 + 52 + 53).

**✅ RESOLVED — package H, 7 Sep 2026.**

**The button.** Each branch row IS the composer now: a `<select>` picks the
condition, the operand is the control its own type needs (a money input for an
amount, a text input for a category, nothing at all for a new supplier), and
**the label is DERIVED and read-only**. Two clicks give two blank rows to fill,
not two copies of one canned branch (`docs/reviews/assets/2026-09-07-workflows-package-h/03`,
`04`). The deeper half of the defect is the one this entry did not name: the
label was the only EDITABLE field on the old row, so a branch could read
"Over £5,000 adds the Partner" and actually add the Finance Director at £2,000.
Save is blocked while any branch is unfinished, with the reason on the button;
a duplicate label is called out by name.

`ApprovalBranch` lost `operator` — it was implied by `field` and nothing ever
read it — and its amount is `thresholdAbovePence`, integer, `x-nt-money`.

**The contract and the persistence this rode on** (item 52 layer 1's finding).
Shakib's four rulings, in session:

| Ruling | What it means |
|---|---|
| **Arming is a proposal** | `ProposalKind += policy.activate`. Create and replace write an INERT draft and carry no field that could set `isActive`; only the executor does, on the far side of Review → Approve. Composing a policy is D44's compose half; the GATE is the state change — in both directions, which is why disarm is the same kind |
| **One workflow, one client** | prisma's `businessId` over the web's `clientIds[]`. Fixes ClientDetailView having rendered every practice workflow on every client |
| **The auto-publish toggle is deleted** | D42/D44 — see item 52 |
| **`GET /v1/rules` is folded in** | item 51 §4's landing place |

Six operations, `PolicyActivatePayload`, `NT-WFL-001`, two additive prisma
columns (`branches`, `self_approval`) and an `is_active` default flipped to
false. `policy.activate` is TIER 1 in `RELEASE_KINDS` (now nine) by
`rule.create`'s argument one step wider: §10.5 lets an approved policy act with
no per-item proposal, and a workflow decides whether anything stops for a
signature at all.

Walked live: saved (`07`), **survives a reload** (`08`), and arming it opens the
`policy.activate` review that renders the whole policy — what changes, the
scope, every stage, every branch (`09`, `10`).

⚠ **Two defects the walkthrough found in this package's own work**, both fixed
before the commit: `ApprovalWorkflowWriteRequest` used `allOf` and therefore
400'd on every valid body (the orval gap again — it is written out in full now),
and the editor let a stage with no approver reach Save.

**One `WorkflowsPanel`, lazily loaded, replaces both views' near-duplicate
copies of this screen**, which is also what finally filters the client tab by
client. ⚠ ROUTE BUDGETS, paired A/B against main: floor **−3,805 B**,
ApprovalsView **−6,090 B**, ClientDetailView **−6,528 B**, InboxesView
**−3,521 B**, AIWorkspaceView **−93 B**. **Every route is lighter than main.**
The package's own contract additions cost +856 B of floor on their own — six
operations in a zod tag directory nothing on the floor imports — and briefly put
the worst route 412 B OVER budget. `scripts/mark-zod-pure.mjs` paid for them and
more: orval emits every schema as a top-level call Rollup cannot tree-shake, so
the barrel pins all 174 onto every route, and a `/*#__PURE__*/` annotation
reclaims ~3.8 kB product-wide. ⚠ AIWorkspaceView's 93 B is a rounding error, not
headroom — the two chat cards cost that route ~3.7 kB and the reclaim just
covered them. It remains ~55 kB over its budget, as it was before this package.

## Item 54 — Tasks: no server behind teams/tasks — plan and build the feature completely

**Original (verbatim):**
> Task assign option is not build yet, make sure to plan this out and setup the feature completely

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.36.15.jpeg` — Team → Tasks: the amber banner "Teams and tasks are demo data. They have no server behind them yet, so nothing here is saved", the "+ New task" button disabled with the honest tooltip ("There is no operation behind this yet, so anything typed here would be lost on the next reload"), and an empty task table (Task / Client / Assigned to / Due / Status).

**Brief:**
The Tasks tab is a known, honestly-labelled mock (the S14 sweep disabled its writers with reasons — this screenshot is that posture working). Mubashir is now commissioning the real feature: practice-side task management — create a task, scope it to a client, **assign it to a colleague**, due date, status lifecycle, plus the "recurring per-client checklists" the footer already promises.

Work shape (feature-sized, plan before PR):
1. **Contract + schema (G7):** a `tasks` model (title, client scope, assignee = practice member, due date, status, recurrence) and CRUD operations. Decide the write path: task create/assign is plausibly ingest-class (`x-nt-side-effect: ingest`, like intake — a task is coordination, not a client-state change), which keeps it off the Review → Approve spine; that's a Governance call to confirm with Shakib rather than assume.
2. **Assignment realities:** assignees come from the live practice-members read (`api/team.ts`, already real); notification on assignment wants the email seam — and the in-app half is no longer missing: item 12's notifications read surface landed in #254 (`GET /v1/notifications` + the header bell), so a task-assignment notice is one more `notifications` row with its own `event` string and one more copy branch in `NotificationsBell.tsx` (an unknown event already renders an honest generic line).
3. **Web:** the table, filters and per-client scoping already exist as the synthetic board — wiring is the ClientsView/M7 pattern (widen the real endpoint, one board, live rows through the same components; the synthetic cast stays for demo mode).
4. **Recurring checklists** (the footer's own promise, and the sub-tab's stated job — "recurring per-client checklists scoped to this product's job"): monthly/quarterly per-client recurrence generating task instances — needs a worker tick; decide whether recurrence ships in v1 of this feature or the doc explicitly defers it.
5. **Cross-refs:** the Teams sub-tab is the same mock family (its writers were disabled in the same sweep) — the plan should say whether Teams ships with Tasks or stays out; and "Ask AI about workload" stays real either way. Deliverable: a short design doc for Shakib (scope, contract delta, side-effect class), then build.

**PLAN (7 Sep 2026) — confirmed first, then designed.**

**The claim in the brief is exactly right, and narrower than it sounds.** `Task`
has existed as a Prisma model since the init migration (`prisma/schema.prisma`
— title, description, `ownerUserId`, `dueAt`, `status`, `cadence`,
`dependsOnTaskId`, `aiPrefilledAt`), `tasks` is on rls.sql's `direct_tables`
loop so `app_can_access_business` already bounds it, and **nothing has ever
read or written a row**: `grep -i task packages/contracts/openapi.yaml` returns
three unrelated comments and no operation, and no service under
`apps/api/src/modules` touches `db.task`. Both surfaces — `TeamView`'s Tasks
tab and `ClientDetailView`'s Tasks tab — run off `AppContext`'s `useState`,
seeded by `buildTasks()` in `lib/seed2.ts`. The amber banner and the disabled
"+ New task" in the screenshot are the S14 sweep telling the truth about that.

So the schema is NOT the gap. **The gap is the contract, the service and the
wiring**, and the plan is shaped by not needing a migration.

### 1. What a task is, and whose it is

A **task is practice-side coordination scoped to one client business.** Three
consequences, all forced by the row that already exists rather than chosen:

- **`businessId` is NOT NULL, so there is no practice-wide task.** Every task
  names a client. That is also the only shape RLS can express — a row with no
  `business_id` has no predicate to bound it, and inventing a practice-level
  task would mean a second tenancy story beside the one every other table uses.
  The Tasks tab's "All clients" filter stays a *filter*, never a scope.
- **It belongs to a practice member, never to a client.** `ownerUserId` is a
  colleague from the live `GET /v1/practice-members` read. **The client never
  sees a task**: nothing in `LiveBusinessPortal` reads this table and nothing in
  this package makes it. A task is how the firm organises itself about a
  client's books, not something asked of the client — that is what a chase is,
  and the product already has one.
- **It can depend on exactly one other task** (`dependsOnTaskId`, the notion
  both existing surfaces already render as *"Waiting on: {title}"*). Kept, with
  two rules the server enforces because the UI cannot: the blocker must be on
  the **same business**, and a dependency may not close a cycle. A blocked task
  can still be *completed* — the dependency is advisory ordering for a human,
  not a lock — and the surfaces keep disabling the tick while it is blocked,
  which is where that belongs.

### 2. Proposal, or ordinary mutation? — **tier 3, no proposal. Explicitly.**

Applying item 66's ratified question rather than `RELEASE_KINDS`' old one:
***whose signature does this carry?***

**Nobody's.** Ticking "Chase missing receipts" off a checklist asserts nothing
about a client's books, moves no money, changes no document's coding, reaches
nothing outside the product, and is undone by clicking it again. It is not
close to the line — it is the clearest tier-3 case in the product, clearer than
`createApprovalWorkflow`, which at least composes a policy that will one day
gate other people's work. **Create, edit, assign, complete, reopen and delete
are all `x-nt-side-effect: ingest`**, and no `ProposalKind` is added.

Saying it explicitly, as the brief asks, because the *default* pull is the
other way — Governance §10 says "no state change outside the ActionProposal
path" and a task write is a state change in the plain-English sense. §10 is
about **the client's state**: the document, the coding, the chase, the release.
A proposal on a checkbox would put a signature on something nobody is signing
for, and item 66's own finding is that asking for a signature twice makes the
second one mean less. The one thing that would move this to tier 2 is a task
that *acts* — a checklist item that publishes, or codes, or texts — and there
is none: `aiPrefilledAt` reads engine state, it never drives it.

### 3. Contract delta — one resource, five operations (LAW: needs the ruling)

`Task` + `TaskWriteRequest` + `TaskEditRequest` + `TaskStatusRequest` schemas,
and:

| Operation | Path | Side-effect |
|---|---|---|
| `listTasks` | `GET /v1/tasks` (`businessId`, `status`, `assigneeId` filters, cursor + limit) | `none` |
| `createTask` | `POST /v1/tasks` | `ingest` |
| `replaceTask` | `PUT /v1/tasks/{taskId}` | `ingest` |
| `setTaskStatus` | `POST /v1/tasks/{taskId}/status` | `ingest` |
| `deleteTask` | `POST /v1/tasks/{taskId}/deletion` → `204` | `ingest` |

`approval-workflows` is the template throughout — same pagination, same
`Idempotency-Key`, same server-minted ids, same `204`-whether-or-not-it-existed
deletion. `status` is its own small operation rather than a `PUT` because the
tick is the write that happens a hundred times a day and it must not require
the caller to hold every other field in order to send it.

**`Task.status` is the four values the surfaces already render** — `open`,
`complete`, `complete-with-issues`, `not-applicable` — as an enum in the
contract, so a fifth cannot arrive by typo. `assigneeName` is projected
server-side (one `user.findMany` over ids that came out of RLS-bounded task
rows) so neither surface has to hold the members list to render a row.

**No Prisma migration.** Every field maps onto a column that exists.
`Task.description` is carried because the column is there and the composer has
somewhere to put it; nothing else is added.

### 4. Recurrence — **shipped, and WITHOUT a worker tick**

The footer promises "recurring per-client checklists" and `cadence` is an
unwritten column. Both are honoured, by the cheapest mechanism that is actually
correct: **completing a recurring task creates the next instance**, due date
rolled forward by the cadence (`monthly` / `quarterly`), same title, same
assignee, same client, status `open`. No cron, no worker, no scheduler, no new
infrastructure.

The behaviour this deliberately does *not* have: a monthly task nobody ever
completes does not pile up twelve copies by December. That is the right answer
for a checklist rather than a limitation of the shortcut — twelve identical
open rows is how a board becomes noise nobody reads. If a *calendar* is wanted
later (rows that appear on the 1st whether or not last month closed), that is
the worker tick, and it is a different feature with a different failure mode.
Recorded here so the reasoning does not have to be rebuilt.

### 5. Assignment notification — one row, one copy branch

On create-with-assignee and on reassignment, one `notifications` row:
`event: 'task.assigned'`, `recipientUserId` = the assignee, `businessId` = the
client. `NotificationsBell` gets one copy branch. **No notification when you
assign to yourself** — the bell exists to tell you something you did not do.

⚠ Two honest limits, stated rather than papered over: the bell's list query
carries **no `recipientUserId` filter** by item 12's own decision (*"the bell is
a practice-wide surface"*, `inbox.service.ts`), so a colleague's assignment is
visible to the practice; and `NotificationItem` carries no task title, so the
copy can only say *"A task was assigned for {business}"*. Widening the
projection for one line of copy is a contract change that buys a noun; not
taken. The email seam the brief mentions is **not** built — outbound sending is
a stop-and-ask surface and an in-app row is what item 12 was for.

### 6. "AI-prefilled" — **the badge does not ship on live tasks**

Today the badge is decided by `t.aiPrefilled` on a synthetic row and explained
by matching the task's **title against three string prefixes**
(`TeamView.tsx:341` — `startsWith('Confirm bank feed')`, `'Chase missing'`,
`'Approve'`). Against a real task called "Chase missing paperwork before the
VAT return" that is a coincidence, not a derivation, and item 25's standing
rule forbids it.

`aiPrefilledAt` stays a column with **no writer in this package**, and the
badge renders only when the server sends a timestamp — so on a live task it
never appears. The synthetic cast keeps it, unchanged, in demo mode. The badge
earns its way back when something actually reads engine state and stamps the
column, which is the SoT §7 sentence already written on that field.

### 7. Teams — **out, and this is the recorded reason**

The Teams sub-tab is the same mock family, and unlike tasks it has **no table**:
shipping it means a new model, a new RLS policy and a new access concept
(`accessLevel: 'All clients' | 'Assigned clients only'`) that **duplicates what
`Membership.businessId` already expresses** — a practice-wide membership is
"all clients", per-client memberships are "assigned clients only", and
`GET /v1/practice-members` already returns exactly that as `businessIds`. A
second, parallel access model beside memberships is how a permission bug ships.
Teams stays a labelled mock; if it is wanted, the shape to build is *named
groups that write memberships*, not a second answer to "what can this person
reach".

### 8. Surfaces

`TeamView`'s Tasks tab and `ClientDetailView`'s Tasks tab both move onto the
live read, the `ClientsView`/M7 pattern: same components, same filters, rows
from the server, the synthetic cast retained for demo mode. Due dates use
**`UkDateField`** (package D's one control), not a second picker. The amber
"no server behind them yet" banner narrows to Teams alone, and "+ New task"
loses its disabled state and its tooltip.

**✅ RESOLVED (7 Sep 2026, item-54 package).** Planned above, then built — with
**one ruling reversed from the plan**: Shakib took Teams IN.

**Shakib's three rulings, in session:**
1. **Contract delta — approved as specified.** Five task operations, no Prisma
   migration for `tasks`.
2. **Recurrence — "complete rolls the next one forward".** No worker.
3. **Teams — "Ships too."** The plan recommended leaving it out and gave the
   reason; the owner took the other option, so Teams shipped with a new table.
   ⚠ **The objection was not overruled, it was designed out** — see §7 below.

### What landed

**The claim was confirmed exactly.** `Task` was a table nothing had ever read or
written: no operation named it, no service touched it, both Tasks tabs were
React state. So **`tasks` needed no migration** — every field the feature wanted
was already a column, and `tasks` was already on rls.sql's `direct_tables` loop.

**Contract (LAW, ruled):** `listTasks` (`none`) · `createTask` · `replaceTask` ·
`setTaskStatus` · `deleteTask` · `listTeams` (`none`) · `createTeam` ·
`replaceTeam` · `deleteTeam`. `/approval-workflows` is the template. Six new
error codes (`NT-TSK-001/002/003`, `NT-TEM-001/002/003`), each a refusal a
person acts on at a form. `GET /teams` is paginated because `check-contract.mjs`
refuses a list without `pageInfo` — and is right to.

**Tier 3, and said out loud as the brief asked.** Applying item 66's ratified
question — *whose signature does this carry* — a ticked checkbox carries
nobody's. Every write is `x-nt-side-effect: ingest`, **no `ProposalKind` was
added**, and `tasks.service.test.ts` asserts it structurally: the fake Prisma
exposes no `actionProposal` delegate, so a future write path that minted one
throws rather than passing.

**Recurrence, without a scheduler.** Completing a task with a `cadence` writes
the next occurrence in the same transaction, due date advanced by one period.
Two details with tests behind them: the roll is from the **old due date**, not
from `now` (rolling from today walks the series later every cycle), and
month-end **clamps** — `Date.UTC(2026, 1, 31)` is 3 March, which would drift a
31st permanently off month-end. Proven live: *File the Q3 VAT return* ticked at
28 September produced a fresh Open row at **28 December 2026** (screenshot 03).

**Assignment notification.** One `notifications` row, `event: 'task.assigned'`,
plus one copy branch in `NotificationsBell`. Written after the task's
transaction, so a failed notice cannot roll back the assignment it describes.
**Nothing on self-assignment**, and reassignment notifies only when the assignee
actually changes — otherwise the bell becomes the thing people mute. Two limits
stated rather than papered over: the bell has no `recipientUserId` filter by
item 12's own decision, and `NotificationItem` carries no title, so the copy
says *"A task was assigned on {business}"* and no more (screenshot 03).

**Surfaces.** Both Tasks tabs and the Teams tab moved onto the live reads, the
`ClientsView`/M7 pattern — one board, two sources, synthetic cast retained for
demo mode. Due dates use **`UkDateField`**, package D's one control, on both
composers; every cell renders long form. The amber *"no server behind them yet"*
banner and its two disabled-with-a-tooltip buttons are gone, and so are their
three message ids — with real operations behind them, that notice would itself
be the dishonest string.

### ⚠ The AI-prefilled badge does NOT ship on live tasks

It was decided by matching a task's **title** against three `startsWith`
prefixes (`'Confirm bank feed'`, `'Chase missing'`, `'Approve'`). Against a real
task called "Chase missing paperwork before the VAT return" that is a
coincidence, not a derivation. The badge now renders off the server's
`aiPrefilledAt`, which **nothing writes**, so it never appears live and is
unchanged in demo mode. Three consequences taken with it:

- The Tasks-tab intro lost its *"Steps marked AI-prefilled can be answered from
  real pipeline state"* sentence — a promise of a badge that never appears is
  the same dishonesty as the badge.
- The seed's `aiPrefilledAt` on `tsk_002` was removed.
- The seed's `status: 'not_applicable'` was corrected to `'not-applicable'`.
  Nothing had ever validated it because nothing read the table; the service maps
  an unknown status to `open`, so the symptom would have been a closed task
  quietly reappearing on the board.

### ⚠ §7 reversed: Teams ships, and the objection is designed out, not overruled

The plan argued Teams should stay out because an `accessLevel` on a team is a
**second answer** to *"what can this person reach"* beside `Membership.businessId`,
and two answers to that question is how a permission bug ships. Shakib ruled it
ships. Both are now true at once:

- **There is no `access_level` column.** The label is DERIVED at read time —
  `all-clients` when every member holds a practice-wide membership,
  `assigned-clients` otherwise (and for an empty team, which reaches nothing
  because it contains nobody; the vacuous-truth trap has its own test).
- **No policy in the database consults `team_members`**, and
  `tenancy-check.sql` §12 asserts that over `pg_policies` rather than trusting a
  comment. If that assertion ever needs relaxing, the design has changed.
- **The editor's access chips are gone live** and replaced by the reading, which
  points at Colleagues — a control that appeared to set it would be the second
  answer. Its subtitle changed too: it said *"Groups colleagues and scopes the
  clients they can reach"*, directly above the sentence saying it does not.
- Deleting a team takes nobody's access, because a team never granted any.

`teams` carries a practice and no business, so its policy is the anchor-pair
predicate with a NULL business — which carries the `app_session_scope() = 'user'`
guard a delegated portal session fails. `pnpm db:tenancy-check` is green,
including the new §12.

### Verification

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all four green,
web **935/935** and api **2701 passed / 2 files skipped**, with no red at all on
the final run. (An earlier run hit the standing `auth.service.test.ts` A2
lockout flake, which passed in isolation and did not recur.) `pnpm
db:tenancy-check` green including the four new §12 sections.

**Route budgets, paired A/B (`vite build --manifest`, closure walk):** floor
+19 B · `ClientDetailView` 238,815 → **243,730 B** (6,270 B spare) · `TeamView`
230,034 → **234,630 B** (15,370 B spare) · `InboxesView` untouched. ⚠ The brief
quoted 954 B on `InboxesView` and 2,469 B on `ClientDetailView`; this paired
measurement finds more headroom on both — re-measure rather than believing
either figure. `ClientDetailView`'s Add-task form reads the members through a
six-line `useAssignees` in `api/tasks.ts` rather than importing `api/team.ts`,
which would have dragged the whole Colleagues surface onto that route; a test
pins the two query keys equal so React Query still serves one request.

Walked live end to end: board, composer with the UK date field and recurrence
chips, the generated next occurrence, the bell, the Teams cards, the editor's
derived-access reading, and the per-client tab.
Evidence: `assets/2026-09-07-item-54/01–07`.

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

**✅ RESOLVED (5 Sep 2026, PR #257 — package C).**

**What was done:** all three candidates ran to ground:
1. **The null-selection copy is fixed**: with no client chosen the history query does not even run (`enabled` gates it off), so the panel now says *"Choose a client to see its export history."* — never "nothing has been exported for this client" about a client that was never named. Pinned by test; screenshot `assets/2026-09-05-export-chain/01`.
2. **Recording works and is proven twice**: the integration suite pins that a created export lists for its practice (and that the `businessId` filter serves it), and the live walkthrough exported American Burger's August and watched both runs appear under Export history immediately (screenshot `assets/2026-09-05-export-chain/04`). No server bug existed.
3. **The failed-attempts question, ANSWERED: history stays successes only.** His "two previous exports" were both `NT-EXP-001` refusals — nothing was exported, no artefact exists, and the panel's stated purpose is *"what has already been exported, so a month is not imported twice"*. A refused attempt now explains itself far better at refusal time instead (items 29/37's work); listing refusals in history would put rows in a table whose one job is to say what a re-import would double.

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

**✅ RESOLVED (5 Sep 2026, PR #257 — package C).**

**What was done:** both defects fixed and the designed report built:
1. **`autoPublishedPct` is renamed `publishedPct`** — it measures the share of processed documents that reached Published, so that is its name, in the metrics object and everywhere downstream. The forbidden vocabulary no longer exists in the codebase's metric keys.
2. **`unmatched` is the one predicate** — package A's `isUnexplained` had already landed on the tile; the report reads per-client counts through `statsFor`, which live is the server's own `BusinessSummary.counts` (`UNMATCHED AND NOT chase_suppressed`), so the file cannot disagree with the Bank screen or the Clients board.
3. **The report** replaces the KPI dump: spec (with the competitor research, cited) in `docs/reports/PRACTICE_ANALYTICS_REPORT.md`; builder in `apps/web/src/lib/analyticsReport.ts` (pure, tested — its own D42 copy test included). One row per client (health, pipeline states, missing/requested/overdue, unmatched, statement gaps, approvals, **subscription state** off `BusinessSummary.subscription`), a practice roll-up, and a **time-saved estimate whose 3-min/document assumption is printed inside the file** — the research found no competitor publishes a formula, so ours is stated, never silent. **Counts with no server source are omitted and the file says so** (duplicates caught, item delay, chases sent/answered, period scoping) — the spec lists what serving each needs. Format: CSV with BOM (XLSX needs a new dependency, which is a stop-and-ask; upgrade path confined to one file). Produced live in the walkthrough: `assets/2026-09-05-export-chain/08-practice-analytics-report.csv`.
**Research (cited in the spec):** Dext Practice Insights is the category benchmark (per-client exportable tables: items to action/submitted, inactive clients, health score with trend, missing/requested paperwork, item delay, statement-gap detection, duplicate-check alert level); AutoEntry ships essentially credit-usage-per-company; Hubdoc ships no practice analytics. Matching Dext's set plus a stated time-saved assumption exceeds the field; the not-yet-served list is the roadmap to it.

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

**✅ RESOLVED (6 Sep 2026, the access-control package).** Four contract
additions plus a list change, approved as tabled at gate ⚖3.

**Contract** — `PATCH`/`DELETE /v1/practice-members/{userId}`,
`DELETE /v1/practice-invitations/{inviteId}`,
`POST /v1/practice-invitations/{inviteId}/resend`, and `listPracticeMembers`
now returns EXPIRED invitations. That last one is not incidental: the list said
*"an expired one is not something to wait for"*, true while there was nothing to
be done about one — and an expired invitation the screen cannot show is one
nobody can re-send. `Invite.expiresAt` already distinguishes them, so no field
was added. Invitations get their own noun because an invitation has no user id.

**Why an edit REWRITES memberships.** Per-client access is not a column — it is
the shape of a person's rows, and a scoped colleague's carry `practice_id`
**NULL** deliberately. So moving between practice-wide and scoped is a
delete-and-write, and `membershipShapeFor` is deliberately identical to what
`invitation-acceptance.service.ts` writes: an edited colleague and an accepted
one must end up with the same shape or RLS would treat them differently.
`businessIds` keeps the invitation's semantics exactly — **empty means EVERY
client** — so the same list means the same thing at both ends of a person's
time at the firm.

**The guards, all server-side** (and all about the SUBJECT rather than the
actor, which is why they live in the service and not in `assert-can.ts`): the
owner cannot be changed OR removed — re-scoping is refused along with demoting,
because a practice-wide owner narrowed to two clients is the same D44 outage
wearing a different field; **`PRACTICE_ADMIN` cannot be granted by an edit**
(Shakib's explicit ruling at ⚖3, for the invite boundary's reason); nobody
removes themselves; a colleague at another firm is a `404`.

`team.manage` is the sixth `PermittedAction`, sharing `mayManageTeam` with
`team.invite` — ONE predicate, two names. The authority is identical; what
differs is the sentence a refused caller reads, and *"Only a practice admin can
invite a colleague"* said to somebody who pressed Remove is a wrong answer in a
right status code. Each write appends an audit row on the practice's
`(no-business)` chain.

**Web** — per-row edit and remove on the colleagues table, revoke and re-send
on each invitation row, all **disabled-with-the-reason-as-title rather than
hidden**. Remove and revoke go behind a `ConfirmStep` stating the real blast
radius — what ends and what does not (*"everything they already did keeps their
name"*). The editor is the invite dialog's own shape pre-filled, so the two
screens cannot disagree about what an empty client picker means; the address is
shown and not editable, with the reason. An expired invitation wears a red pill
whose tooltip names the fix, and re-send says BEFORE the click that the existing
link will stop working.

**Tests: eleven against a real database**, because the claim is Postgres's — an
edit that widened someone's scope in the projection while leaving RLS alone
would pass every unit test written for it. They assert effects, not messages:
`practice_id` still NULL on every rewritten scoped row, the widened colleague
now sees the withheld client through `loadScopeForUser` + `scopedDb`, the owner
still holds their row after a refused edit, a removed colleague's session
resolves to null while their account survives, a revoked token no longer
accepts, a re-sent one supersedes rather than accumulates, and an expired
invitation lists and revives. Verified red: deleting the three guard lines fails
eight of them.

**Walked live**: the rows with their actions and the owner's disabled reason
(`57-01`), the pre-filled editor (`57-02`), a real edit round-trip from
*1 client* to *All clients* (`57-03`), the remove confirmation's blast radius
(`57-04`), the re-send warning (`57-05`) and a revoked invitation leaving the
list (`57-06`). Evidence in `docs/reviews/assets/2026-09-06-access-control/`.

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

**✅ RESOLVED (6 Sep 2026, this branch).**

**What was done:** every live chat upload now HOLDS and asks first. The files land in the
transcript as a user bubble (the raw `File` rides the message, so *a held file whose question is
never answered stays visibly attached to the conversation* — and the question's own copy says
"nothing has uploaded yet … they stay attached until you decide"), and the assistant answers with
a `CHAT_UPLOAD_DECISION` card offering exactly the real options: **"Send to {client}'s inbox for
review"** (the one-click suggested default when exactly one client was attached), **"Send to a
different client"** (the existing searchable `ChatClientPicker`, now opened from the card), and
**"Cancel — don't upload"** (uploads nothing, says the files stay attached, and the buttons
remain for a change of mind). With "All clients" active there is no suggestion and the primary IS
the picker — never a guess. "Discuss it without ingesting" is deliberately not offered (S12 — no
read path for un-ingested bytes exists). The success message carries item 60's honest timing copy:
*"Extraction is running — it appears in {client}'s inbox within a minute or two."*

**Where it landed:** the hold in `useChatUpload` (`ChatUpload.tsx` — which SHRANK: the whole
upload journey moved off the floor-resident module onto the chat chunk's new
`ChatUploadDecisionCard`, and the hook's old modal-hold machinery retired); the card renders via
`IntentRenderer` under the new local intent. A reloaded transcript keeps the question's sentence
and drops the card (persistence stores text + intent name only); files that did not survive
degrade to an honest line, never buttons that would upload nothing. Synthetic ingest-on-drop is
byte-for-byte unchanged (METH_MODE §1). Pinned across `ChatUpload.test.tsx`,
`ChatUploadDecisionCard.test.tsx` and `InputRow.test.tsx` (the pick, the drop, the hold, the
picker, cancel, refusal reasons, the timing copy, the files-gone degrade).

**Not built, deliberately:** the "always do this" tick — his phrasing reads as wanting the ask
every time, so asking is the default and the refinement waits for a real request.

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

**✅ RESOLVED (7 Sep 2026, branch `fix/review-items-59-18-16`).**

**⚠ It was NOT already fixed, and the note above saying it likely was is the
thing worth reading twice.** Item 9's server-side persistence was real and
working: with the API on, a turn was sent, the page reloaded, and the drawer read
**"No conversations yet."** while `GET /v1/chat/conversations` answered
`{"id":"draft-initial","title":"How many documents are waiting for…","messageCount":2}`
— the transcript, in the database, unreachable. So the verification the brief
asked for is what found the defect rather than closing the item.

**The cause was one constant.** `AppContext` minted every session's first
conversation as `newDraft(…, 'draft-initial')`, so that one name meant a
different conversation every time it was used. Two failures came out of it:

1. **A reload could not read the transcript back.** `hydrateConversations` is
   add-only by id — deliberately, so a stale summary cannot clobber the open
   tab's live state — and the fresh, empty `draft-initial` was already in the
   array before the server answered. The saved row was dropped,
   `remoteMessageCount` was never set, `useConversationSync` never fetched the
   messages, and `LeftPanel` filtered the row out for having none.
2. **The next session OVERWROTE the last one**, silently and unrecoverably: the
   save is a PUT under the conversation's own id.

**What was done:** the first draft has no special name any more, and
`newDraft` gained a random suffix (`draft-${Date.now()}-${seq}-${rand}`) because
**the id is a server key now** and two tabs opened in the same millisecond both
start their counter at 0. Nothing else changed — the wire, the sync hook, the
reconciler and the drawer were all correct and none was touched. Pinned in
`AppContext.test.tsx`: two mounts, two different first-draft ids, and a summary
carrying the earlier mount's id hydrating into the drawer — it fails on the old
code at `expect(freshId).not.toBe(earlierId)`.

Walked live: conversation → reload → **both rows in RECENT HISTORY**, and
clicking one brings the transcript and its cards back
(`assets/2026-09-07-items-59-18-16/01-item59-history-survives-a-reload.png`,
`assets/2026-09-07-items-59-18-16/02-item59-transcript-comes-back.png`).

---

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
1. **Copy fix stands:** the chat's success message should set the expectation honestly — where the document lands *and* that it takes a moment ("Extraction is running — it appears in {client}'s inbox within a minute or two"), so a user checking immediately doesn't read absence as loss. The "it's arrived" half now exists: item 12's bell landed in #254 — though note the sink deliberately writes `document.received` only for client channels (email/WhatsApp/portal), not the accountant's own WEB_UPLOAD/CHAT_UPLOAD, so a chat upload still relies on the copy plus the 5 s inbox poll; notifying on *extraction landing* (state leaving RECEIVED) would be the follow-up if the copy alone doesn't settle it.
2. **Follow-up correction (his words: "in the inbox tab show the Received via column too"):** the client Costs tab shows **Received via**; the **Inboxes screen's** tables don't. Add the same channel column there (`InboxesView` — the data is already on every document row; it's a column definition, plus the honest labels from item 21). Small, standalone, do it with item 21's channel-label sweep so the column arrives showing true words rather than `sms-link` slugs.

   **✅ The follow-up is RESOLVED (5 Sep 2026, PR #260 — the channel-provenance package):** the Inboxes board carries **Received via** in both layouts — a column in the desktop table, a chip on the phone cards — born with item 21's honest words (Client portal / Chase link / Chat upload / Uploaded by {accountant}, never a slug, never SMS). Screenshot `docs/reviews/assets/2026-09-05-channel-provenance/06`; pinned in `InboxesView.test.tsx`. The route was the thinnest on the board and the column tipped it over 250 kB, so `AnalysisModal` went lazy in the same change — InboxesView measures **246,080 B** paired A/B, lighter than before the column existed.

## Item 61 — There's a Trash button but no visible Trash for the client; define how the trash holds files

**Original (verbatim):**
> If there's a trash button then there should be a trash tab in the settings to see the trash, and how will the trash hold the file? Clear that out

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.48.18.jpeg` — Zeplow → Costs → To Review: a row selected, **Move to Trash** in the bulk bar (red arrow) — and no Trash tab anywhere on the client screen to see what was trashed or bring it back.

**Brief:**
Two halves:
1. **Reachability.** A Trash *does* exist — the practice **Documents** screen gained a Trash tab (2 Sep, `api/document-lifecycle.ts`: deletion/restoration/the Trash listing) — but from the client context where the button lives, the trashed document just disappears with no visible destination. Fix: make the trash reachable from where things are trashed — a Trash view scoped to the client (a sub-tab on the client's Documents/Costs area, or his suggestion: under the client's Settings tab), listing that client's deleted documents with **Restore** and (permission-gated) **Delete permanently**, reusing the existing lifecycle endpoints and the `document.purge` proposal. Same-surface rule as item 35: the count/affordance and the list belong together.
2. **"How will the trash hold the file? Clear that out" — the retention policy doesn't exist and must be written.** The 2 Sep work deliberately promised **no recovery window** ("a figure would be a promise the product does not keep" — nothing enforces one). Mubashir is now asking for exactly that promise, so it's a product decision for Shakib: how long a trashed document is held (e.g. 30 days then auto-purge? held forever until purged by hand?), whether auto-purge respects D43 (a document linked from an export file refuses purging — `NT-DOC-002` — so auto-purge must skip those or the policy must say "held forever once exported"), and then the confirmation copy states the real policy. If auto-purge is chosen, it's a worker tick + audit trail; if held-forever, the Trash view needs the storage story said out loud. Either answer is fine; an unstated one isn't.

**✅ RESOLVED (7 Sep 2026, package L — with items 67).** Evidence in `assets/2026-09-07-retention-deletion/`.

**The ruling came first, in session, because the copy could not be written without it.** Shakib chose **thirty days, then auto-purge** over 7 and 90 — the interval every accountant already recognises from their operating system, Google Drive and Dropbox, and long enough that a mistaken bulk delete survives to the next month-end pass. He also ruled **one number for the whole of package L** rather than two that would drift, so the same figure governs a trashed document and a removed client's restore window. It is written down once, in `docs/Retention_and_Deletion_Policy.md`, and read from one constant — `TRASH_RETENTION_DAYS` in `packages/contracts/src/retention.ts`, which lives in the contract package precisely because the sweep that enforces it is server-side and the copy that promises it is browser-side, and two constants that must be equal and cannot see each other are the failure `deleted-documents.ts` argues against one table over.

⚠ **The window has a SECOND clause and no surface may print only the first.** *Anything already exported is held indefinitely.* D43's refusal (`NT-DOC-002`) binds everybody including the super admin, so "30 days" alone would be a promise the product will not keep. Both halves now appear on the client Trash, the practice Trash, the empty state, the footer and the delete confirmation — pinned in `DocumentsView.test.tsx` and `ClientTrashPanel.test.tsx`.

**What enforces it:** `scripts/purge-expired-trash.ts` (`pnpm trash:purge`, `--apply` to act; dry run by default). Practice by practice through `scopedDb` — an unscoped query returns an empty list and does NOT error, which `cleanup-duplicate-proposals.ts` and `backfill-import-fingerprints.ts` were both caught by, and a retention sweep silently finding nothing would be the worst place to learn it a third time. It applies the same four `document.purge` refusals but **skips** rather than refuses: one protected document must not stop the other four hundred. Governance §10.5 is satisfied literally — the policy is a platform term rather than a per-practice toggle, consent is taken at the moment of deletion (the confirmation states the window before anything moves), and every purge appends an audit row naming `TRASH_RETENTION_POLICY_ID`, written in the same transaction as the delete and **before** it, because `document_events` cascades away with the document.

**Reachability — the client's own Trash.** A **Trash** sub-tab beside **Register** on the client's Documents tab (`ClientTrashPanel`, its own lazy chunk), listing that client's deleted documents with **Restore** and a permission-gated **Delete permanently** through the existing `document.purge` dialog. Not Settings, which Mubashir suggested and the brief allowed: a deleted document is still a document, the Documents tab is this client's register, and a list of a client's paperwork under Settings would be a second answer to "what documents does this client have". The Move-to-Trash confirmation on Costs now names that destination in as many words instead of pointing at the practice screen. `GET /documents` already took `deleted` and `businessId` and they compose, so the whole listing was a web change.

⚠ **One real defect the walkthrough found on the way, and it is not cosmetic.** `deleted=true` **composes** with `state`, and an omitted `state` means *"every state except ARCHIVED"* — so a document archived and then deleted was **counted by the header and listed by nothing**. The screen read *"1 in Trash"* over an empty table, and the only way to reach the document was knowing to send `?deleted=true&state=ARCHIVED` by hand. That is exactly the header-versus-list disagreement `GET /documents/counts` exists to abolish. Fixed at the shared hook (`EVERY_STATE`, read off the generated enum so a new state joins the Trash on its own), which fixes the practice Trash and the client Trash together; proven live on the real row (screenshot `11`) and pinned in the new `api/document-lifecycle.test.ts`.

**Bundle:** `ClientDetailView` **fell 2,461 B** (247,774 → 245,313 B, paired A/B) — `OffboardClientDialog` went lazy in the same change and gave back more than the Trash sub-tab and item 67's scope options cost. See item 67 for the full table.

## Item 62 — Accountant's own upload on the client Documents tab and the Inboxes screen (physical/personal-channel documents)

**Original (verbatim):**
> There could be situation where the client will send the doc to the accountant in personal channel, or hand it over in physical way, so then the accountant might need to enter the document by himself, so provide a option to upload document by accountant himself in client->document tab and in the inbox tab

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.54.00.jpeg` — Zeplow → Costs → To Review: the tab **does** have an Upload button (top-left) and now shows the Received via column (chat / sms-link rows visible).

**Brief:**
The scenario is real — WhatsApp to a personal number, paper handed over at a meeting — and the accountant needs a first-class way to enter those. What already exists vs. the gap:
1. **Exists:** the client's Costs/Sales tables have Upload (`runWorkspaceDrop` — the real intent → PUT → complete journey, `channel: 'WEB_UPLOAD'`-family), and the Inboxes screen accepts drag-drop with a required client choice (plus the add-a-client-first dialog). His screenshot is of a tab that already has the button.
2. **Gaps to close:** the client's **Documents tab** (the per-client register) has no upload affordance — add the same button/drop there; and the **Inboxes screen** should have a *visible* Upload button (drag-drop-only is undiscoverable — if the dialog exists behind a button today, verify it's present on every inbox tab and obvious). One shared flow, three doors.
3. **Provenance for the physical case:** a manual accountant upload should record *who* entered it and read honestly in Received via ("Uploaded by {accountant}" / "Manual — practice"), distinct from client channels — this is item 21's channel sweep meeting item 43's uploader identity, on the practice side. Optional but valuable for his stated scenario: a "received on paper / personal channel" note at upload (the item-11 `note` seam already carries display-name words).
4. **Camera capture for paper:** the portal has a Capture surface; the practice app doesn't. If accountants really take paper at meetings, a capture-from-webcam/phone path on the practice side is the natural follow-on — note it for Shakib as scope, don't assume it.

**✅ RESOLVED (5 Sep 2026, PR #260 — the channel-provenance package; gaps 2 and 3, while 4 stays with Shakib as scope).**

**What was done:** the client's **Documents tab** has the upload door now — the same button + drag-drop the Costs tab has, through the one shared flow (`runWorkspaceDrop` live, the local `ingest` synthetic), so paper handed over at a meeting is entered from the register it lands in (screenshot `07`). ⚠ One real bug found and fixed on the way: a `FileList` is live and the input clears itself, so the files are snapshotted synchronously — deferred past the lazy import, the door uploaded nothing while looking like it worked. The **Inboxes screen's visible Upload button already existed** (header, every tab, `data-tour="inboxes-upload"`) — verified, unchanged. **Provenance for the physical case:** a workspace completion now writes `Uploaded by {accountant}` from the session's own actor (HUMAN users with a name only — a SYSTEM actor writes nothing), and Received via renders it: the register and Costs cells read **"Uploaded by Shakib Rahman"** distinct from every client channel (screenshot `03`), and the preview header says it standing alone — **UPLOADED BY SHAKIB RAHMAN**, not "VIA UPLOADED BY…" (screenshot `08`). Pinned in `web-upload.service.test.ts` and `channelLabels.test.ts`. **Left for Shakib, deliberately:** the optional "received on paper / personal channel" note at upload (the seam exists — `DocumentUploadRequest.description` rides the claims — but a per-drop note prompt is a UX decision, not a cheap add), and practice-side camera capture (out of scope per the brief).

## Item 63 — The Chases tab should list every missing document the statement analysis found

**Original (verbatim):**
> All missing files should be seen here in the chase tab, the ai will know some file is missing by analyzing the bak statement

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 04.54.00.jpeg`-family (Image #48) — Zeplow's client screen with the tab row visible (Chases among them); the ask is about what the **Chases** tab shows.

**Brief:**
The detection already exists — an unexplained bank line (unmatched + non-suppressed, the `isUnexplained` predicate / the server's `missing` count) *is* the product's definition of a missing document — but that list only surfaces when composing a chase (the chat cards, the Bank-tab selection) or as bare counts. Mubashir wants the client's **Chases tab** to lead with it: every missing document from the statement analysis listed as rows — supplier/descriptor, date, amount, how long it's been missing — each carrying a chase affordance, alongside (and feeding) the sent-chases the tab already shows.

Shape:
1. **A "Missing" section on the Chases tab** reading the same unexplained set every other surface reads (package A's one-predicate rule — this tab must not mint a seventh definition). Rows → select → stage the real `chase.send` per business (item 15's seam, already built for the Bank tab; this is the same action from a second door).
2. **Items already being chased are marked, not re-listed as missing** — the open chase's items and the missing list must reconcile (a line inside an open chase shows "chased on {date}, awaiting reply" rather than appearing chaseable again — item 30's lesson from the other direction).
3. Depends on package A's data-truth fixes landing first: putting the missing list on a third surface while the underlying set disagrees across surfaces would just spread the disagreement. Sequence: fix the predicate/plumbing (A), then this tab renders it.

**✅ RESOLVED (6 Sep 2026, this branch — the matching-lane package #255 had landed, so the
predicate was safe to put on a third surface).**

**What was done:** live, the client's Chases tab now LEADS with **Missing documents** — every
unexplained bank line for this client, read through `isUnexplained` (the ONE predicate, #255's
rule; this tab minted no seventh definition), with descriptor, date, amount and a **days-missing**
pill (amber ≥14d, red ≥30d). Each row carries a Chase button and the selection has a bulk **Chase
selected** — both stage item 15's real server-composed `chase.send` (`requestChaseProposal`, the
same action the Bank tab stages; a second door, never a second engine), with the queued/failed
banner reporting the outcome. **A line inside an OPEN chase is marked, not re-offered**: it stays
listed (the paperwork has not arrived) reading *"Chased {date}, awaiting reply"* with no chase
button, and a selection that contains only such lines refuses with words instead of double-asking
— reconciled against the same `useChases` read whose poll clears the marks when auto-close
settles a chase. Below it, **Chases sent** lists this client's chases with honest state pills
(Awaiting reply / Received / Closed), item count, sent date and the closed reason.

**Where it landed:** `views/ClientChases.tsx`, a NEW lazy chunk — `api/chases.ts` and the
generated chases client stay off the ClientDetailView route's arrival weight (the route sits
~1.5 kB under its 250 kB budget), the ClientSupplierStatements precedent. The tab forks on
`slices.bankTransactions.source === 'api'`; synthetic keeps the seeded MissingItem table
byte-for-byte. A failed bank read renders the honest alert, never "nothing is missing" over
unread data (item 25's rule). Pinned in `ClientChases.test.tsx` (the predicate, the marked-line
rule, the real staging, the refusal alert, the unread-data honesty, the state pills).

## Item 64 — Setup-link panel still shown for an active client; replace it with something useful

**Original (verbatim):**
> If the client accounting is active via the link or the accounting is in use by the client then Whats the point it in client->settings ? Remove this section and think something ore useful to put here

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep — Image #49) — client → Settings → **Client setup link** panel: "The setup link was emailed when this client was added. Signing in with it is how they register and subscribe." Sent to / Sent 04 Sep 2026 / Expires 7 days — with a **Resend link** button — for a client that has already registered, subscribed and is actively using the portal.

**Brief:**
`SetupLinkLivePanel` (built 5 Sep, ClientDetailView Settings tab) renders unconditionally; the setup link's whole job ends the moment the client registers and subscribes — after that it's noise, and Resend is a button whose action is pointless-to-confusing (re-inviting an active client). Fix in two moves:
1. **Gate on onboarding state:** the server already knows the client's standing (`BusinessSummary` subscription status; whether a portal member has verified). While un-onboarded → today's panel. Once active → the panel goes.
2. **What replaces it — "Portal access" status card** (his "think something more useful"): portal state at a glance — subscription status (already on the Plan panel, so keep it one-line here), portal members count with a link to the client's People (via item 42's surface), last portal activity/upload if the data exists, and the re-invite affordance demoted to an edge-case action ("invite another contact" — the real `inviteBusinessMember`, which is what Resend actually wraps). Nothing invented: every line must come from data the server already serves, or be left out.
Cross-ref: item 39's matrix decides who sees this card; the honest-data rule (no fabricated "last active" if nothing records it) is the standing one.

**✅ RESOLVED (5 Sep 2026, branch `fix/review-items-17-45-64`).**

**What was done:** the Settings tab forks on the served subscription status (`BusinessSummary.subscription.status`, carried onto the local `Client` shape as display-only `subscriptionStatus`). No status — or `INCOMPLETE`/`INCOMPLETE_EXPIRED`, a checkout started and never paid — keeps today's setup-link panel (screenshot 04). Any status that means a subscription EXISTED at Stripe (`ACTIVE`/`TRIALING`/`PAST_DUE`/`CANCELED`/`UNPAID`/`PAUSED` — only the registered client's own checkout creates one) replaces it with the **Portal access** card (screenshot 03): subscription state in one line wearing the portal Plan panel's own status words, the registered contact email, the setup-link sent date when one exists, and the re-invite demoted to a bordered "Invite another contact" edge-case action (the same `inviteBusinessMember` wrap Resend used — create-if-absent means a fresh invite IS the re-send; the shared logic lives in `useSetupInvite`). A lapse is said plainly and agrees with the portal's own Plan panel: *"The subscription is not running, so the client cannot send new documents. They can still sign in and see what they have sent"* (reading survives a lapse, D32).

**Omitted, per the honest-data rule:** portal members COUNT and last portal activity. `GET /businesses/{businessId}/members` exists in the contract but has no wired practice-side read surface (and the card sits on `ClientDetailView`'s ~2.4 kB bundle headroom — the change measured +967 B gzip); last portal activity has no contract surface at all. Both are gaps to note, not facts to invent. Synthetic mode untouched (METH_MODE §1). Gate, card, lapse wording and the INCOMPLETE edge pinned in `ClientDetailView.test.tsx`.

## Item 65 — "Ask about this client" prompts are static; suggest only what has substance, and propose tasks proactively

**Original (verbatim):**
> The ai must understand what must be done for this client and will present the prompt here for the accountant to give suggestions, I clicked the "which items are waiting on approval" and it showed me nothing; if nothing is waiting for approval then why show it? And this is not about the only this prompt; ai must analyze the user give task suggestion for the client here

**Image:**
- `C:\Users\shaki\Downloads\` (WhatsApp image, 5 Sep — Image #50) — client → **AI** tab: "Ask about this client" with three fixed prompts (What is still missing / Show the bank matches / Which items are waiting on approval), and a past conversation "Which items are waiting on approva… · 2 messages" that answered nothing.

**Brief:**
The AI tab's suggested prompts are a static list, offered regardless of whether the answer has any substance — clicking "Which items are waiting on approval?" for a client with zero pending approvals yields an empty answer, which reads as the AI failing rather than the queue being empty. Two asks:
1. **Data-aware suggestions:** the chips should be generated from the client's actual state — the counts are already served (`BusinessSummary`: toReview, missing, unmatched, approvals, overdue…), so offer "3 items are waiting on approval — review them?" and simply don't offer the approvals question when the count is 0. A suggestion is a claim there's something to see; only make true claims. (Cheap version: filter/parameterise the existing static list by the counts. No model call needed for the chips themselves.)
2. **Proactive task suggestions:** beyond Q&A chips, an "what needs doing for {client}" analysis — the AI reads the client's pipeline state and proposes next actions (chase these 4 missing documents, review the 2 low-confidence extractions, the statement for August is missing, export July) with each suggestion linking to the surface or staging the relevant proposal. This is the same grounded §9 read the MISSING/approvals intents already do, composed into a summary — and it must obey the item-25 rule: derived from actually-read data, honest when the read fails, never a confident guess. Depends on package A's data truth for the numbers to be worth showing.
Also check why the clicked prompt's answer was literally "nothing" — an empty-set answer should still be a sentence ("Nothing is waiting on approval for Zeplow Inc.") rather than a blank card; if it rendered blank, that's a rendering bug in the approvals card (`SHOW_APPROVALS`, added in the items-9/12 second pass) to fix regardless.

**✅ RESOLVED (6 Sep 2026, this branch — the smaller version, as the brief asked; no new server
surface, no model call).**

1. **The chips are data-aware.** The static three are gone; the chips derive from the SAME served
   counts every surface reads (`statsFor` — live, `BusinessSummary.counts`), each carrying its
   number as the claim: *"3 items are waiting on approval — review them?"*, *"4 documents are
   missing — what is still missing for {client}?"*, plus to-review and overdue. **A zero-count
   question is simply not offered**; all-zeros renders *"Nothing is waiting on {client} right
   now"*. The chip's words are the utterance the real chat lane answers (#255's drill-in bridge —
   live they submit through `POST /chat/turns`, synthetic keeps the injected card). The old
   "Show the bank matches" chip retired: no served count exists to make its claim true, and the
   Bank tab is one todo-link away. Item 25's rule enforced: live with the businesses slice unread,
   both panels render *"the counts could not be read, so no suggestions are offered"* instead of
   zeros dressed as an all-clear.
2. **"What needs doing" is a new panel, first on the tab** — next actions composed from the same
   counts, each opening the surface where it is done: chase N missing → the Chases tab (now
   leading with the missing list, item 63), review N in the inbox → Costs, decide N approvals →
   the Approvals queue, release N Ready for export → Costs → Ready, nudge N overdue → Chases.
   Honest empty: *"Nothing needs doing for {client} right now."* **The smaller version was chosen
   deliberately** (the brief's own instruction): composition over already-served counts, no model
   call, no new server surface. The full §9 model-composed narrative ("the statement for August
   is missing…") stays a named follow-up — it needs facts (per-month statement coverage,
   low-confidence extractions) no count currently serves.
3. **The bug check: SHOW_APPROVALS's empty state was verified NOT blank** — the card renders
   *"The approval queue is empty."* plus the always-present "Open the Approvals queue" button
   (the real queue reads `GET /action-proposals` itself). The reviewer's blank answer predates
   item 9's SHOW_APPROVALS card (5 Sep). Now pinned in `IntentRenderer.test.tsx` so it cannot
   regress to silence; the chips fix means the question is no longer offered at zero anyway.

## Item 66 — The approval matrix: draw the line between what needs super-admin approval and what doesn't

**Original (verbatim):**
> everything goes to the approval tabs, but the super admin needs no approving, also define activity that is must get approval, such as any publishing, any filed update like the category, ths things and this typo things must need approval from super admin; prepare a fine line and divide it that what needs approval what not

**Image:** none provided.

**Brief:**
The completion of item 26's ruling, generalised: today **every** proposal kind rides the same Review → Approve queue regardless of who acts or what's at stake, which produces both his complaints at once — the super admin approving their own trivial edits, and no stated policy on what genuinely demands the super admin. The deliverable is an **approval matrix**: every action in the product classified, with the rules enforced server-side.

The taxonomy to draft (his examples slotted in):
1. **Super-admin approval required, always** (regardless of who staged it): releasing for export (`publish.batch` — already the rule, D44), field updates that change accounting meaning — category/coding changes, money-field corrections (his "any filed update like the category… must need approval"), statement removal, document purge, client offboarding, rule creation.
2. **Review → Approve by any member** (or the proposer's own second look): the lighter proposal kinds, if any survive this sort — the matrix should say explicitly which kinds sit here, or collapse this tier into 1 or 3.
3. **No approval needed:** ingest-class operations (uploads, intake, routing?, chases?) — some already bypass the spine by design (`x-nt-side-effect: ingest`); the matrix should ratify each one deliberately rather than by history. His "typo things" reading cuts both ways — he says typo-class field fixes **must** need approval; the matrix should test that against volume (if every typo needs the super admin, the queue drowns — maybe non-financial fields (supplier spelling) sit in tier 2/3 while financial fields (category, totals, dates) sit in tier 1). Put both options in the doc and let him and Shakib pick.
4. **The super-admin exception (item 26's fast path):** when the actor **is** the super admin, tier-1 actions don't queue — the same Review → Approve record is made inline in one flow (stage → read review → approve in the dialog), so the audit spine survives and nothing waits. Never a silent bypass: the review record is the point.

**Constraints that bound the design:** Governance §10 (no state change outside the ActionProposal path — enforced server-side and by DB trigger) means every tier-1/2 action keeps the proposal record; the matrix changes *who may approve* and *whether it queues*, never whether it's recorded. This is Governance + auth territory — **the deliverable is the matrix document for Shakib's sign-off** (it amends §10's operational reading), then `assert-can.ts` and the proposal kinds implement it. Direct dependency of items 26 (dedupe/fast path), 27 (deny flow — the deny power follows the approve power per tier), and 39 (the role capability matrix — these two matrices should ship as one document: who sees/does what, and what of it needs whose approval).

**✅ RESOLVED (6 Sep 2026, package G).** The deliverable is
`docs/Access_and_Approval_Matrix.md` **Part 2**, with Shakib's four rulings
recorded inline, and the code that implements it.

**The three tiers, all classified.**

- **Tier 1 — the super admin signs. Seven kinds.** `chase.send` and
  `publish.batch` (D44's two, unchanged) plus five that moved up:
  `document.update-coding`, `bank.remove-statement`, `document.purge`,
  `business.offboard`, `rule.create`.
- **Tier 2 — any member. Nine kinds**, each with its reason. The tier is
  deliberately NOT collapsed: those are the approvals an accountant does all
  day, and collapsing them is the queue-drowning you complained about in the
  same breath.
- **Tier 3 — no proposal at all.** All 33 `x-nt-side-effect: ingest`
  operations, ratified in six groups. `createExport` carries a real argument
  rather than a listing: it physically produces the VT file, but it can only
  contain documents that already passed a tier-1 approval, and asking for the
  same signature twice makes the second one mean less.

**⚠ What changed is the QUESTION the table asks.** `RELEASE_KINDS` selected for
*acts that reach outside the product*; item 66 asks *whose signature does this
carry*, of which "outward and irreversible" is one answer among several. Five
kinds moved and **three of them overturn arguments written in this repo** —
`document.purge`, `bank.remove-statement`, `business.offboard`. Each reversal is
named at its own entry in `assert-can.ts` rather than silently replaced, and the
executor refusals that were the old argument's strongest point (a purge cannot
touch an exported document, by anybody) are untouched and now sit alongside the
gate instead of standing in for it.

**Your "typo things" ambiguity — ⚖5, ruled (a), the LITERAL reading.** Every
`document.update-coding` is tier 1, whatever field it touches: a
supplier-spelling fix waits for the super admin exactly as a category change
does. The field split (accounting meaning tier 1, labels tier 2) was tabled and
declined, and is kept in the matrix as the change to make if the queue ever does
drown. The volume objection is answered by the fast path, not by narrowing the
rule — the person the queue waits for is also the person doing most of the
correcting, and their own corrections never queue.

**The super-admin fast path — ⚖6.** A tier-1 action staged by the super admin
does not QUEUE; the same stage → Read review → Approve happens inline and the
record is byte-for-byte identical. Never an auto-approve.

**`proposal.approve` is the seventh `PermittedAction`** — the same predicate as
`publish.release`, its own name, its own per-kind sentence, because *"Only your
practice's super admin can release documents for export"* said to somebody who
pressed Approve on a category fix is a wrong answer in a right status code. Each
tier-1 sentence also says the act is QUEUED: under ⚖5 an ordinary standard user
now lands there, and "you may not" alone would leave them believing the fix was
lost.

**Governance §10 is untouched throughout.** Every kind in both tiers still mints
a proposal, records Read review and its hash, echoes it at Approve, writes the
audit row, and is enforced again by `action_proposals_guard()`. This Part
decides who may press Approve and whether it waits, never whether it is
recorded.

Pinned by a test that asserts the tier-1 list WHOLE and sorted against the
matrix's seven, so a promotion nobody meant fails there rather than shipping.

---

## Item 67 — Deleting a client orphans their documents; deletion must ask its scope, and a deleted client goes to a recoverable Trash

**Original (verbatim):**
> One client was deleted but their document is still here, while deleting a user ask to select what they want to delete, full user and data, user only, keep files etc. ; in the trash keep the client too for some days if any reason the client gets back the accountant can restart work form where left

**Image:**
- `C:\Users\shaki\Downloads\WhatsApp Image 2026-09-05 at 05.04.25.jpeg` — the review board after a client deletion: three To-Review rows whose CLIENT column reads the **raw CUID** `cmtndidpz003y96czwm24v0vc` (Biffa + the two B C Window Cleaning duplicates) — the business row is gone, its documents remain, and every surface that resolves the client name now falls through to the id.

**Brief:**
Three layers:
1. **Bug, immediate:** documents survive their business's deletion as orphans, and `clientNameFor`'s fall-through renders the raw id on the board. Whatever else is decided, orphaned rows must never render a CUID as a client name — and the deeper question is what `business.offboard`'s executor actually does today (it evidently removes/hides the business row while leaving documents live in the pipeline; check whether that half-state is the executor's design or its bug — an offboarded client's documents still sitting in To Review with publish affordances is wrong under any policy).
2. **Deletion scope choice:** offboarding should ask what it means — his options: **full client and all data** / **client only, keep the files** / (implicitly) archive-everything. The honest set needs the D32 constraint stated: export-at-cancellation is a product promise (reading and exporting survive a lapse), and UK bookkeeping records carry statutory retention duties — so "delete all data" likely means "schedule for deletion after the retention answer", not an instant purge. The chosen scope rides the `business.offboard` proposal and is stated verbatim at Read review (blast radius: N documents, M transactions, the portal members who lose access).
3. **Client-level Trash with a recovery window:** a deleted client held restorable for a stated period, so a returning client resumes where they left — the same retention-policy decision as item 61's document Trash (one policy document covering both: durations, what auto-purge skips, D43's exported-document refusal, and the subscription question — a restored client's Stripe subscription state needs defining too).
⚠ All three touch **deleting/migrating data** — root CLAUDE.md stop-and-ask territory, and the retention/GDPR angle makes this Shakib sign-off before any PR. Files with items 61 (retention policy) and 27/66 (the offboard proposal's approval tier).

**✅ RESOLVED (7 Sep 2026, package L — with item 61), all three layers.** Evidence in `assets/2026-09-07-retention-deletion/`. Shakib ruled the three product questions in session; `docs/Retention_and_Deletion_Policy.md` records each with its date.

**1 · The bug, and its root cause was not the renderer.** `business.offboard` removed the client from `GET /businesses` and said *nothing whatsoever* about the client's documents. They stayed on every practice-wide board — in To Review, still offering Publish — under a CLIENT column whose dictionary no longer held the id, which is why it rendered `cmtndidpz003y96czwm24v0vc`. The cuid was the symptom; **an offboarded client's documents sitting in a working queue is wrong under any deletion policy** and that is what was fixed. `GET /documents` and `GET /documents/counts` now serve **live clients by default**, the same rule the businesses list has always kept, said once more one table over — and a caller who names a `businessId` still reaches a removed client's documents, which is how the client's own screens and its Trash work. ⚠ The `businessId: null` arm of that filter is load-bearing rather than defensive: an unrouted document has no business, and Prisma's `is:` on an optional to-one would have emptied the Unrouted queue. `clientNameFor` no longer falls through to the id either — it answers *"No longer on your client list"*, because every remaining way to reach that branch is a workspace that WAS reachable. Walked live: the board carries no orphan and no raw id (screenshot `04`).

**2 · Deletion scope, ruled: three options, and every one of them reversible.** `BusinessOffboardPayload.documentScope` — `keep` (the default and the old behaviour) / `trash` (every document not already deleted goes through the same reversible `deleted_at` seam `POST /documents/{id}/deletion` writes) / `mark-for-erasure`. "Delete all data" is not among them and cannot be: D12 holds the books six years, D32 promises reading and exporting survive a lapse, D43 refuses to purge anything an export links to. ⚠ **`mark-for-erasure` is a FLAG, NOT A TIMER** — Shakib ruled *erasure on request, no automatic date*, because any window shorter than D12 would be this product deleting a UK practice's statutory records on a timer nobody watched. Every surface says **marked**, never *scheduled*, and a test pins the absence of a date. The blast radius is stated before the proposal is queued (*"This client has 17 documents"*, screenshot `01`) and again on the review card the super admin echoes (screenshot `03`). ⚠ A document ALREADY in Trash keeps its own `deleted_at`, so the retention window it is serving is not silently restarted by an offboard sweeping past it.

**3 · Client-level Trash, ruled: build the listing AND the restore.** Two contract deltas, both approved in session: an `active` query parameter on `GET /businesses` (`false` is the Removed listing, the `deleted` precedent one resource over) and the **`business.reactivate`** proposal kind. `assert-can.ts`'s standing note — *"there is no `business.reactivate` kind yet, so the undo is a later surface"* — is finally answered, and the tier does **not** move: it is **tier 1**, because the undo of a tier-1 act belongs to the same signature, and a standard user who could restore a client the super admin removed would make that removal a suggestion with a delay on it. **Clients → Removed** lists them with the removal date and the days remaining; `businesses.offboarded_at` is the new nullable column the window counts from, and a workspace offboarded before it existed reads as a restore offer with no countdown rather than a back-dated guess. ⚠ **Nothing is erased when the window lapses** — the client stops being one click away and that is all; the panel says so, and a test pins it, because a row that simply stopped offering a button would read as a countdown to destruction.

⚠ **`business.reactivate` deliberately does NOT restore documents**, and the review card says so (screenshot `06`). `documents.deleted_at` records THAT a document was deleted, not which act deleted it, so a blanket restore would also resurrect everything a person had trashed on purpose weeks earlier; the executor cannot tell those apart and a link table bought to automate one click is not worth a schema. ⚠ **The walkthrough corrected our own copy on this point**: a removed client's screens do not render at all (the board's `clients` array is the active listing, and giving `ClientDetailView` a second read to resolve a removed one would put bytes on the tightest route in the product), so the Trash is reachable again only *after* the client is. The dialog said "restorable one by one from this client's Trash" — true about the documents, false about when — and now says *"Restore the client and each one is restorable from their Trash, for 30 days from today."*

**Walked end to end, live, and the demo database was left exactly as it was found** (0 trashed documents, 0 offboarded businesses; the immutable proposal rows remain, as they must): offboard with the trash scope → review card naming the scope → approve → 17 documents in the client's Trash and the client gone from every board with no cuid anywhere → **Removed clients** showing *"Removed 07/09/2026 · 30 days left to restore in one click"* → Restore → review card → approve → the client back on the board → bulk Restore in its Trash → **Register 17**, Trash empty.

**Route budgets, paired A/B, both sides built with `pnpm exec vite build --manifest` and walked with `/c/tmp/nt-measure/closure.mjs`:**

| Route | main | this branch | Δ | headroom |
|---|---|---|---|---|
| `ClientDetailView` | 247,774 | **245,313** | **−2,461** | 4,687 B |
| `InboxesView` | 249,317 | **249,495** | **+178** | **505 B** |
| `ClientsView` | 242,147 | **242,567** | +420 | 7,433 B |
| `DocumentsView` | 230,986 | **231,241** | +255 | 18,759 B |
| floor | 207,970 | 208,061 | +91 | — |

`ClientDetailView` — the route this work lives on — **gave back** 2,461 B, because `OffboardClientDialog` went lazy in the same change and both new screens (`ClientTrashPanel`, `RemovedClientsPanel`) are their own chunks. ⚠ **`InboxesView` is the binding constraint now and I spent 178 B of its 683**: +91 B is the floor (one message descriptor on `AppContext`, the last thing standing between a cuid and the CLIENT column) and the rest is `proposals.ts` growing two entries for the new kind, which that route pays for because it imports the module. It is under budget and it is tight; the next change on that route is spending against **505 B**.

**Left open, deliberately, and recorded in the policy document rather than assumed:** the stored objects are still not reclaimed by any purge (an object-lifecycle sweep does not exist); the surface that actually performs an audited erasure after the retention duty lapses is not built and needs its own ruling, starting with who may approve it; and **a restored client's Stripe subscription state (D48) is undefined** — `business.reactivate` touches no billing column rather than guessing, and that is the one question in this package still owed an answer.

---

## The seed was lying to the contract — five defects, found and FIXED (6 Sep 2026)

⚠ **Not regressions and not part of package G's five items** — found while
walking review item 20, because item 20's success path could not be reached at
all. Between them they made **the whole document-detail surface unusable on any
seeded database**, and they had been that way long enough that nobody had
walked it. All five are fixed in `prisma/seed.ts`, in this branch.

The visible symptom was every document reading **"No fields extracted — The
server answer did not match the contract"**, which takes the manual-correction
flow, the coding-suggestion panel, the Path-to-Ready panel and the D46 flag with
it. `api/document-detail.ts` fails closed, correctly; there was simply nothing
to render.

| # | What the seed wrote | What the contract requires | Consequence |
|---|---|---|---|
| 1 | `byteHash: 'sha256:<id>000…'` | `^[a-f0-9]{64}$` | 64 characters, not one of them a match — every `GET /documents/{id}` failed its parse |
| 2 | field keys `supplier` / `total` / `tax` | the header names `supplierName` / `totalPence` / `taxPence` | no screen reads those keys; `FIELD_PRESENTATION` and the extractor's own `demo-profiles.ts` use the contract's |
| 3 | `provenance: 'textract:block/12'` | `ProvenanceClass` — `HUMAN_CONFIRMED` / `DETERMINISTIC` / `AI_SUGGESTED` | a plausible-looking source pointer where an enum was required; every `ExtractedField` failed on it |
| 4 | line items carrying raw values | an `ExtractedField` per member | the same parse, one level down |
| 5 | a `contextQuestionnaire` of `sells` / `revenueStreams` / `companyCards` | `BusinessContextQuestionnaire`, which requires `businessActivity` | `readBusinessProfile` answered **null for every seeded client** — see below |

⚠ **I got one thing wrong in the first pass and it is worth correcting here:**
`lineItems` living INSIDE `fields` is *not* a defect. It is the storage
convention `extraction-pipeline.ts` uses and `toExtraction` separates on the way
out — its own header explains why. Only the members' shape (#4) was wrong.

**Defect 5 is the interesting one, because it was silent in two more places.**
A profile-less client gets the `NO_PROFILE` chart: the 37 core accounts and none
of the trade additions. So:

- **a restaurant had no `COS_FOOD_AND_DRINK`**, and a correction naming one was
  refused as *"not a code on this client's chart"* — item 47's refuse-never-fuzzy
  rule working exactly as designed against data that had lied to it;
- **the coding ladder (items 19/48) had no trade context for any demo client**,
  so the surface built to demonstrate trade-aware coding was demonstrating the
  generic path.

Two more things went with it:

- **The seeded "Xero" chart of accounts is deleted.** It was a METH Stage 5
  DEMO-MOCK for a reference-list sync engine D42 removed from this release, and
  it had stopped governing anything: its payload predates the `neoting` block
  `StoredChartSchema` requires, so every read logged *"chart_of_accounts for
  business biz_burger did not parse — serving the derived chart, not
  overwriting"*. Its only remaining effect was that warning plus a `psql` answer
  that disagreed with the product. With no row, `ChartOfAccountsService` takes
  its derive-and-SEED path and the demo cast gets the trade-matched UK chart
  every client created since A11 already gets.
- **The documents' `categoryCode` values are chart CODES now**, not display
  names. `'Cost of Sales — Food'` was never on any chart, so seeded documents
  were coded against something that had never existed — which also means they
  resolved to no Analysis account in the export. They carry
  `COS_FOOD_AND_DRINK`, `LIGHT_HEAT_AND_POWER`, `COS_PURCHASES`, `SALES`,
  `SOFTWARE_AND_SUBSCRIPTIONS` and `PROFESSIONAL_FEES` now. ⚠ The VAULT rows'
  `category` is a folder label, not a nominal account, and is untouched.

**Verified after the fix, live:** the document detail renders its seven fields
with confidences and provenance; `biz_burger`'s chart derives and PERSISTS as
`RETAIL_AND_HOSPITALITY`; a correction to `COS_FOOD_AND_DRINK` is accepted,
files as *"Confirmed by you"*, and moves the document to READY. Both API (2,638)
and web (901) suites pass on the reseeded database.
