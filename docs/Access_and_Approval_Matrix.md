# Access and Approval Matrix

**Status:** Part 1 (visibility and action) drafted 6 Sep 2026 for review item 39;
Shakib's rulings recorded inline at the gates marked ⚖, and **every ⚑ cell in the
tables below has since SHIPPED** in the same package (review items 38, 39, 41,
42, 44, 57 — branch `fix/access-control-38-39-41-42-44-57`, evidence in
`docs/reviews/assets/2026-09-06-access-control/`). The ⚑ marks are kept rather
than cleared: they are the record of what this document changed, and a reader
comparing the table to the code should be able to see which cells were the
argument. **Part 2 (approval tiers) landed 6 Sep 2026 in this same file** —
review item 66 / package G, with Shakib's four rulings recorded at gates ⚖5–⚖8
and the finding at ⚖9.

**Standing:** SoT-adjacent. It does not amend the Source of Truth; it states, in
one place, what the code already enforces, and names every cell where the code
and the product disagree. Governance §11.2 is the rule it serves:

> `assertCan(actor, 'publish.release', resource)` **in the service layer** … *a
> UI that merely hides the button is not an implementation of this.*

So every row below has a SERVER column. The web column is presentation only, and
its only job is to be honest about what the server will say.

---

## The two sanctioned degraded shapes, and nothing else

A surface a role may not use gets exactly one of these. A third shape — a
control that looks available and refuses at the end — is the defect item 39
reported, and it is not permitted anywhere in this table.

| Shape | When | What it looks like |
|---|---|---|
| **hidden** | The surface is *not this role's job at all* — showing it teaches nothing and invites a refusal | The entry is absent from the list/nav. A deep link to it falls back to something the role can use, never a blank panel or a 403 page |
| **visible-but-disabled-with-reason** | The role can legitimately *read* the surface, and the fact that somebody else can act on it is information they need | The control renders disabled, carrying the reason and naming who can (title/hint/`role="alert"` line). The list itself stays readable |

**Which one applies is a product judgement, not a technical one**, and the
existing precedents split cleanly:

- *Who else can send paperwork on your employer's behalf is not a secret from
  you* → portal People is **disabled-with-reason** for a member.
- *Billing is not a member's job* → portal Plan is **hidden** (item 44).

The rule of thumb this table applies: **hide when the role has no legitimate
interest in the fact; disable-with-reason when they do.**

---

## The roles, as the database actually holds them

`WorkspaceRole` has six members and they partition into practice-level and
business-level. What matters for this table is that **two of the shapes below are
not roles at all — they are membership SCOPES**, and one of them is what item 39
actually hit.

### Practice side — `memberships`

| # | Name in this doc | `role` | `is_owner` | membership shape | Exists today? |
|---|---|---|---|---|---|
| P1 | **Super admin (owner)** | `PRACTICE_ADMIN` | `true` | practice-wide (`practice_id` set, `business_id` null) | Yes — signup writes exactly one |
| P2 | *Practice admin, not owner* | `PRACTICE_ADMIN` | `false` | practice-wide | **No.** No code path mints one; the invite boundary refuses `PRACTICE_ADMIN` by name |
| P3 | **Standard user (all clients)** | `PRACTICE_STANDARD` | `false` | practice-wide | Yes — invited with no client list |
| P4 | **Standard user (scoped)** | `PRACTICE_STANDARD` | `false` | **`practice_id` NULL**, one row per assigned client | Yes — invited with a client list |
| P5 | **Client admin** | `CLIENT_ADMIN` | `false` | practice-wide | Yes — always practice-wide by definition |

⚠ **P4 is the row this whole document exists for.** `invitation-acceptance.service.ts`
writes `practiceId: null` on a scoped colleague's memberships *deliberately* — it
is the mechanism that makes RLS confine them, because
`app_can_access_business`'s third branch would otherwise hand them every client
of any practice they hold a `practice_id` on. The consequence nobody had written
down: **`loadScopeForUser` then produces a `ScopeContext` with no `practiceId`,
so `GET /me` answers `practice: null`, and every server predicate of the form
`ctx.practiceId === undefined` refuses them.** They are practice staff whose
session carries no practice. See gate ⚖1.

### Portal side — `contacts.portal_role`

| # | Name in this doc | `portal_role` | Screen word |
|---|---|---|---|
| B1 | **Owner** | `BUSINESS_ADMIN` | "Owner" |
| B2 | **User administrator** | `USER_ADMIN` | "User administrator" |
| B3 | **Member** | `BUSINESS_STANDARD` | "Member" |
| B4 | *Chase-link holder* | — (`otp_sessions.contact_id` null) | not a person; the link is forwardable by design |

Derivation for rows written before the column existed: `is_primary` → Owner,
everybody else → Member (`effectivePortalRole`). `portal_role` wins once set.

---

## Part 1a — practice surfaces

Legend: **✔** can · **✖** cannot · **hidden** / **disabled** = the degraded shape
the web must use · ⚑ = **this cell changes**, with the item that changes it.

| Surface | Server predicate today | P1 owner | P3 standard, all clients | P4 standard, scoped | P5 client admin |
|---|---|---|---|---|---|
| See the Clients board | RLS | ✔ all | ✔ all | ✔ **their list only** | ✔ all |
| **Add a client** (intake, 3 steps) | `ctx.practiceId !== undefined` | ✔ | ✔ | ✖ → ⚑ **hidden** (item 39) | ✔ |
| See Team → Colleagues | `ctx.practiceId !== undefined` | ✔ | ✔ | ✖ 403 → ⚑ **hidden** (item 39) | ✔ |
| **Invite a colleague** | `assertCan('team.invite')` = `canRelease(role)` | ✔ | ✖ **disabled** | ✖ hidden with the tab | ✖ **disabled** |
| Invite as `PRACTICE_ADMIN` | refused by name, `NT-VAL-001` | ✖ | ✖ | ✖ | ✖ |
| **Edit a colleague** (role, client list) | ⚑ none — no operation (item 57) | ⚑ ✔ | ⚑ ✖ disabled | ⚑ hidden | ⚑ ✖ disabled |
| **Remove a colleague** | ⚑ none — no operation (item 57) | ⚑ ✔ | ⚑ ✖ disabled | ⚑ hidden | ⚑ ✖ disabled |
| **Revoke / re-send an invitation** | ⚑ none — no operation (item 57) | ⚑ ✔ | ⚑ ✖ disabled | ⚑ hidden | ⚑ ✖ disabled |
| Compose any proposal (code, correct, draft a chase) | none beyond RLS — D44's compose half | ✔ | ✔ | ✔ (their clients) | ✔ |
| Read review on any proposal | RLS only | ✔ | ✔ | ✔ | ✔ |
| **Approve a TIER-1 kind** (Part 2 — seven of them) | `assertCan('publish.release'` / `'proposal.approve')` = `canRelease && isOwner` | ✔ | ✖ **disabled** | ✖ **disabled** | ✖ **disabled** |
| Approve a **tier-2** kind | none beyond RLS | ✔ | ✔ | ✔ | ✔ |
| **Deny** a proposal (item 27) | ⚑ follows the kind's APPROVE authority | ⚑ ✔ | ⚑ tier 2 only | ⚑ tier 2 only | ⚑ tier 2 only |
| Export | RLS | ✔ | ✔ | ✔ (their clients) | ✔ |

**Two cells to read carefully:**

- *Add a client* is **not role-gated today, and this table does not propose
  making it one.** The refusal P4 meets is a SCOPE refusal wearing a role
  message. P3 — a plain standard user with practice-wide access — can add
  clients now and keeps that. See gate ⚖1.
- *Invite a colleague* is `canRelease(role)` **without** `isOwner`, deliberately:
  requiring ownership would make team management a bus factor of one, and an
  invitation grants nothing that can release. Since P2 cannot exist, P1 is the
  only role that passes it today.

## Part 1b — portal surfaces

| Surface | Server predicate today | B1 owner | B2 user admin | B3 member |
|---|---|---|---|---|
| Home / Upload / Capture | portal session + `canSendDocuments` | ✔ | ✔ | ✔ |
| Settings → Business (read the name) | portal session | ✔ | ✔ | ✔ |
| Settings → Business profile (**write**, setup journey) | `assertCan('business.profile.manage')` = `BUSINESS_ADMIN` | ✔ | ✖ | ✖ |
| **Settings → Plan (see the price and status)** | ⚑ **none** | ✔ | ⚑ **hidden** (item 44) | ⚑ **hidden** (item 44) |
| **Manage billing in Stripe / Start subscription** | ⚑ **none — any portal session passes** | ✔ | ⚑ ✖ **server refusal** (item 44) | ⚑ ✖ **server refusal** (item 44) |
| Settings → People (read the list) | portal session | ✔ | ✔ | ✔ **disabled**, with the line naming who can |
| Settings → People — add / **edit** / remove | `assertCan('business.people.manage')` = `BUSINESS_ADMIN \| USER_ADMIN` | ✔ | ✔ | ✖ **disabled** |
| Demote the last owner | refused, `NT-VAL-001` | ✖ | ✖ | ✖ |
| Remove yourself | refused | ✖ | ✖ | ✖ |
| Settings → Sending / Notifications / Security | portal session | ✔ | ✔ | ✔ |

⚠ **The Plan row is a live security hole, not a cosmetic one.**
`billing.controller.ts`'s `principalFor` checks that the portal session's
business equals the body's `businessId` **and nothing else**. Any member holding
a portal bearer — a staff member added to photograph receipts — can mint a
Stripe customer-portal session and reach the card, the invoices and
**cancellation**. That is item 44's real half and it lands regardless of what
the UI does.

---

## The gates — Shakib's rulings

### ⚖1 — Item 39: what does a scoped standard user (P4) see of Clients and Team?

The server predicate is `ctx.practiceId !== undefined`, which P4 fails *by
design*. Three things follow and each needs a ruling:

**(a) Should P4 be able to add a client at all?** The recommendation is **no,
unchanged** — a colleague scoped to two clients adding a third is granting
themselves access nobody decided to give. The fix is the entry point and the
message, not the predicate.

**(b) What shape does the refusal take?** Recommendation: **hidden** for the Add
Client button and the whole Team tab (adding a client is not their job; the
firm's staff list is not their business), rather than disabled-with-reason.

**(c) The message itself is wrong and must change either way.** *"Only a member
of an accounting practice can add a client"* is said to a person who **is** one.
Proposed replacement, naming the real reason and the fix:

> *Your access is limited to the clients you were assigned, so you cannot add new
> ones. Ask a practice admin at your firm.*

⚖ **Ruling (Shakib, 6 Sep 2026): (a) no — the predicate stands. (b) hidden —
the Add Client button and the whole Team tab are absent for a session whose
`practice` is null. (c) the message is replaced as proposed.** The third option
put to him — writing `practiceId` onto a scoped colleague's memberships so they
*could* add clients — was refused on the stated ground that it would defeat the
client list entirely: `app_can_access_business`'s practice branch would hand them
every client of the firm.

### ⚖2 — Item 44: which `PermittedAction` guards billing?

Two options, both `BUSINESS_ADMIN`-only:

1. **Reuse `business.profile.manage`.** Zero new names. Cost: the refusal reads
   *"Only an owner at your business can change its own details"* at somebody who
   pressed a billing button.
2. **Add `business.billing.manage`** as the fifth `PermittedAction`, same
   predicate, own message. Cost: one name, ~10 lines.

**Recommendation: (2)** — the message is the whole user-facing product of a
permission check, and conflating "state your company number" with "cancel the
subscription" is the kind of quiet widening `assert-can.ts`'s header exists to
prevent.

And the fact the web needs in order to hide the section: **add
`canManageBilling: boolean` to `PortalSummary`**, mirroring
`PortalPeople.canManagePeople` — *a fact for honest degradation, never a gate*.
The alternative (`access: WorkspaceRole` on the summary) serves more future cells
but tells the client's browser a role it has no other use for.

⚖ **Ruling (Shakib, 6 Sep 2026): option (2)** — `business.billing.manage` is the
fifth `PermittedAction`, `BUSINESS_ADMIN` only, with its own refusal message, and
`PortalSummary` gains `canManageBilling: boolean`.

### ⚖3 — Item 57: the practice member-management contract delta

None of these operations exist. All are additions to `packages/contracts`:

| Operation | Shape | Guards (server-enforced) |
|---|---|---|
| **Update a member** | `PATCH /v1/practice-members/{userId}` — `{role?, businessIds?}` | Owner cannot be demoted (D44: release authority must always exist). `businessIds` keeps the invite semantics **empty = all clients**. Changing scope rewrites the membership rows, so practice-wide ⇄ scoped is a real transition, not a field edit |
| **Remove a member** | `DELETE /v1/practice-members/{userId}` | Owner can never be removed. A member cannot remove themselves |
| **Revoke an invitation** | `DELETE /v1/invitations/{id}` | Kills the link before expiry |
| **Re-send an invitation** | `POST /v1/invitations/{id}/resend` | Fresh token, supersedes the old (the setup-link re-send precedent) |
| *(list change)* | `listPracticeMembers` also returns **expired** invitations | So an expired row can offer re-send. Today the contract says *"an expired one is not something to wait for"* — which was true when there was nothing to do about it |

**The open question that is explicitly Shakib's:** *may editing grant
`PRACTICE_ADMIN`?* Inviting one is refused by name, and the stated reason is
that an invited admin would hold `canRelease === true` and `isOwner === false` —
able to invite, unable to release, and told *"only your super admin can"* by a
screen that just labelled them an admin. **Recommendation: no — editing to
`PRACTICE_ADMIN` is refused for the same reason, until an ownership-transfer
operation exists.** Allowing it would create that contradictory state through a
second door.

⚖ **Ruling (Shakib, 6 Sep 2026): the full batch is approved as tabled, and
editing to `PRACTICE_ADMIN` is REFUSED** — the same refusal, for the same reason,
as the invite boundary's. It comes back the day an ownership-transfer operation
does.

### ⚖4 — Items 41/42: no ruling needed, a finding recorded

**Item 42's server and web API halves already exist.** `PATCH
/portal/people/{personId}` is contracted, implemented, and `api/portalPeople.ts`
exports `updatePerson`; `PortalPersonEditor` already renders the edit case
(title *"Change what they can do"*, email read-only with the reason, the
last-owner demote guard in `gateFor`). **The only missing piece is the pencil on
the row.** No contract delta, no new authority.

Item 41 is copy under the existing `access` select. The enum words are the
contract's and do not move.

---

## Part 2 — approval tiers

**Status:** drafted 6 Sep 2026 for review item 66 (package G). Shakib's rulings
recorded inline at the gates marked ⚖; ⚑ marks a cell this Part CHANGES.

**What this Part decides, and what it may not touch.** Governance §10's spine is
not up for negotiation here and nothing below moves it: every tier-1 and tier-2
action still mints an `ActionProposal`, still records `reviewedAt` and the
`rendered_summary_hash` at Read review, still echoes that hash at Approve, still
writes the audit row, and is still enforced twice — in `action-proposals.
service.ts` and again by `action_proposals_guard()` in the database. This Part
answers exactly two questions:

> **Who may press Approve, and does the action WAIT in a queue before somebody
> does?**

It never answers "is it recorded". Everything is recorded.

Mubashir's words, which are the requirement:

> *everything goes to the approval tabs, but the super admin needs no approving,
> also define activity that is must get approval, such as any publishing, any
> filed update like the category, ths things and this typo things must need
> approval from super admin; prepare a fine line and divide it that what needs
> approval what not*

---

### The three tiers

| Tier | Who approves | Does it queue? | Server predicate |
|---|---|---|---|
| **1** | The firm's **super admin** only | Only when somebody else staged it — see the fast path | `mayRelease(actor)` = `canRelease(role) && isOwner` |
| **2** | **Any member** of the practice who can see it | Yes, until any member decides it | RLS only — no `assertCan` |
| **3** | **Nobody** — there is no proposal | n/a | the operation's own authority check |

There is no fourth shape. An action that changes a client's books and is not in
tier 1 or tier 2 is a bug, not a design.

---

### Tier 1 — the super admin signs

`RELEASE_KINDS` in `assert-can.ts` is already the total, per-kind table this
extends. Five kinds change.

| Kind | Today | Part 2 | Why it is the principal's signature |
|---|---|---|---|
| `chase.send` | 1 | **1** | D44. A message to somebody else's client. Once sent, sent. |
| `publish.batch` | 1 | **1** | D44. Under D42 the export is the only egress, so this is the act that lets a figure leave the product. |
| `document.update-coding` — **accounting-meaning fields** | 2 | ⚑ **1** | Mubashir's *"any filed update like the category"*. Item 22 is the case law: a team member typed £9,000 of tax onto a £994 invoice and it reached the export because nobody with authority ever looked. Which fields — gate ⚖5. |
| `bank.remove-statement` | 2 | ⚑ **1** | Removing a statement removes every transaction it imported — the reconciliation surface a whole period's matching stands on. The executor's refusals (confirmed matches, open chases, unprovable provenance) stay; they are a different guarantee, not a substitute for a signature. |
| `document.purge` | 2 | ⚑ **1** | The only irreversible thing that can happen to a document. ⚠ **This overturns a recorded ruling** — see "Three rulings this Part overturns" below. |
| `business.offboard` | 2 | ⚑ **1** | Ending a client relationship. Soft today, but item 67 is about to give it a deletion SCOPE and a subscription consequence (D48), and a client's staff lose portal access the moment it executes. |
| `rule.create` | 2 | ⚑ **1** | The widest blast radius in the product: Governance §10.5 lets a standing policy execute **without a per-item proposal**, on the sole ground that the policy itself was approved through this contract. If a rule can be approved by anybody, §10.5's whole argument collapses. |

### Tier 2 — any member may approve

| Kind | Why it is not the principal's | 
|---|---|
| `document.route` | Says whose document this is. Wrong is fixed by `document.move-business`; nothing leaves. |
| `document.move-business` | Reversible by moving it back, and the addressee-mismatch warning must already be answered, not scrolled past. ⚠ The most arguable tier-2 cell — it moves a figure between two clients' books. Named in ⚖5. |
| `document.archive` | Reversible by definition (`ARCHIVED → READY/TO_REVIEW/PUBLISHED`). |
| `document.reprocess` | Re-reads the document. Sets no meaning of its own. |
| `document.reject` | Takes a document out of the books rather than putting a figure in. Reversible via reprocess. ⚠ Not to be confused with **denying a proposal** — item 27's new act. |
| `document.split` | Re-splits a batch by page range. Structural, not monetary. |
| `bank.confirm-match` | Asserts a document explains a bank line. Wrong is re-ruled. |
| `document.revoke-link` | Deliberately ungated since A12, and the reasoning stands verbatim: revocation is a **containment** action, and a rule that lets only one person stop a leaked link makes the leak last longer. |
| `document.resolve-duplicate` | A verdict a later verdict supersedes; `delete-copy` is the reversible Trash seam. |
| `document.update-coding` — **descriptive fields** | Gate ⚖5's option (b). Tier 1 under option (a). |

**The tier is not collapsed**, and item 66 asked whether it should be. It earns
its existence: nine of the sixteen kinds sit here, and they are the ones an
accountant does all day. Collapsing them into tier 1 is the literal reading that
*drowns the queue* — the failure Mubashir reported in the same sentence he asked
for the line to be drawn.

### Tier 3 — no approval, because there is no proposal

Every operation carrying `x-nt-side-effect: ingest` in the contract, ratified
deliberately rather than by history. There are 33 of them and they fall into six
groups.

| Group | Operations | Why no proposal |
|---|---|---|
| **Credentials and sessions** | `verifyEmailAddress` · `requestPasswordReset` · `resetPassword` · `confirmTotpEnrolment` · `acceptInvitation` · `createPortalSession` · `createPortalSignInCode` · `createPortalOnboardingSession` | These are how a person becomes able to act at all. A proposal in front of them is a lock whose key is behind the lock. |
| **Intake** | `createDocumentUpload` · `completeDocumentUpload` · `createPortalUpload` · `receiveWhatsappWebhook` | ⚠ **The load-bearing one.** A document ARRIVING asserts nothing about a client's books — it says a photograph exists. Nothing it contains reaches a set of books until an extraction is reviewed and a coding is approved. Requiring approval to receive post is also the one rule that would make the product unusable: D45 already binds intake to known senders, D46 forbids blocking, and this module's first invariant is that nothing is ever silently dropped. |
| **Trash** | `deleteDocument` · `restoreDocument` | Reversible in both directions, and the irreversible end of that road — `document.purge` — is tier 1. |
| **Practice and portal people** | `createPractice` · `createBusiness` · `invitePracticeMember` · `updatePracticeMember` · `removePracticeMember` · `revokePracticeInvitation` · `resendPracticeInvitation` · `inviteBusinessMember` · `invitePortalPerson` · `updatePortalPerson` · `removePortalPerson` · `updatePortalBusinessProfile` | Each carries its own `assertCan` — Part 1's gates ⚖2 and ⚖3 are exactly this table. Authority is checked; it is simply checked at the door rather than in a queue, because none of them states a figure. |
| **Billing** | `createCheckoutSession` · `createBillingPortalSession` · `receiveStripeWebhook` | D48 makes the CLIENT the payer. An accountant's approval queue is the wrong place for a client's own card, and `business.billing.manage` (⚖2) is the check that belongs here. |
| **Export** | `createExport` | ⚠ **Argued, not assumed.** This is the operation that physically produces the VT file, which under D42 is the product's only egress — so it looks like it should be tier 1. It is not, because **it can only ever contain documents that already passed one**: the exporter serves `PUBLISHED` only, and `publish.batch` is tier 1. Approving the export as well would be asking for the same signature twice on the same figures, and the second one would mean less than the first. D43's resolvable source link is a property of the file, not a second decision. |

---

### The super-admin fast path — item 26's ruling, made compliant

> *The super admin himself was doing it, so no need of any approval here.*

Taken literally this is a Governance change: it would remove the proposal record
for the one person whose decisions most need one. Taken as what it plainly means
— *nothing of mine should sit in a queue waiting for me* — it costs no rule at
all:

> **A tier-1 action staged by the super admin does not QUEUE. The same
> stage → Read review → Approve happens INLINE, in the dialog they are already
> standing in, in one flow. The record written is byte-for-byte the record a
> queued approval writes.**

Concretely, in `LiveProposalFlow` / `LiveProposalCard`, which are already mounted
on every staging surface:

1. `POST /action-proposals` — the proposal exists, `CREATED`.
2. `POST /action-proposals/{id}/review` fires immediately and the server's own
   rendered review appears in the same dialog. `reviewedAt` and
   `rendered_summary_hash` are recorded exactly as they are from the queue.
3. `[Approve]` mounts. **A human presses it.** The hash is echoed verbatim.

Nothing about steps 1–3 is new machinery, no server rule changes, and the DB
trigger is not consulted differently. What changes is that the queue never sees
it, because it was decided in the same minute it was staged.

⚠ **Never a silent bypass, and never an auto-approve.** Step 3 is the whole
point of the pattern; a dialog that pressed Approve for the person would be the
UI pretending to be the human, which is the one thing `api/proposals.ts`'s
header already forbids. How much of steps 1–2 may be automatic is gate ⚖6.

⚠ **A member who is not the super admin sees no change.** They stage, it queues,
and the dialog says so — which is also item 24's copy fix.

---

### Three rulings this Part overturns, stated rather than slipped in

`assert-can.ts` and `approvals/CLAUDE.md` carry argued reasons for `false` on
three of the five kinds moving to tier 1. Those arguments were not wrong; the
question changed.

`RELEASE_KINDS` was built to select for **acts that reach outside the product**
— D44's two, and the file says so. Item 66 asks a different question: *what does
the firm's principal sign for?* Irreversibility and blast radius are squarely
that, and they are the grounds the three refusals were declined on.

| Kind | The recorded reason for `false` | Why Part 2 overrides it |
|---|---|---|
| `document.purge` | *"a purge reaches nowhere — it destroys one of the practice's own rows, in their own workspace, after a human already put it in Trash"*, and the executor's refusals are the real D43 guarantee | The executor's refusals STAY and are unchanged. They protect the export link; they do not answer who signs for destroying a client's record. Nothing else in the product is unrecoverable. |
| `bank.remove-statement` | *"removal destroys DERIVED rows only — the source document stays in the vault and re-import re-proves D41"* | True and unchanged. But the derived rows are the period's reconciliation, and re-import is a re-run of D41's completeness gate, not an undo. |
| `business.offboard` | *"offboarding is soft and entirely internal — it flips `businesses.is_active`, sends nothing"* | Soft today. Item 67 gives it a deletion scope, a client-level Trash and a subscription consequence, and its blast radius is stated at Read review precisely because it is large. |

The module's own header must be amended in the same change, not silently
contradicted.

---

### What this costs in code

| Change | File | Size |
|---|---|---|
| Five `RELEASE_KINDS` entries flip, with their reasoning rewritten | `approvals/assert-can.ts` | ~40 lines of comment, 5 of code |
| `document.update-coding` is decided per-PAYLOAD, not per-kind | `approvals/assert-can.ts` + one call site | ~20 lines |
| A `PermittedAction` name for tier 1 beyond D44's two | `approvals/assert-can.ts` | ~15 lines — see the note in ⚖5 |
| Nothing else | — | The engine, the trigger, the executors and every payload are untouched |

---

## The gates — Part 2

### ⚖5 — Item 66: how far does tier 1 reach into a field correction?

His sentence cuts both ways in one breath: *"any filed update like the
category… and this typo things must need approval"*. Read literally, correcting
`Bidfood Wholsale` → `Bidfood Wholesale` waits for the principal, and the queue
Mubashir already complained about gets worse, not better.

**(a) Literal — every `document.update-coding` is tier 1.** One line of code, no
new concepts. Cost: every supplier-spelling fix in the practice queues for one
person. On the demo data alone that is most of the correction traffic.

**(b) Split by field — accounting meaning is tier 1, labels are tier 2.**
*Recommended.*

| Field | Tier | Reasoning |
|---|---|---|
| `categoryCode` | **1** | Which nominal account the money lands in. His named example. |
| `totalPence` | **1** | The figure. |
| `taxPence` | **1** | Item 22's field, exactly. |
| `currency` | **1** | Re-denominates the figure. |
| `documentDate` | **1** | Decides which PERIOD the entry exports in. |
| `docType` | **1** | `CREDIT_NOTE` vs `INVOICE` is the sign of the entry; `OTHER` is D46's not-a-financial-document flag. |
| `createRuleFromCorrection: true` | **1** | It creates a rule, and `rule.create` is tier 1. A second door onto a tier-1 act must not be tier 2. |
| `supplierName` | 2 | ⚠ The arguable cell. It names the party but sets no figure and no account, and the correction advisory already flags a supplier the document does not carry. Say so if you want it in tier 1 — it is a one-word move. |
| `customerName` | 2 | The sales-side mirror of the above. |
| `reference` | 2 | A label the bank match reads; a wrong one shows up as an unmatched line, loudly. |
| `description` · `projectRef` | 2 | Narrative. |
| `dueDate` | 2 | Aging, not the entry. |

⚠ **State plainly what (b) cannot do:** the server cannot tell a typo from a
substantive change. `supplierName: "Tesco"` on a Bidfood invoice and
`supplierName: "Bidfood Wholesale"` fixing a misread are the same request shape.
So each FIELD goes wholesale to one tier, and the split is a judgement about
which fields carry accounting meaning — not a detector for typos. A mixed
correction (one tier-1 field and three tier-2 ones in the same payload) is
**tier 1**: the highest field wins, because they execute as one act.

**A naming consequence either way.** `assertCan(actor, 'publish.release', …)` is
Governance §11.2's own literal, and its refusal sentences say *"release
documents for export"* and *"authorise a message to a client"*. Neither is true
of a coding correction. This file's own rule (⚖2, and `approvals/CLAUDE.md`'s
"two more `PermittedAction`s") says what to do: **same predicate, new name, own
sentence.** Recommendation: add **`proposal.approve`** as the seventh
`PermittedAction`, sharing `mayRelease` verbatim, with a per-kind refusal
sentence; `publish.release` keeps D44's two and keeps meaning exactly what
Governance said it meant.

⚖ **Ruling (Shakib, 6 Sep 2026): (a) — the LITERAL reading. Every
`document.update-coding` is tier 1, whatever field it touches.** Mubashir's
sentence is taken at its word: a supplier-spelling fix waits for the super
admin exactly as a category change does. The queue-volume argument was put and
declined — the fast path is what answers it, because the person the queue waits
for is also the person doing most of the correcting, and their own corrections
never queue at all.

**Two consequences follow, and both are part of this ruling:**

1. **`RELEASE_KINDS['document.update-coding'] = true`** — one line, no
   per-payload branch, no field table to keep in step with the contract. The
   field split above is kept in this document as the option that was NOT taken,
   because the day the queue does drown, (b) is the change to make and its
   reasoning should not have to be rebuilt.
2. **The correction dialog must stage-only for a member who cannot release.**
   `updateCodingProposal` (`api/document-detail.ts`) bundles create → review →
   approve into one call behind the modal's [Approve] button, so under this
   ruling a standard user's third call now answers `403 NT-PRM-001` and the
   card says *"That correction was NOT saved"* — true of the value, and the
   wrong sentence about the act. It stages and stops instead, and says the
   correction is queued. That is item 24's copy branch reaching the same
   surface, from the same `Me.isOwner` fact.

**And the naming consequence, applied:** `assertCan(actor, 'publish.release',
…)` is Governance §11.2's own literal and its sentences say *"release documents
for export"* / *"authorise a message to a client"*. Neither is true of a coding
correction, a purge or an offboard. Per this file's rule at ⚖2 — same
predicate, new name, own sentence — **`proposal.approve` is added as the
seventh `PermittedAction`**, sharing `mayRelease` verbatim, with a per-kind
refusal sentence. `publish.release` keeps D44's two and keeps meaning exactly
what Governance said.

---

### ⚖6 — Item 26: how much of the super-admin fast path is automatic?

Step 3 (Approve) is a human press in every option; only steps 1–2 are in
question.

**(a) Auto-open the review.** *Recommended.* Staging fires
`POST …/review` immediately and the server's rendered review is on screen when
the dialog settles; the super admin reads it and presses Approve. One click for
the whole act, and the click that remains is the one that matters.

**(b) Stage only, as today.** The card appears with `[Read review]` unpressed;
two clicks. Zero new behaviour, and defensible on the ground that pressing
"Read review" is itself a small act of consent. Costs one click and delivers the
same record.

**(c) Auto-approve.** *Refused, and named so it is not proposed again.* It would
write an approval no human pressed, which is the failure the whole pattern
exists to prevent, and `reviewedAt` would mean "a screen rendered this" rather
than "a person opened it".

Note that under (a) the record is not weaker than a queued approval: a queued
approver also gets the review rendered by pressing one button, and what is
recorded in both cases is that the server rendered the review and a human then
echoed its hash.

⚖ **Ruling (Shakib, 6 Sep 2026): (a) — the review opens itself.** Staging
fires `POST …/review` immediately, the server's rendered review is on screen
when the dialog settles, and the super admin presses Approve. One click for the
whole act, and the click that remains is the one that matters. (c) stays
refused.

---

### ⚖7 — Item 27: the deny-with-reason contract delta

> *There is no option for denying an approval… it must ask for the reason, and
> the reason and declined message must be sent via email to the team member and
> must be shown in the table row in the document row; and this document must be
> downgraded from ready tab to review tab with tag that it is rejected or denied
> by the super admin for this reason in a column*

Today the review card offers **Approve** and **Cancel**, and Cancel is the
contracted *withdrawal* — the proposer taking their own proposal back. There is
no reviewer's refusal in the product. The delta, in full:

| # | Change | Where | Note |
|---|---|---|---|
| 1 | **`POST /action-proposals/{proposalId}/denial`** — `denyActionProposal`, `x-nt-side-effect: proposal`, body `{ reason }` **required**, 1–500 chars | `packages/contracts/openapi.yaml` | A denial without a reason is not a denial. The mirror of Cancel's `reason`, which is optional because withdrawing your own work owes nobody an explanation. |
| 2 | **`ProposalState` gains `DENIED`** | contract enum + `prisma/schema.prisma` + one migration | ⚠ **`DENIED`, not `REJECTED`** — `DocumentState.REJECTED` and the `document.reject` proposal kind already exist and mean something else entirely. Three "rejected"s in one queue is how a support call goes wrong. |
| 3 | **Who may deny follows who may approve, per tier** | `action-proposals.service.ts` | Tier 1 → `mayRelease`; tier 2 → RLS only. A refusal is a decision of the same weight as an approval. |
| 4 | **The reason is emailed to the proposer** | new `EmailKind: 'proposal-denied'`, `notifications/email-copy.ts`, a per-kind rate ceiling | Through the established seam, and **after the transaction commits** — an SMTP round trip must never hold a tenant transaction open (`runPublishFollowUp`'s reasoning). A send failure is a loud log; the denial is committed and true regardless. |
| 5 | **A `publish.batch` denial drops its documents `READY → TO_REVIEW`** wearing `"Denied by {name}: {reason}"` | `validation-dedupe/document-state.ts` | `LEGAL_TRANSITIONS` already permits `READY → TO_REVIEW`. What does not exist is a way to attach a REASON to it: `DocumentTransition` is a union whose non-failure branch carries `failure?: never`, deliberately, so that `REJECTED`/`FAILED` can never be written without one. The delta is a third union member letting `TO_REVIEW` carry an OPTIONAL failure. The mechanical guarantee it protects is untouched — `REJECTED`/`FAILED` still cannot be written without a reason. |
| 6 | **The tag on the document row costs zero web bytes** | — | `failureMessage` already flows to `Document.statusNote` (`api/documents.ts`), and `Tables.tsx` already renders `<Pill tone="amber">{d.statusNote}</Pill>` on every review-status row. Setting the field IS the column. `failureCode` gets a non-`NT-PUB` code so `publishFailed` stays false. |
| 7 | **The reason is visible on the proposal itself** | `LiveProposalCard`, the History tab | It rides `outcome`, the way a cancellation's reason already does. |

**One sub-choice inside (2).** The zero-migration alternative is to reuse
`CANCELLED` and discriminate on `outcome.denied`. It works, and it is smaller.
It is not recommended: the state enum is what `GET /action-proposals?state=…`
filters on, so History could not separate *"the proposer withdrew it"* from
*"the principal refused it"* without reading JSON per row — and those two
sentences are the entire product of this feature.

⚖ **Ruling (Shakib, 6 Sep 2026): approved as tabled, with the `DENIED`
state.** The whole batch — the new operation with its required reason, the
enum value and its migration, deny-authority following approve-authority per
tier, the email after commit, and the `READY → TO_REVIEW` drop carrying the
reason. The `CANCELLED`-plus-`outcome` alternative was declined on the stated
ground: telling *"the proposer withdrew it"* from *"the principal refused it"*
is the entire product of this feature, and a state enum that cannot answer it
without reading JSON per row is not carrying its own record.

---

### ⚖8 — Item 26: what does a second identical staging get back?

Nothing stops staging the same `publish.batch` over the same document twice, so
Mubashir's queue holds eight identical cards over one document. The fix is
server-side and idempotent: a create whose **kind + business + acted-on record
ids** match a proposal already in `CREATED`/`REVIEWED` and inside its TTL does
not mint a second one. The question is only what the caller is told.

**(a) `409 NT-PRP-007` — "already awaiting review".** *Recommended.* The dialog
renders the server's sentence (it already renders `NtProblemError` with its
code) and offers **Open Approvals**. One error code, one web branch, no schema
change. The web client cannot read an HTTP status — the fetch mutator returns
the raw body — so a distinguishing 200-vs-201 is invisible to it, which rules
out the quiet version of (b).

**(b) Return the existing proposal, 201.** The idempotency-replay shape. Nicer
in one case — the super admin who re-stages gets the existing card and can
approve it inline — but the browser cannot tell it apart from a fresh create, so
the dialog would silently claim to have staged something it did not.

Identity is extracted from the STORED payload per kind (a total record over
`ProposalKind`, the way the executor registry is), because the engine rewrites
three payloads at creation — `publish.batch`, `chase.send`,
`bank.remove-statement` — while the record ids inside them survive intact.

**Plus a cleanup for the queue as it stands**: a one-shot script that finds
pending proposals sharing an identity and cancels all but the newest with the
reason *"Superseded — duplicate staging (review item 26)"*. Cancellation, not
deletion: what we decided not to do is part of the record.

⚖ **Ruling (Shakib, 6 Sep 2026): (a) — `409 NT-PRP-007`.** The refusal is
unambiguous, the dialog already renders a problem with its code, and the
browser's inability to read an HTTP status makes (b)'s quiet version a screen
claiming to have staged something it did not. The cleanup script lands with it.

---

### ⚖9 — Item 24: no gate needed, a finding recorded

`PublishBatchDialog` lectures the super admin — *"only your practice's super
admin can approve one"* — because the dialog's own honesty rule says it may
never claim a permission it cannot verify, and `/me` was documented as carrying
no `is_owner`.

**It carries one now.** `Me.isOwner` is `required` in the contract, answered
from the acting membership by `auth.service.ts`, and already read by
`TeamView`. Package F landed it. **Item 24 therefore needs no contract delta at
all** — it is a copy branch over a fact the session already holds:

- super admin → *"You can approve this after reading the review."*
- everybody else → today's sentence, naming who releases.

The sibling D44 sentences (`RequestStatementDialog`, `OffboardClientDialog`,
`LiveProposalFlow`) branch from the same fact in the same change, so the family
cannot drift.

⚠ It stays a fact for DISPLAY. The server refuses with `NT-PRM-001` regardless,
and a `/me` thirty seconds stale is exactly how that refusal arrives.
