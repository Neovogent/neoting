# ingestion-routing / storage

**Source of Truth:** SoT §4 Stage 1–2 · **Added by:** issue #16

## Purpose

Object storage for sanitised documents. `processEmail` sanitises an attachment
and would otherwise drop the bytes — the job then describes a document that
exists nowhere. This stores the sanitised bytes; the job carries the key.

`DocumentStore.put({ bytes, sha256, contentType, workspaceId, practiceId }) → StoredDocument{ key }`
· `get(key) → Buffer` · `sha256(key) → hex`. Interface + fixture, the same shape
as `VirusScanner` / `IngestQueue` / `EmailParser`, so unit tests stay offline.

**`sha256(key)` exists so verification never buffers the object.** The S3
implementation iterates the `GetObject` body chunk-by-chunk into the hash, so
peak memory is one chunk; `get()` materialises the whole object in one Buffer
and must not be used to verify an upload — the web-upload completion path is
tested to never call it. The streamed path is only exercised against a real
Body by the MinIO integration test, since the fixture hashes a Buffer it
already holds.

## The key layout — and WHY (this is the part that matters)

`w/<businessId>/documents/<sha256>` once routed, and
`w/_unrouted/<practiceId>/documents/<sha256>` until then.

**Every key MUST start `w/`. This is an IAM constraint, not a style choice.** The
staging task role is granted `<bucket>/w/*` (and `receipts/inbound/*`) and
**nothing else** — see `infra/envs/staging/policies`. A key that ignores the
prefix passes every unit test and then `AccessDenied`s in staging. The reason
lives in an IAM policy in another directory the next person will not think to
read, so it is written here and **proven by a test** (`document-store.test.ts`),
never by inspection.

- **Content-addressed** on the sha256: an identical file stored twice is one
  object, and the key is stable for identical content — what lets an SES
  redelivery collapse rather than duplicate.
- **`_unrouted` is partitioned BY PRACTICE**: `w/_unrouted/<practiceId>/documents/<sha256>`.
  Unrouted mail has no workspace, but the object must still live under `w/` and
  must still belong to somebody. A single shared `w/_unrouted/` prefix would mean
  that two practices receiving the *same* file — a common supplier's invoice
  template, a standard statement PDF — content-address to **one object**. Then
  "erase everything belonging to practice X" (UK GDPR, D12) has no answer: the
  key does not say whose it is, and deleting it destroys the other practice's
  document. Mail from an unrecognised sender is the common case, so that would be
  most of the estate. It also defeats ADR 0008's per-prefix narrowing precisely
  where it matters most.
- **A key needs a workspace or a practice, and `documentKey` throws without one** —
  deliberately mirroring the `documents_tenant_anchor` CHECK constraint in the
  database. An object owned by neither is unreachable and unerasable.
- The leading underscore cannot collide with a real business id (cuid/uuid). When
  routing later assigns a workspace the object is re-keyed; nothing here deletes.

## S3 / MinIO

`S3DocumentStore` on `@aws-sdk/client-s3` (pinned). MinIO locally
(`S3_ENDPOINT=http://localhost:9000`, `forcePathStyle`, static creds) and the real
bucket in staging (empty endpoint → AWS default; task-role creds via the default
provider chain) through the **same code path**, selected by `OBJECT_STORE=fixture|s3`
in `config/env.ts` (Zod).

**No KMS key on `PutObject`.** The bucket's default SSE-KMS encrypts the object;
naming a CMK client-side yields an object only this caller can read.

## Out of scope (issue #16)

No Prisma / DB, no S3-event wiring (Terraform), no lifecycle / retention
(Terraform), no deletion path, no WhatsApp media fetch.

## Tests

```bash
pnpm --filter @neoting/api test                         # unit, offline (integration skipped)
RUN_S3_INTEGRATION=1 pnpm --filter @neoting/api test    # + MinIO round-trip (needs docker compose up)
```

## Presigned PUT (issue #76)

`presignPut({ key, contentType, byteSize, expiresInSeconds })` and `head(key)`
were added for the web-upload lane, where the API never receives the bytes.

**`ContentType` and `ContentLength` are set on the command, so the presigner
folds them into the signature.** The client must PUT with exactly that type and
exactly that many bytes or storage rejects it — which is what makes "the
presigned policy enforces the cap too" true rather than aspirational. The API's
own cap check is the other half; neither is sufficient alone.

The consequence for tests: a fixture `presignPut` returns
`https://fixture.local/…`, a URL nothing fetches, so **no unit test can prove the
signature is right**. If the headers handed to the client are not the headers the
signature covers, every unit test passes and the browser's PUT 403s. Only
`web-upload/web-upload.integration.test.ts` catches that, by doing the real PUT.

An intent is presigned to `w/<businessId>/uploads/<nonce>` (`uploadIntentKey`) —
still under `w/`, still naming the business, but **not** content-addressed,
because the sha256 is not known until the bytes land. Re-keying it onto the
content-addressed path after sanitisation is a follow-up.

## Presigned GET (issue #77)

`presignGet({ key, contentType, filename, expiresInSeconds })` — the read half,
for `GET /documents/{id}/original`. The API serves a **link**, never the bytes.

**Both `ResponseContentType` and `ResponseContentDisposition` are signed
overrides**, folded into the signature rather than left to the object's stored
metadata. A holder of the URL therefore cannot flip either one by editing the
query string.

- The type pinned on the response is the **stored** MIME — magic-byte
  authoritative after sanitisation, never the uploader's declared one. That is
  what stops a browser sniffing the bytes and deciding an uploaded file is
  something executable.
- `contentDisposition()` strips the **whole C0/C1 control range plus DEL**, and
  quote and backslash, out of the filename before it goes in. The filename is
  uploader-chosen and travels into a response header; a newline splits the header
  and lets an uploader inject headers of their own into a response served from
  the bucket's own origin, and an unescaped `"` ends the quoted string early.
  CR and LF are the pair everyone thinks of, but RFC 7230 §3.2.6 forbids NUL
  outright and several HTTP parsers truncate a field at the first one — which
  serves a silently shortened filename rather than failing loudly.
  **This is defence in depth, said plainly rather than overstated:** Postgres
  already refuses NUL in a `text` column, so the storage path cannot currently
  deliver one here. That is not a reason to leave it out — this function is the
  single point where an uploader-chosen name becomes a header, and it should not
  depend on a column type three layers away staying as it is.
  ⚠ Non-ASCII passes through un-encoded. RFC 6266 wants `filename*=UTF-8''…`, so
  `facture-café.pdf` may render mojibake in the download name — cosmetic, not a
  safety bug, and the fix is a second `filename*` parameter (see TODO).

**The caller picks the TTL and `documents` picks five minutes** — the URL is
bearer authority with no session and no RLS behind it, and it lands in an
`<img src>`, so it ends up in browser history, in a `Referer` if the page links
out, and in any proxy log on the way. The store does not have an opinion; the
default is not a safe one to inherit silently, so `ORIGINAL_URL_TTL_SECONDS`
lives at the call site with the reasoning next to it.

Same fixture caveat as `presignPut`: `InMemoryDocumentStore` returns a
`https://fixture.local/…` URL nothing fetches, so **no unit test proves this
signature works**. Only a real MinIO round-trip can, and there is not one for the
GET path yet (see TODO).

## TODO

- [x] MinIO integration test — run by Shakib 14 Aug 2026, object confirmed in the
      bucket at `w/_unrouted/prac_int/documents/<sha256>`. Re-run locally
      16 Aug 2026 (Docker is installed here now; the note saying otherwise was
      stale).
- [ ] Re-key a web-upload object from `w/<biz>/uploads/<nonce>` to
      `w/<biz>/documents/<sha256>` once sanitisation produces the final bytes.
- [ ] A MinIO round-trip for `presignGet` — fetch the signed URL and assert the
      `Content-Type` / `Content-Disposition` that come back are the ones signed.
      The PUT path has one (`web-upload.integration.test.ts`); the GET path is
      currently proven only against a fixture URL nothing fetches, which is
      exactly the gap that made the PUT integration test necessary.
- [ ] RFC 6266-encode a non-ASCII filename (`filename*=UTF-8''…`) alongside the
      ASCII `filename=` in `contentDisposition`, so `facture-café.pdf` downloads
      under its own name instead of mojibake.
- [ ] When the S3 trigger + `scopedDb` land, the worker fetches bytes via
      `get(storageKey)` and the object record is persisted.
