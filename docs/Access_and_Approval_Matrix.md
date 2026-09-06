# Access and Approval Matrix

**Status:** Part 1 (visibility and action) drafted 6 Sep 2026 for review item 39;
Shakib's rulings recorded inline at the gates marked ⚖. **Part 2 (approval tiers)
is owed by review item 66 / package G and lands in this same file.**

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
| **Approve a release kind** (`chase.send`, `publish.batch`) | `assertCan('publish.release')` = `canRelease && isOwner` | ✔ | ✖ **disabled** | ✖ **disabled** | ✖ **disabled** |
| Approve any other kind | none beyond RLS | ✔ | ✔ | ✔ | ✔ |
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

**Owed by review item 66 (package G).** What needs whose approval, the
super-admin fast path for their own actions, and which proposal kinds queue at
all. It lands in this file, under this heading, so that *who may see and do* and
*what of it needs approving* are read together.

The one thing Part 1 settles in advance: `RELEASE_KINDS` in `assert-can.ts` is
already the total, per-kind table Part 2 will extend — every entry carries its
reasoning and is flagged for human ratification.
