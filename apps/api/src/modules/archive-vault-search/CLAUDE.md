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
EVERY document was skipped is not the same thing as a client with no documents.**
Closed on 23 Sep 2026 at the owner's ruling: `assertArchiveReadable` probes the
first document BEFORE any header and refuses 503 if storage cannot serve it, and
a partial archive carries `MISSING-DOCUMENTS.txt`. Both branches were driven —
every object deleted from MinIO, then two of sixteen.

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

✅ **GOOGLE IS REGISTERED AND REACHES ITS REAL CONSENT SCREEN** (23 Sep 2026).

| | |
|---|---|
| Project | `neo-accounting` ("Neo Accounting"), Google account `revoluon@gmail.com` |
| Consent screen | app name **Neo Accounting**, audience **External**, status **Testing** |
| Scope | `drive.file` only — see the note in `drive-vendors.ts` for why that is the whole verification story |
| Client | "Neo Accounting Document Vault", Web application |
| Redirect URIs | `http://localhost:5173/portal/vault` and `https://neoacc.neovogent.com/portal/vault` — **the WEB APP, not this API** |
| Test users | `revoluon@gmail.com`. ⚠ **0 of 100, and the cap is over the app's LIFETIME** |

Proven by pointing a browser at the URL `connections` actually builds: Google
answered *"Choose an account — to continue to Neo Accounting"*. That rules out
the three failures that cost the ledger work days — an invalid client id, a
`redirect_uri_mismatch`, and `invalid_scope`. ⚠ It does NOT prove the token
exchange, the folder creation or the upload: those need a human to grant
consent, and that half is owed rather than implied.

⚠ **ONEDRIVE IS NOT REGISTERED.** The Azure portal needs a sign-in nobody
automated has, so `ONEDRIVE_CLIENT_ID` is empty and every OneDrive connect
refuses with "not configured on this deployment". The adapter is unexercised.

⚠ **The ledger work is the standing evidence for what "unexercised" means:
eighteen fixes to get two bills right, not one of them visible to a green test
suite.** Assume the same for both drives until a file is seen in a real one.

## TODO

- [x] **Google registered** (23 Sep 2026) — project, Drive API, consent screen,
      OAuth client, both redirect URIs, one test user. Credentials are in `.env`
      (gitignored) and belong in the `ledger`/`auth` secret group on staging.
- [ ] **Azure app registration for OneDrive** — `Files.ReadWrite` +
      `offline_access`, redirect URI on the WEB APP, `common` tenant so personal
      and work accounts both connect. Blocked on a portal sign-in.
- [ ] **Walk a real consent → copy → the file in Google's own Drive UI.** That
      screenshot is the only acceptance evidence that counts, and it is what the
      ledger lane's own TODO demanded four times over.
- [ ] ⚠ **Google's unverified-app cap is 100 users** and shows a warning screen.
      Fine for a pilot, not for a hundred practices. Verification is a form and
      a wait, and it should start early.
- [ ] The export runner is invoked inline, not on BullMQ — the ledger
      follow-up's exact standing. It is re-drivable from its QUEUED rows, so
      moving it is a worker change with no call-site change.
- [x] **DONE, 23 Sep 2026 (owner's ruling)** — an archive nobody can read now
      REFUSES 503 before a header is written, and a PARTIAL one carries
      `MISSING-DOCUMENTS.txt` naming what did not travel. A client with no
      documents still gets a valid empty archive, which is the opposite case
      and is not an error.
- [ ] A sweep for `vault_exports` rows stuck RUNNING because a process died.
      The `@@index([state])` is there for it.
- [ ] SoT §10's actual Document Vault (`vault_items`) is still unbuilt.
- [ ] Update this file on exit — it is how the next session picks up.
