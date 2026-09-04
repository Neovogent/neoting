# documents — the read surface

**Source of Truth:** SoT §4 Stage 5 · **Added by:** issue #77, widened by document management (2 Sep 2026) · **Contract:** `GET /v1/documents` (now with `?deleted`), `/documents/counts`, `/documents/{documentId}`, `/{documentId}/original`, `/{documentId}/events`, `/{documentId}/extractions`, `POST /{documentId}/deletion`, `POST /{documentId}/restoration`

## Purpose

Six GETs and two POSTs: the queue lists, one document, a short-lived link to its
original bytes, its processing log, its extraction history, the screen's header
counts — and Trash / restore.

**`DocumentsService` still has no mutating method, and that is still
structural.** The two writes live in a SECOND class,
`DocumentManagementService`, whose entire surface is the pair — so "what on this
module can write?" is answered by reading one small file rather than by trusting
a claim. A retry is still a `document.reprocess` proposal, and permanent deletion
is still a `document.purge` proposal; **there is no `DELETE /documents/{id}`
anywhere in the contract and none may be added.**

## Document management — Trash, restore, counts (2 Sep 2026)

The product owner asked for *"proper document management here, like delete
option, preview option"*, benchmarked against Dext. What landed:

| Operation | Class |
|---|---|
| `GET /v1/documents?deleted=true` | `none` — a new optional param on the EXISTING list, default false |
| `POST /v1/documents/{id}/deletion` | `ingest` |
| `POST /v1/documents/{id}/restoration` | `ingest` |
| `GET /v1/documents/counts` | `none` |

### ⚠ The mechanism is `documents.deleted_at`, NOT a `DocumentState` member

Migration `20260902220000_document_soft_delete`, additive, writes no data. A
ninth enum value would have broken `portal-document-status.ts` — a deliberately
TOTAL mapping onto the five words a CLIENT is shown, where "deleted" must never
appear — plus `LEGAL_TRANSITIONS`' 8×8 matrix and the contract's own
`DocumentState`, which `check-contract.mjs` mirrors from prisma verbatim.

The deeper reason is that deletion is **orthogonal to pipeline state**: a READY
document that is deleted and restored is READY again, and `state` is what
remembers that. A state member would have had to destroy the answer in order to
record the question — which is exactly why restore here has nothing to derive,
unlike unarchive, which reads its target back out of the event log.

### ⚠ `x-nt-side-effect: ingest`, and why the word does not obviously fit

The four classes are `none` / `ingest` / `proposal` / `execute`. `none` is false
(these write), `proposal` is false (no ActionProposal is created), and `execute`
is reserved for exactly ONE operation in the whole API — the checker asserts it.
So `ingest` is the only admissible value, **and it is also the established
one**: `PATCH /portal/people/{personId}` and `DELETE /portal/people/{personId}`
are both `ingest` and both change an existing record's state. The spec header's
gloss on `ingest` ("changes no existing record's state") has been narrower than
its own use since those landed; recorded as a contract-doc gap rather than
silently widened.

**Why not proposals.** `RELEASE_KINDS` states the test: *"internal and reversible
by a further proposal — archive unarchives, coding is corrected again, a
rejection is reprocessed."* Delete and restore undo each other exactly. Putting
Read review → Approve in front of pressing Delete on one receipt would fill the
Approve queue with housekeeping, and Approve fatigue is how a real release gets
waved through.

⚠ `docs/research/dext-document-management.md` §10.2 **B2 suggests the
opposite** — restore as an Approve-ceremony action, and delete as a proposal for
any approved document. That is a live disagreement with the shipped shape, taken
because the build brief specified ordinary mutations. It is a product decision,
not a defect; flagged rather than settled.

### The one predicate — `common/documents/deleted-documents.ts`

`notDeleted()` / `onlyDeleted()` / `deletedFilterFor(deleted)`. The
`PORTAL_HIDDEN_DOCUMENT_STATE` shape, for the same reason: **a list filter and a
count that spell the same exclusion twice will eventually disagree, and the more
permissive one wins on the day it matters.** This module already proves the
point — "hidden" is spelled THREE ways across the codebase (`state: { not:
'ARCHIVED' }` here, `PORTAL_HIDDEN_DOCUMENT_STATE` in the portal,
`archivedAt: null` in the chat and coding paths) and they are not equivalent.

Two functions rather than one boolean-taking one, deliberately: `notDeleted()`
beside `onlyDeleted()` cannot be got the wrong way round by a misplaced `!`, and
they have different TYPES so a swap is a compile error.

⚠ **It is not a tenancy boundary.** Tenancy is RLS; this is a product predicate
on top of the already-scoped set.

### What deliberately does NOT exclude Trash

`getDocument`, `getDocumentOriginal`, `listDocumentEvents`,
`listDocumentExtractions` — **all four still serve a deleted document.**
Previewing one is exactly how a person decides whether to restore it (the
"preview option" half of the ask), and both mutations return `Document` for a
row that is or has just been deleted. The exclusion belongs to the surfaces that
answer *"what is there"*, never to the ones that answer *"show me this one"*.

`GET /d/{code}` (the D43 capability link) also still resolves for a deleted
document, and that is load-bearing rather than an oversight: an accountant
holding an exported line's URL must not be affected by workspace housekeeping
they cannot see. `docs/research/dext-document-management.md` §10.4 C1 argues
delete should be REFUSED for any document with an export line — that guard
exists in AutoEntry because AutoEntry's delete is closer to permanent. Ours
cannot break the link, so the refusal lives one level up, on `document.purge`.

### ⚠ Trash has no expiry, and there is no "empty Trash"

Three independent research passes found that **no vendor — Dext, Hubdoc,
AutoEntry, Xero — publishes a recovery window at all.** A TTL here would be our
own invention wearing borrowed authority. The only route out of Trash is a
reviewed `document.purge` naming explicit ids; a bulk-destroy verb is precisely
Hubdoc's mistake (its only hard-delete primitive is "Empty Trash" for the whole
organisation) and would be worse with our stakes. **Do not add one.**

### Idempotency, and where it actually comes from

Deleting a deleted document is a `200`, not a `409`, and **the original
`deletedAt` is not rewritten** — *when* a document was deleted is the only
question a Trash listing sorted by deletion can answer, and a second press of a
button that appeared to do nothing must not silently move it.

The row-level compare-and-swap (`updateMany` guarded on the current condition)
is what makes that true; the `Idempotency-Key` is required by the checker for
every non-`none` mutation and is honoured with an **actor-scoped** fingerprint,
copied from `action-proposals.service.ts`'s A12 fix. Without the actor, the
process-wide in-memory store would let one caller replay another's document past
RLS — a disclosure hole, not a double-effect one, since the writes are natively
idempotent.

### Both directions write TWO durable records

A `document_events` row (`stage: 'delete' | 'restore'`, outcome `DELETED` /
`RESTORED`) **and** an `audit_events` hash-chain row naming the actor, in the
same transaction as the timestamp. `stage` is not `'state'`, because this is not
a `DocumentState` transition and labelling it one would make the log claim an
edge the machine never took. `appendAuditEvent` comes through the approvals
seam — never a second copy of the formula, because a chain whose links were
computed two ways cannot be verified at all.

⚠ Neither row carries untrusted content: ids and a state name only. A test
asserts a supplier-style filename never reaches either.

This is the gap the market leaves open. Hubdoc's per-document "audit trail" is a
provenance panel — upload source, who, when — recording **no** deletion and no
restore, so once its Trash is emptied a removal leaves no trace at all.

### `GET /documents/counts` — the header, served honestly

The screen read `3 documents · 0 archived · 0 in vault · 0 expiring` and three
of those four were not answers. See the TRUTH table in the service header. All
five counts run in ONE `scopedDb` transaction so they share a snapshot.

⚠ **`inVault` and `expiring` count `vault_items`, not documents**, and the
contract says so in the field descriptions. `documents` has **no expiry or
retention column at all**, so there is no expiring document to count and none is
approximated. `expiring` includes items already past their date — an expired
certificate is the most expiring thing on the screen — and echoes back the
`expiringWithinDays` horizon it used.

⚠ **`@Get('counts')` MUST stay declared above `@Get(':documentId')`.** Nest
matches in declaration order, so the other way round `GET /documents/counts`
resolves as "the document whose id is `counts`" and 404s forever. That is also
why the counts handler is on `DocumentsController` rather than beside the other
two management operations: ordering ACROSS controllers depends on the module's
`controllers` array, which is far easier to reorder by accident.

## ⚠ `getDocumentOriginal` has TWO principals (2 Sep 2026)

It is the only operation in this module that does, and the change is the
contract catching up with itself rather than a widening. The operation's own
description has said *"a delegated OTP session may only call this for items in
its grant (Governance §5.2); the RLS context decides, not the handler"* since
the spec was drafted, and `documents_delegated_upload` in `prisma/sql/rls.sql`
has permitted exactly that for just as long — but the operation carried **no
`security:` block**, so it inherited the global `workspaceSession` default. A
client could not open the receipt they had just sent, and the sentence in the
spec described a caller nothing admitted.

`documents.controller.ts#principalFor` is the whole of the choice, and it is the
`billing.controller.ts` shape: **an `Authorization` header means the portal**
(judged as a portal session on its own merits — the resolver re-reads the
`otp_sessions` row and re-checks scope, verification and expiry), no header at
all is the accountant, and a blank header falls to the accountant.

**On the portal path the boundary is SQL, and it is the ONLY one** — which makes
this different from every other portal read in the product. The request runs
under `delegatedScopeFor(facts)`, so
`documents_delegated_upload`'s `id = ANY(app_granted_item_ids())` decides: a
document outside the grant is invisible to `findUnique`, the service's existing
`null` check raises 404, and the presign never happens (this module already reads
before it signs, and a test pins that). No ownership check is added, because a
check that *could* answer 403 would confirm the document exists.

A session with an EMPTY grant — an onboarding session that has never uploaded —
cannot have a delegated context built for it at all (`ScopeContextSchema`
refuses one: an empty grant reads as "no restriction" to a human and denies
everything in SQL). It gets a 404 that is **word for word** the service's own,
so a caller cannot tell "your session may reach no documents" from "that
document is not yours".

⚠ The consequence for the client portal, stated plainly: a client may open the
original of a document **they sent through the portal**, and not one that
arrived by email or that their accountant uploaded, because that is what a grant
contains. Widening it means either a new RLS branch (a `prisma/` change) or
reading originals under the practice SYSTEM context — which would trade a
database guarantee for an application one on the single endpoint that hands out
bearer-authority URLs to raw bytes.

The other four reads did **not** gain a principal, and
`documents.controller.test.ts` pins their arity so one cannot be given a header
without the contract moving first: `getDocument` returns the practice's full
record including the coding, `listDocuments` is the inbox, and the two child
lists are the internal processing log.

`DocumentsModule` therefore `imports: [PortalModule]`, reached through
`modules/portal`'s public seam. One-way — `PortalModule` does not import this
one — so there is no Nest cycle.

## Tenancy: RLS, and deliberately no second mechanism

Every query runs inside `scopedDb`. **Nothing in this module adds a manual
`practiceId`/`businessId` clause to enforce scope**, and there is a unit test
asserting the `where` clause stays empty when no filter was asked for. A
hand-written tenancy filter alongside an RLS policy is two mechanisms that can
disagree, and the more permissive one wins exactly when it matters.

**404, never 403.** A document outside the caller's scope is invisible to
`findUnique` — RLS removes it before Prisma sees it — so it returns `null` and
the service raises 404. There is no ownership check that *could* raise 403,
because a 403 confirms the record exists (`packages/contracts/CLAUDE.md`). The
detail string says "No document with that id." and never echoes the id back.

Two consequences worth knowing before changing anything here:

- **`GET /documents?businessId=…` for a business you cannot reach returns an
  empty page** — not 404, not 403. The rows were already invisible; the filter
  matches none of them. That is what the contract's parameter description asks
  for and the only answer that does not confirm whether the business exists.
- **`events` and `extractions` have no tenant column of their own.** They hang
  off `document_id`. The parent `findUnique` coming back null under RLS is the
  *only* thing between a caller and another practice's processing log — so the
  parent check and the child query share **one** `scopedDb` transaction. Two
  calls would be two chances for the GUCs to differ. A test asserts the child
  query is never issued when the parent is invisible.

## `NT-NOT-001` does not exist

The `ErrorCode` enum in `openapi.yaml` has **no dedicated not-found code**. 404s
here carry `NT-VAL-001`, the house fallback for an otherwise-uncoded 4xx
(`ProblemFilter.CODE_BY_STATUS`) and the same choice web-upload made for an
unreachable business. Inventing a code the generated client has no branch for
would be worse than reusing the documented fallback. Checked against the enum,
not assumed — the first draft of the build plan for this issue assumed
`NT-NOT-001` and was wrong.

## Keyset pagination lives in `common/pagination`

`common/pagination/cursor.ts`, written once because five list endpoints are
coming behind these. Governance §3 forbids offset pagination; the reason is that
`OFFSET 40` re-serves rows and skips others the moment anything arrives while a
user is reading page 1, which is precisely the "never skips or repeats a row"
acceptance criterion.

Three things about it that are load-bearing:

- **`SortField.nullable` is not cosmetic.** Prisma rejects
  `orderBy: { col: { sort, nulls } }` on a *required* column and throws at
  runtime. `receivedAt` is required **and is the default sort**, so a helper that
  treated all columns alike would pass any test written against a nullable sort
  field and then 500 the most common request in the API.
- **The cursor fingerprint is a SHA-256 digest, not a prefix of the encoded
  query.** It was a truncated base64 prefix first, and its own test caught it: the
  prefix only covered the first ~16 bytes of the query JSON, which in sorted-key
  order stops *before* `order` and `sort` appear — so changing the sort direction
  produced an identical fingerprint and a stale cursor was silently accepted.
- **The cursor is not signed, on purpose.** A forged one cannot widen access —
  the query still runs inside `scopedDb`, so RLS is the boundary either way, and
  the worst outcome is a page of the caller's own rows starting somewhere odd.
  Signing would add a secret to rotate for a boundary it does not move.
- **The fingerprint must be computed over the query MINUS the cursor**, which is
  why `listDocuments` passes `{ ...query, cursor: undefined }` and not `query`.
  This shipped wrong and is worth knowing about before touching it. `cursor` is a
  field *of* the parsed `ListQuery`: on page 1 it is undefined and
  `stableStringify` drops it, on page 2 it is the token the client just sent
  back, which folds into the digest — so the fingerprint sealed into a cursor
  could never match the one recomputed when that cursor came back, and **every
  page-2 request 400'd** with "issued for a different set of filters". The
  fingerprint has to cover what identifies the *list*; the caller's position in
  it is not part of that. `listChildren` had it right (`{ documentId, cursor:
  undefined, limit }`) and this did not, which is the shape to copy.
  Nothing caught it: the only cursor test asserted a malformed cursor is refused,
  and a broken fingerprint does that correctly. The regression test is *"page 1's
  own cursor is accepted by page 2 and seeks past the last row"* — a genuine
  two-page round trip, which is the only shape that would have.

The envelope is shaped as the contract's `{ data, pageInfo }`, so a service
method returns `toPage(...)` directly and there is no hand-written mapping step
in between to drift from the spec.

## The query boundary coerces, because query strings have no types

Express hands the controller `{ limit: '25', state: 'READY' }` — every value a
string, a once-given repeatable filter a bare value — while the generated
schemas type `limit` as a number and the filters as arrays. Parsed raw, both are
400s, including the very first call `apps/web` makes. The controller runs each
query through `common/validation/coerceQuery` **before** `parseBoundary`:
schema-driven (a key is wrapped/numified only because the generated schema says
so), matching on `_def.typeName` strings rather than `instanceof` because
`@neoting/contracts` has its own zod instance under pnpm and cross-instance
`instanceof` is silently false everywhere. Bodies are NOT coerced — a
number-as-string in JSON is genuinely wrong and should stay a 400.

## The filters, and four that are easy to get wrong

`buildFilters` is **not a security boundary** — read the comment on it before
adding anything. Four details there are load-bearing:

- **An omitted `state` filter excludes ARCHIVED** — the contract's own default
  ("Omitted means every state except ARCHIVED"), not a preference. Without it
  every working queue grows forever. Asking for ARCHIVED by name still returns
  it. This shipped as "omitted means everything" and a test now pins both
  halves. A consequence for tests: the no-filter `where` is `{ state: { not:
  'ARCHIVED' } }`, never `{}` — the no-second-tenancy-mechanism test asserts on
  the KEYS for exactly this reason.
- **Extractions are served NEWEST first, events OLDEST first** — both are the
  contract's words ("Every extraction attempt, newest first" / "The processing
  log, oldest first"). Extractions shipped oldest-first on a narrative argument
  the spec does not make. Because the two child lists now read in opposite
  directions on the same `createdAt` + id sort, the child-cursor fingerprint
  carries a `list` discriminator — a cursor minted by events is a 400 on
  extractions rather than a silently wrong page.

- **The date range is half-open: `receivedFrom` is `gte`, `receivedTo` is `lt`.**
  The asymmetry is the contract's, not a typo — `openapi.yaml` documents them as
  "Inclusive lower bound" and "Exclusive upper bound". It is what makes
  day-by-day paging work: yesterday's `receivedTo` is today's `receivedFrom`, and
  a document landing exactly on midnight belongs to exactly one of those days
  rather than both. This was `lte` on the first pass; a test now pins it.
- **`q` sequentially scans, at every needle length.** `contains` is
  `ILIKE '%q%'`, and a leading wildcard cannot use a B-tree index. The contract's
  2-char minimum on `q` bounds how wide the *result* is and does nothing whatever
  to the plan — an earlier comment in the source claimed the minimum kept this
  off a full scan, which was false and has been corrected. The fix is a `pg_trgm`
  GIN index, which is a `prisma/` change and so a contract-change issue (G7).
  Field set: `supplierName`, `description`, `reference` (the contract's list,
  minus extracted text which waits on the FTS column), plus `originalFilename`
  as a deliberate addition — searching the name a file arrived under is how
  people actually find things, and it widens results, never narrows them.

## `presignGet` — a link, never the bytes

`GET /{documentId}/original` returns a presigned URL. **Five minutes**
(`ORIGINAL_URL_TTL_SECONDS`), because the URL is bearer authority with no session
and no RLS behind it, and it goes into an `<img src>` — so it lands in browser
history, in a `Referer` if the page links out, and in any proxy log on the way.
The contract says the same thing in prose: *"Minutes away, not hours."*

- The `Content-Type` pinned on the response is the **stored** MIME, which is
  magic-byte-authoritative after sanitisation — never the uploader's declared
  one. That is what stops a browser sniffing the bytes and deciding an uploaded
  file is something executable. Both it and `Content-Disposition` are *signed*
  overrides, so a holder of the URL cannot change them.
- `contentDisposition()` strips CR/LF/quote/backslash from the filename. The
  filename is uploader-chosen and travels into a response header; a newline
  splits the header and lets an uploader inject headers of their own into a
  response served from the bucket's origin.
- **A test asserts nothing is signed when the document is invisible.** The 404
  alone does not prove it: a refactor that presigned before the lookup would
  still throw 404 and still have minted a working URL to another practice's
  bytes — and object storage has no RLS to undo that.

## The row → contract projection is shared, in `common/documents/`

`toDocumentResponse` / `toDocumentSummary` / `toDocumentEvent` / `toExtraction`.
It **moved out of `web-upload/` in this issue** because two modules now project
the same row onto the same contract type, and a module may not reach into
another's internals. A second copy is how the write surface and the read surface
start disagreeing about what a `Document` is — the drift the generated contract
exists to prevent. `Document` is built from `toDocumentSummary` plus the detail
fields, so a field cannot be present in one and missing from the other.

⚠ **`DocumentSummary.businessId` is required and non-nullable in the contract,
but an UNROUTED document has `business_id = null` by design** — "we do not yet
know whose this is" is a real, visible state, and the Unrouted queue is a
first-class surface this endpoint has to list. The two cannot both be honoured.
The projection emits `''`, which is the least-bad option and is **a lie a caller
must not treat as a business id**. `openapi.yaml` is LAW (G7); this needs a
contract change, raised on #76.

⚠ **`DocumentEvent.detail` is NOT redacted.** The contract says it is "redacted
for callers without admin rights", but `ScopeContext` carries no role today, so
there is nothing to branch on. Every caller who can see the document sees its
full detail. Said out loud here rather than left to be assumed — see TODO.

**`toExtraction` separates the smuggled `lineItems` key (METH S7, #137).** The
extraction lane stores line items INSIDE the `fields` jsonb (the no-schema-change
rule), but the contract types `fields` as a strict map of `ExtractedField` and
gives line items their own optional `Extraction.lineItems` — the generated
client enforces that strictly, so serving the jsonb unchanged failed every
extracted `GET /documents/{id}` in the browser. The projection now surfaces the
array under its contracted name (omitted, never nulled, when absent) and strips
the key from `fields` either way. Pinned in `common/documents/
document-response.test.ts`, including the malformed-value refusals.

## Tests

```bash
pnpm --filter @neoting/api test        # unit, offline
```

`documents.controller.test.ts` covers the second principal on
`getDocumentOriginal`: which context each caller runs under, that a blank
`Authorization` header falls to the cookie, that an empty grant is an
indistinguishable 404 with nothing reaching the service, and that the other four
reads still take no header. What the DATABASE then does with the delegated
context — the grant actually bounding the read, and nothing being signed outside
it — is `modules/portal/portal-client-surface.integration.test.ts`, because only
Postgres can answer it.

`documents.service.test.ts` drives a recording fake Prisma: the assertions are on
the `where` / `orderBy` / `take` that reach the database, not on Prisma working.
The two that exist for security rather than behaviour are *"NOTHING is signed for
a document RLS cannot see"* and *"the child list is NEVER queried when the parent
document is invisible"* — both assert a negative that a status-code assertion
alone would not catch.

⚠ **There is no HTTP-level test, and the #77 acceptance criterion asks for one**
("through the API, not only through SQL"). It cannot be written on this branch:
`@nestjs/testing` and `supertest` are **not** devDependencies of `apps/api`, and
there is no HTTP test surface anywhere in the repo — no `Test.createTestingModule`,
no `app.getHttpServer()` in any existing test. Adding a dependency requires
stopping and asking a human (root `CLAUDE.md`), so it is not done unilaterally.
The service-level tests cover the branching; what is *not* covered is the
controller → guard → service → RLS path end to end.

## TODO

- [ ] ⚠ **FOUR CALL SITES IN FENCED MODULES STILL SERVE DELETED DOCUMENTS.** The
      helper exists and every site this lane owns uses it, but
      `modules/{portal,exports-public-api,chat-framework,rules-suggestions}` were
      off-limits to the agent that built this (other agents live in them), so
      each still needs a one-line `...notDeleted()` added to an existing `where`:

      | File | Line | What leaks |
      |---|---|---|
      | `portal/portal-documents.service.ts` | `whereFor()` ~125 | **A deleted document is still visible to the CLIENT in their portal** — the sharpest of the four |
      | `portal/portal-context.service.ts` | `count` ~185 | `PortalSummary.documentsSent` counts Trash |
      | `exports-public-api/api/exports.service.ts` | `publishedWhere()` ~523 | Trash can enter an export selection. Mitigated but not closed: `publish.batch` already refuses to RELEASE a deleted document, so nothing new can reach `PUBLISHED` while deleted |
      | `chat-framework/suggestions.service.ts` ~152, `grounding.ts` ~85, `display.ts` ~56 | | Chat counts and grounding see Trash |
      | `rules-suggestions/coding/supplier-coding.service.ts` ~547 | | Coding history learns from deleted documents |

- [ ] **Retention/expiry for DOCUMENTS does not exist and was not invented.**
      `documents` has no expiry or retention column; `vault_items.expires_at` is
      the only domain expiry in the schema and is what `expiring` counts. A real
      document-retention feature (D12's six-year clock) would need: a column or
      a per-practice policy table, a scheduled sweep, a
      notice-before-destruction surface, and a decision about what happens to a
      document whose retention expires while an export link still resolves to it
      — which is the same D43 question `document.purge` answers by refusing.
      AutoEntry publishes a concrete "minimum seven years, 13 months after
      cancellation"; Xero says only that it "varies by region". A concrete
      published number would be a genuine differentiator. **Not built. Scope
      discipline over completeness.**

- [ ] Consider AutoEntry's *"delete is refused while extraction is in flight"*
      guard (`docs/research/dext-document-management.md` §10.4 C1) for
      `RECEIVED`/`PROCESSING`. Deliberately NOT added: our delete is reversible
      and the row survives, so a pipeline finishing against a soft-deleted row is
      harmless, and adding a refusal the parallel frontend is not coded for would
      break it. Revisit with the screen in front of you.

- [ ] **Blocked, needs approval:** add `@nestjs/testing` + `supertest` as
      devDependencies so the cross-practice 404 can be proven through HTTP. This
      is the one open half of #77's acceptance criteria.
- [ ] `DocumentEvent.detail` redaction, once `ScopeContext` carries a role.
- [ ] Contract change (Shakib, G7): `DocumentSummary.businessId` must admit null,
      or the Unrouted queue cannot be represented honestly.
- [ ] `q` is `contains` (ILIKE substring), not full-text, and it **sequentially
      scans** — see the filters section. A `pg_trgm` GIN index (or real FTS on a
      `tsvector` column) is a `prisma/` change, so a contract-change issue.
- [ ] Contract change (Shakib, G7): `listDocumentEvents` and
      `listDocumentExtractions` declare no `400` response, but both can return
      one — a malformed or replayed `cursor` is a 400 from `decodeCursor`. A
      client generated from the spec has no branch for it.
- [ ] Contract change (Shakib, G7): sorting by `totalPence` or `documentDate` has
      no supporting index. `documents` is indexed on `(businessId, receivedAt)`
      and `(businessId, byteHash)` only, so those two sorts are a scan-and-sort
      over everything RLS leaves visible.
- [ ] Update this file on exit.
