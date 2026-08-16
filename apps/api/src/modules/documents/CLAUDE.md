# documents — the read surface

**Source of Truth:** SoT §4 Stage 5 · **Added by:** issue #77 · **Contract:** `GET /v1/documents`, `/documents/{documentId}`, `/{documentId}/original`, `/{documentId}/events`, `/{documentId}/extractions`

## Purpose

Five GETs and nothing else: the queue lists, one document, a short-lived link to
its original bytes, its processing log, and its extraction history.

**There is no write on this module, and that is structural.** A retry is a
`document.reprocess` proposal on the Review → Approve spine (Governance §10), not
a `POST /documents/{id}/retry` here. Because the service class has no mutating
method, there is no side-effect path for one to hide in — the invariant is
enforced by the absence of code rather than by a promise in prose. All five
operations are `x-nt-side-effect: none` in `openapi.yaml`, which
`check-contract.mjs` reads during `pnpm lint`.

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

The envelope is shaped as the contract's `{ data, pageInfo }`, so a service
method returns `toPage(...)` directly and there is no hand-written mapping step
in between to drift from the spec.

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

## Tests

```bash
pnpm --filter @neoting/api test        # unit, offline
```

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

- [ ] **Blocked, needs approval:** add `@nestjs/testing` + `supertest` as
      devDependencies so the cross-practice 404 can be proven through HTTP. This
      is the one open half of #77's acceptance criteria.
- [ ] `DocumentEvent.detail` redaction, once `ScopeContext` carries a role.
- [ ] Contract change (Shakib, G7): `DocumentSummary.businessId` must admit null,
      or the Unrouted queue cannot be represented honestly.
- [ ] `q` is `contains` (ILIKE substring), not full-text. Real FTS needs a
      `tsvector` column — a `prisma/` change, so a contract-change issue.
- [ ] Update this file on exit.
