# archive-vault-search — the Document Vault add-on (D51)

**Built:** 21 September 2026 · **Decision:** D51 · **Lane L** · **SoT:** §4 Stage 11, §10

## ⚠ This is NOT SoT §10's Document Vault, and `vault_items` is untouched

SoT §10 describes a **practice-facing** store of NON-TRANSACTIONAL paperwork —
contracts, leases, insurance policies, MOTs — with AI auto-naming, key-date
extraction, expiry reminders, folder templates and a "To review" tab. The
`VaultItem` model has existed since the init migration for exactly that, and
**nothing in this directory reads or writes it.** That feature is still unbuilt.

What IS built is what was actually asked for on 21 September 2026: **the
client's own documents — the receipts and invoices already in the pipeline — in
the client's own portal, searchable, downloadable one at a time or all at once,
and copyable into a Google Drive or OneDrive they connect themselves.** £2/month
on top of the £8.50 (D48).

If you are here to build §10, none of this is in your way and none of it is a
head start: different table, different reader, different surface.

## What the add-on gates, and what it must never gate

| Free, as it always was | The add-on buys |
|---|---|
| the client's document list | the Vault surface |
| searching it | the whole-file ZIP |
| opening one document | the copy into Google Drive / OneDrive |

⚠ **Taking the first column away would be selling somebody their own paperwork
back.** `assertMayUseVault` therefore guards exactly three methods and the
search guards none — `withSearch` lives in `modules/portal` and is reached by
the ordinary list operation. A lapsed client keeps their list, which is what
D32 promises and what they had before they ever bought the add-on.

`mayUseVault` requires the add-on flag **and** an entitled subscription status.
An add-on riding a `CANCELED` subscription is not a paid feature.

## ⚠ THE CONSENT CALLBACK CANNOT CARRY A PORTAL SESSION

This is the one design decision in here that is not obvious and is load-bearing.

The ledger's connect flow rests on **two independent halves**: the signed
`state` proves the callback belongs to a request this server started, and the
practice's session COOKIE proves who is holding it. `common/oauth/oauth.ts`
says it outright — *the state is not a credential and is not treated as one.*

A portal session is a **bearer token in a header**. A vendor's 302 cannot send
a header. So if Google redirected straight to an API route here, the signed
state would be the ONLY thing authorising the write — and whoever held that URL
could bind **their** drive to this client's business, after which the client's
next copy would put every document into a stranger's storage. That is a real
exfiltration path, not a theoretical one.

**So the redirect lands on the WEB APP** (`/portal/vault`, a query on the tab's
own address — which is also why `PORTAL_SECTIONS.Vault` is deliberately empty).
The portal holds the bearer and POSTs `code` + `state` to
`POST /portal/vault/connections/complete`. Both halves are back, and
`complete()` refuses when `state.b` and the bearer disagree about the business.

⚠ `GOOGLE_DRIVE_REDIRECT_URI` / `ONEDRIVE_REDIRECT_URI` therefore point at the
**web app, not this API** — the opposite of the four ledger ones. And they must
match each vendor's registration byte for byte, which is the trap the ledger
paid for twice.

## The files

| File | What it owns |
|---|---|
| `drive-vendors.ts` | Google Drive and OneDrive as DATA — endpoints, scopes, upload ceilings |
| `drive-adapter.ts` | whose account · make a folder · put a file in it. Nothing reads a drive |
| `drive-token-store.ts` | read → refresh → **conditional** persist; health |
| `drive-connections.service.ts` | connect / complete / disconnect |
| `vault.service.ts` | entitlement, the archive's entries, the export runs |
| `vault-export.runner.ts` | the copy itself, re-drivable from its own rows |
| `vault.controller.ts` | the six portal routes |
| `vault.tokens.ts` | DI symbols, in their own file so the controller need not import the module |

Shared, and deliberately not re-implemented: `common/oauth/` (the flow and the
AES-256-GCM token vault — **one implementation in this repo, not two**),
`common/zip/store-zip.ts`, `modules/portal`'s `portalVisibleDocuments`,
`modules/billing`'s entitlement seam, `ingestion-routing`'s `DocumentStore`.

## The rules inherited from the ledger, because they are about talking to a vendor

1. **No external HTTP call holds a tenant transaction open.** Every vendor call
   sits between short `scopedDb` transactions. The `⚠ THE VENDOR CALL` comments
   are where that is load-bearing.
2. **A per-file failure is a RESULT, not a throw.** A run of four hundred where
   Google refuses one copies the other three hundred and ninety-nine. Only
   `createFolder` throws — a run with nowhere to put anything has not begun.
3. **Zod at every boundary.** Vendor JSON is untrusted input.
4. **Rotation.** ⚠ **Microsoft rotates refresh tokens; Google does not.** So
   OneDrive is in Xero/QuickBooks/Sage's class and Google is in FreeAgent's.
   `drive-token-store.ts` persists with
   `updateMany({ where: { id, tokenRef: <exactly what we read> } })` —
   optimistic concurrency on the ciphertext itself.

## Per-vendor, the bits that bite

- **Google Drive** — ⚠ **`drive.file` is NOT a restricted scope**, which is the
  whole verification story: it reaches only files this app created, needs no
  security assessment, and is exactly what a one-way copy needs. The cost is
  that we can never see a folder a client made by hand, so each run creates its
  own. ⚠ **`access_type=offline` AND `prompt=consent` are BOTH load-bearing** —
  without the first Google issues no refresh token at all; without the second it
  issues one only on a user's very first authorisation, so a disconnect and
  reconnect yields a connection that dies in an hour and cannot be renewed.
  Multipart upload is hand-built because Google wants `multipart/related` and
  `FormData` emits `multipart/form-data`.
- **OneDrive** — ⚠ `offline_access` is a **SCOPE**, not a parameter; there is no
  `access_type` to ask with. `common` as the tenant so both personal and
  work accounts can connect. The `items/{id}:/{name}:/content` colon syntax is
  the only way to create a file by name under a known folder in one call.

## ⚠ An unreadable document is SKIPPED, and that hid an empty archive once

`archiveEntries` logs and skips a document whose bytes cannot be read, so one
missing object does not deny a client the other three hundred and ninety-nine.
Driven locally on 21 Sep 2026 that produced a **22-byte archive** — the EOCD
alone — because `prisma/seed.ts` writes `documents` rows with `s3_key` values
and never uploads the objects. Fifteen warnings in the log, a valid empty ZIP on
the client's disk, and nothing on screen saying so.

The skip is still right and the seed is still the reason. **But an archive where
EVERY document was skipped is not the same thing as a client with no documents**,
and today the product cannot tell those apart. Worth closing before a real
client meets it.

## Tests

```bash
pnpm --filter @neoting/api test -- store-zip          # the ZIP writer, unit
pnpm --filter @neoting/api test -- portal-documents   # the search + LIKE escaping
```

⚠ **The ZIP tests read the archive back THROUGH its central directory rather
than asserting the bytes the writer just produced.** The first draft put the
directory's size and offset at EOCD bytes 14 and 18 instead of 12 and 16; every
field-by-field assertion passed, because the writer and the assertion shared the
same wrong number, and Python's `zipfile` refused the file outright. A reader is
the only shape that catches it.

## Current state, honestly

✅ **Proven by driving the deployed-shaped local product** (21 Sep 2026), as the
client: sign in → Vault tab → search → Download as ZIP → the file on disk, and
Python's `zipfile` confirming 15 entries with every CRC intact. The add-on gate
was checked in both directions — off shows the offer and refuses the archive
with `NT-BIL-003`, on serves it.

⚠ **NEITHER DRIVE HAS EVER TALKED TO A REAL VENDOR.** No Google Cloud project
and no Azure app registration exist yet, so `GOOGLE_DRIVE_CLIENT_ID` and
`ONEDRIVE_CLIENT_ID` are empty, every connect refuses with "not configured on
this deployment", and the adapters are unexercised. The ledger work is the
standing evidence for what that means: **eighteen fixes to get two bills right,
not one of them visible to a green test suite.** Assume the same here.

## TODO

- [ ] **Register the two applications** — a Google Cloud project with the Drive
      API enabled and `drive.file` on the consent screen, and an Azure app
      registration with `Files.ReadWrite` + `offline_access`. Then walk a real
      connect → copy → the file in the vendor's own screen, which is the only
      acceptance evidence that counts.
- [ ] ⚠ **Google's unverified-app cap is 100 users** and shows a warning screen.
      Fine for a pilot, not for a hundred practices. Verification is a form and
      a wait, and it should start early.
- [ ] The export runner is invoked inline, not on BullMQ — the ledger
      follow-up's exact standing. It is re-drivable from its QUEUED rows, so
      moving it is a worker change with no call-site change.
- [ ] An all-skipped archive should say so rather than being a valid empty ZIP
      (see above).
- [ ] A sweep for `vault_exports` rows stuck RUNNING because a process died.
      The `@@index([state])` is there for it.
- [ ] SoT §10's actual Document Vault (`vault_items`) is still unbuilt.
- [ ] Update this file on exit — it is how the next session picks up.
