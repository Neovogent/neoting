# ingestion-routing / storage

**Source of Truth:** SoT §4 Stage 1–2 · **Added by:** issue #16

## Purpose

Object storage for sanitised documents. `processEmail` sanitises an attachment
and would otherwise drop the bytes — the job then describes a document that
exists nowhere. This stores the sanitised bytes; the job carries the key.

`DocumentStore.put({ bytes, sha256, contentType, workspaceId }) → StoredDocument{ key }`
· `get(key) → Buffer`. Interface + fixture, the same shape as `VirusScanner` /
`IngestQueue` / `EmailParser`, so unit tests stay offline.

## The key layout — and WHY (this is the part that matters)

`w/<workspace>/documents/<sha256>`, where `<workspace>` is the routed business id,
or `_unrouted` when there is no workspace yet.

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
- **`_unrouted`**: Unrouted mail has no workspace, but the object must still live
  under `w/`. `_unrouted` sits under the prefix (so IAM grants it) and its
  leading underscore cannot collide with a real business id (cuid/uuid). When
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

## TODO

- [ ] Run the MinIO integration test once Docker is installed here — Shakib runs
      it for now (no Docker on my machine).
- [ ] When the S3 trigger + `scopedDb` land, the worker fetches bytes via
      `get(storageKey)` and the object record is persisted.
