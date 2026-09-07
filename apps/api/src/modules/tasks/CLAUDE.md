# tasks — the practice's checklist and the firm's org chart

Landed 7 Sep 2026, review item 54: *"Task assign option is not build yet, make
sure to plan this out and setup the feature completely."*

## What was actually missing

`Task` had been a Prisma model since the init migration — title, description,
`ownerUserId`, `dueAt`, `status`, `cadence`, `dependsOnTaskId`, `aiPrefilledAt`
— and `tasks` was already on rls.sql's `direct_tables` loop. **Nothing had ever
read or written a row.** No operation in `openapi.yaml` named it and no service
touched it, so both Tasks tabs ran off React state that evaporated on reload.
So the schema was not the gap; the contract, the service and the wiring were,
and `tasks` needed **no migration at all**.

`Team` was the opposite: no table, no policy, no anything. Shakib ruled it ships
alongside Tasks, which is why `20260907120000_tasks_and_teams` exists.

## The ruling this module rests on — item 66 tier 3

Applying the matrix's own question (*whose signature does this carry*) rather
than `RELEASE_KINDS`' retired one: **a ticked checkbox carries nobody's.**
Every write here is `x-nt-side-effect: ingest` and **no `ProposalKind` was
added**. Nothing in this directory can reach a document's coding, a figure, a
chase, an export, or anything outside the product, and every write is undone by
making the opposite one.

Governance §10's "no state change outside the ActionProposal path" is about the
**client's** state. A proposal on a checkbox asks for a signature on something
nobody is signing for, and item 66's own finding is that asking twice makes the
second one mean less. What would move this to tier 2 is a task that **acts** — a
checklist item that publishes, or codes, or texts. There is none, and
`aiPrefilledAt` is the boundary: it records that an engine READ something, never
that a task drove one.

`tasks.service.test.ts` asserts this structurally — the fake Prisma exposes no
`actionProposal` delegate, so a future write path that minted one would throw
rather than pass.

## ⚠ A team grants NOTHING. Read before adding a field.

The objection when Teams was scoped: a team with its own access setting is a
**second answer** to *"what can this person reach"*, standing beside the one
every RLS policy already consults (`Membership.businessId`), and two answers to
that question is how a permission bug ships. The design keeps the feature and
removes the objection:

- **No `access_level` column.** `accessLevelFor()` derives the label from the
  members' own memberships — `all-clients` when every member holds a
  practice-wide membership, `assigned-clients` otherwise (and for an empty team,
  which reaches nothing because it contains nobody: the vacuous-truth trap, and
  it has its own test).
- **No policy in the database consults `team_members`**, and
  `prisma/sql/tenancy-check.sql` §12 asserts that over `pg_policies` rather than
  trusting this file. If that assertion ever needs relaxing, the design has
  changed and it should not survive review.
- Joining or leaving a team changes nothing about what anybody can see. The
  delete confirm says so, truthfully.

## Tenancy

- **`tasks`** — `business_id` is `NOT NULL` and the table rides rls.sql's
  `direct_tables` loop, so `app_can_access_business(business_id)` bounds every
  row. Nothing here adds a second tenancy clause. That column being `NOT NULL`
  is also why **there is no practice-wide task**: it would be a row no policy
  could reach. "All clients" on the board is a filter over the set RLS already
  decided, never a second scope.
- **`teams`** — a practice and no business, so *not* on the loop: its policy is
  `app_can_access_document(NULL::text, practice_id)`, the anchor-pair predicate,
  chosen over the inline invites/guidance shape because it carries the
  `app_session_scope() = 'user'` guard a delegated portal session fails.
  `team_members` reaches its parent, the `chase_messages` shape.
- **`users` and `memberships` carry no RLS.** Both services read them, and both
  bound the read themselves: `assertAssigneeIsColleague` and `colleaguesAmong`
  resolve the practice off the businesses RLS admits, never off the request.
  `assigneeNames` is safe for a different reason — its ids come out of
  RLS-bounded task rows, not off the wire.

## Recurrence has no scheduler, deliberately

Completing a task that carries a `cadence` writes the next occurrence, due date
advanced by one period (`due-date.ts`), inside the same transaction. **The
completion IS the tick** — no cron, no worker, no dedupe table, because the only
event that can generate is a human pressing a button exactly once.

What it does not do: a monthly task nobody ever completes does not pile up
twelve copies by December. That is the right answer for a *checklist* and the
wrong one for a *calendar*. If rows must appear on the 1st whether or not last
month closed, that is a worker and a different feature with a different failure
mode.

Two details with tests behind them: the roll is from the **old due date**, not
from `now` (rolling from today walks the series later every cycle), and
month-end **clamps** rather than overflowing (`Date.UTC(2026, 1, 31)` is 3
March, which would drift a 31st off month-end permanently).

## `aiPrefilledAt` has no writer, and that is the feature

The badge used to be decided by matching a task's **title** against three string
prefixes in `TeamView.tsx`. Against a real task called "Chase missing paperwork
before the VAT return" that is a coincidence, not a derivation, and item 25's
standing rule forbids it. The column stays unwritten, the projection sends
`null`, and **no live task carries the badge**. It earns its way back the day
something reads engine state and stamps the column — the SoT §7 sentence already
on that field.

## Files

| File | What |
|---|---|
| `tasks.service.ts` | `/v1/tasks` — list, create, replace, status (+ recurrence), delete, and the `task.assigned` notification |
| `teams.service.ts` | `/v1/teams` — list, create, replace, delete, and `accessLevelFor` |
| `due-date.ts` | UTC-only calendar-date arithmetic. The whole file exists because `new Date('2026-03-01').getDate()` is 28 west of Greenwich |
| `tasks.controller.ts` | Both controllers. Two classes only because Nest binds a path prefix per class |
| `tasks.module.ts` | Why this is a module and not two more services in `clients-team-settings` |

## Why a module of its own

`clients-team-settings` already holds a `TeamService` (a **client's** people) and
a `PracticeTeamService` (the firm's **colleagues**). A third thing called "team"
beside them is the setup where the wrong one gets injected and nobody notices
for a week. Separate directory, separate symbols (`TEAMS_SERVICE` is not
`TEAM_SERVICE`).

## Error codes

`NT-TSK-001` blocker on another client · `NT-TSK-002` dependency would close a
cycle · `NT-TSK-003` assignee is not in this practice · `NT-TEM-001` duplicate
team name · `NT-TEM-002` member is not a colleague · `NT-TEM-003` the practice
has no client workspaces yet. Their own families rather than `NT-VAL-001`
because each is a refusal a **person** acts on at a form, and a screen cannot
say which unless the code distinguishes them.

## The notification

One `notifications` row on assignment and reassignment: `event:
'task.assigned'`, `recipientUserId` the assignee, `businessId` the client.
Written **outside** the transaction that wrote the task and after it — a
notification that fails must not roll back the assignment it describes.

**Nothing is written when you assign to yourself**, and reassignment notifies
only when the assignee actually changes (re-saving a description must not
re-notify, or the bell becomes the thing people mute).

Two limits, stated rather than papered over: the bell's list query carries no
`recipientUserId` filter by item 12's own decision (*"the bell is a
practice-wide surface"*, `notifications/inbox.service.ts`), so a colleague's
assignment is visible to the practice; and `NotificationItem` carries no task
title, so the copy can only say *"A task was assigned on {business}"*. Widening
the projection for one line of copy buys a noun; not taken.

## Defensive reads

`status` and `cadence` are free `String?` columns that predate this contract, so
a hand-run SQL fix can put anything in them. An unrecognised status projects as
`open` (the state that keeps a row visible) and an unrecognised cadence as
`null`. The seed itself carried `not_applicable` — hyphen-free, and nothing had
ever validated it because nothing read the table; corrected in the same change.
