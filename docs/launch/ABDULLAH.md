# Abdullah — the backend spine and the export

Read `docs/launch/PLAN.md` first. It holds the rules, the dependency order and what "done"
means. This file holds your stages.

**To run one:** attach the codebase and this file, then say *"Finish stage A5."*

You own the acceptance test. SoT §24.7 ends *"click through from a VT entry to the source
document. That last clause is the acceptance test. Everything before it is table stakes."*
That clause is A8 and A10.

**Stages that can run at the same time** (disjoint paths, no shared dependency beyond S0):
A1 · A3 · A4 · A5 · A7. Fan out across agents.

---

## A1 · An accountant can create an account

**Needs:** S0. **Owns:** `apps/api/src/modules/auth-tenancy/`.
**Blocker.** Your first customer literally cannot log in today.

```
Read apps/api/src/modules/auth-tenancy/ in full.

demo-credentials.ts IS the credential system: a frozen two-entry table (shakib@neoting.test,
abdullah@neoting.test) with published fixture scrypt hashes. There is no signup endpoint —
the contract has only /auth/sessions, /auth/sessions/current and /me. Nothing writes
users.password_hash or totp_secret_ref at runtime. Only prisma/seed.ts creates a Practice,
User or Membership.

BUILD practice signup, using the S0 contract surface:
- POST /v1/practices creates a practice, its first user as PRACTICE_ADMIN, and the
  membership, in one transaction.
- Password hashing follows whatever demo-credentials.ts already uses (scrypt) — do not
  introduce a second scheme.
- Email must be unique and verified before the account is usable. Use the notifications
  module from S2 for the verification mail; if S2 has not merged, build against its seam
  and say so.
- The first user is the super admin (D44's release authority).

⚠ TENANCY. A signup runs with NO session — it is creating the tenant. That is the one
legitimate unscoped write in the system. Isolate it in a single, heavily commented
function; do not loosen scopedDb anywhere else to accommodate it. Every subsequent query
in the request must be scoped to the practice just created.

⚠ Keep demo-credentials.ts working for local development but make production refuse it,
the way env.ts already refuses AUTH_MODE=fixture.

Coverage floor on this path is high — it is auth. Test the refusal cases, not just the
happy one: duplicate email, weak password, unverified login attempt.

Full gate. PR.
```

---

## A2 · Real MFA, and a lockout

**Needs:** A1, S1. **Owns:** `apps/api/src/modules/auth-tenancy/`, `portal/`.

```
Two security holes, both currently wide open.

1. THE OTP IS THE LITERAL STRING '000000'. auth.service.ts verifyTotp and the portal path
   both accept it, and OTP_MODE admits only 'demo'. A universal second factor on an account
   holding other people's financial records is not a shortcut to defer.
   Use otplib: QR enrolment, verify, recovery codes. S1 extends the enum; make production
   refuse 'demo'.

2. NO RATE LIMITING OR LOCKOUT ANYWHERE IN THE API. The otp_sessions table HAS `attempts`
   and `locked_until` columns and nothing reads or writes them. A six-digit code with
   unlimited attempts is a four-digit code by lunchtime.
   Implement attempt counting and lockout on both OTP paths, and add basic rate limiting to
   the sign-in and portal-session endpoints.

Test the refusal paths specifically. The coverage floor on the ActionProposal path is 95%
and auth is held to the same standard.

Full gate. PR.
```

---

## A3 · Uploads are actually sanitised

**Needs:** S0. **Owns:** `apps/api/src/modules/ingestion-routing/web-upload/`, `queue/ingest-processor.ts`.
**Blocker, and a privacy problem.**

```
Read apps/api/src/modules/ingestion-routing/web-upload/web-upload.service.ts and
queue/ingest-processor.ts.

Web and portal uploads SKIP SANITISATION ENTIRELY. web-upload.service.ts persists
`mimeType: claims.mimeType` — whatever the browser said — with a comment admitting
"the worker's web-upload sanitisation step is a follow-up". Confirmed: grep for web_upload
in ingest-processor.ts returns nothing, and worker/main.ts hands the imageNormaliser and
documentGuard only to the WhatsApp media path. So the documentId branch goes straight to
dedupe and extract.

Three consequences, all real:
- An iPhone HEIC stays HEIC. Under EXTRACTOR=bedrock that is an instant NT-EXT-003, so
  "upload a receipt from your phone" — a named §24.7 step — fails on the most common phone
  format.
- EXIF is never stripped, so we retain clients' GPS coordinates. sharp-image-normaliser.ts
  calls this a privacy liability in its own header. The privacy notice says we do strip it.
- mimeType is attacker-controlled, so magic-byte sniffing never happens on this path.

Wire the SAME sanitisation the WhatsApp path already uses into the web-upload and portal
branches: magic-byte sniffing, extension allowlist, size cap, EXIF/orientation handling,
HEIC to JPEG, PDF safety.

Do not write a second implementation. Reuse the existing one — a second sanitiser is a
second thing to get wrong.

Full gate. PR.
```

---

## A4 · The extractor accepts real documents

**Needs:** S0. **Owns:** `apps/api/src/modules/extraction/bedrock-extractor.ts`.
**Blocker.** Gates S5.

```
Read apps/api/src/modules/extraction/bedrock-extractor.ts.

SUPPORTED is {png, jpeg, webp, gif}. ACCEPTED_FORMATS in ingestion admits pdf, doc, docx,
odt, rtf, zip, bmp, tiff, heic. So a supplier PDF invoice — the commonest UK business
document — is accepted at the door and then returns NT-EXT-003, "images only".

There is also MAX_IMAGE_BYTES = 5MB with NO DOWNSCALE anywhere (sharp-image-normaliser.ts
never calls .resize()), so an ordinary 48MP phone photo is NT-EXT-007.

FIX BOTH:
1. PDF support. Claude accepts a PDF through the `document` content block — a different
   request shape from the image block. Add it. A multi-page PDF should read at least the
   first N pages; say what N is and why.
2. Downscale before encoding. A photo larger than the limit should be resized to fit, not
   refused. Do it in the normaliser so every path benefits, and keep the guard as a
   backstop for what downscaling cannot fix.

⚠ KEEP THE UNTRUSTED-CONTENT WRAPPING. The filename and any document text go through
wrapUntrusted() before the model sees them — bedrock-extractor.test.ts pins the exact
hostile-filename case. Do not regress it while changing the request shape.

⚠ NO FALLBACK TO FIXTURES. select-extractor.ts deliberately has no fallback: a failed read
must be a FAILED document with a reason, never invented data. Do not reintroduce one.

Extend bedrock-extractor.test.ts for both new paths. Full gate. PR.
```

---

## A5 · A document can reach Published

**Needs:** S0 (the `IntegrationKind` enum). **Owns:** `apps/api/src/modules/validation-dedupe/proposals/publish-batch.ts`, `publishing/`.
**Blocker. Without this the export has nothing to export.**

```
Read apps/api/src/modules/validation-dedupe/proposals/publish-batch.ts, especially
resolveIntegration and the refusal at ~line 298.

publish-batch.ts throws ProposalExecutionRefused("this client has no active ledger
connection — connect one before publishing"). resolveIntegration is the only door.
`integration.create` appears exactly twice outside tests, both in prisma/seed.ts. There is
no OAuth flow and no endpoint. And IntegrationKind was {XERO, QUICKBOOKS, SAGE, FREEAGENT}.

So today NOTHING CAN EVER REACH PUBLISHED. Documents stop at READY forever, publish-follow-up.ts
is the only writer of that state, and §24.7 cannot run.

S0 adds VT and MANUAL to the enum. Use it:
- A client is created with a VT (or MANUAL) integration by default — there is nothing to
  connect, which is exactly what D47 intends.
- publish.batch stops demanding a ledger connection and instead marks the documents
  released for export.

⚠ D42 IS THE WHOLE POINT HERE. Published is an INTERNAL state meaning approved and
released for export. It asserts NOTHING about a ledger. Do not reintroduce a LedgerAdapter
call, do not "publish" anywhere, and make sure the audit trail says released-for-export
rather than posted.

⚠ D44: only the practice super admin may release. If A12 has not merged, leave the hook
where A12 will attach and say so.

The publishes rows, idempotency keys and the QUEUED -> SUCCEEDED lifecycle all stay — they
are correct and they are what makes an export auditable.

Full gate. PR.
```

---

## A6 · Something to code against

**Needs:** A5. **Owns:** `apps/api/src/modules/rules-suggestions/`.
**Cut #4 beyond the seeded chart of accounts.**

```
Read apps/api/src/modules/rules-suggestions/CLAUDE.md — it is the only file in the module —
and SoT §24.4.

Two related holes:
1. THERE IS NO CHART OF ACCOUNTS. prisma/schema.prisma has `categoryCode String?` — free
   text, no enum, no COA model. The VT export has to emit "Cost of sales: Purchases", so it
   needs somewhere to map from.
2. NOTHING CODES A DOCUMENT. With rules-suggestions empty, categoryCode stays null and
   every document lands in To Review for a human to code by hand.

MINIMUM THAT MAKES THE PRODUCT WORK — do this much and stop:
- A per-business chart of accounts, seeded from the business-type profile captured at
  intake (the first client is a cleaning agency). Three or four hardcoded JSON profiles.
  §24.4 calls a versioned pack a deliverable of lane D; that is not this week.
- A supplier-name -> account rule, so the second invoice from the same supplier codes
  itself.

DO NOT build the four-tier rule engine, natural-language rule parsing, or AI coding
suggestions. A human coding it by hand is an acceptable product; a wrong code applied
silently is not.

⚠ Authority order is absolute even in this reduced form: an explicit accountant rule beats
everything, and nothing overrides a human's correction.

Full gate. PR.
```

---

## A7 · The canonical model and the VT emitter

**Needs:** S0. **Owns:** `apps/api/src/modules/exports-public-api/`.

```
Read SoT §24.3 and docs/launch/PLAN.md.

Build the canonical export model and the VT Transaction+ emitter in
apps/api/src/modules/exports-public-api, currently an empty skeleton.

THE FORMAT — VT's Universal Input Sheet, this exact column order:
Type, Ref no, Date, Primary account, Details, Total, VAT, Analysis, Analysis account,
Entry details, Transaction notes

Semantics, from VT's own help:
- Type: PIN/PCR supplier, PAY/CHQ/REC bank, SIN/SCR customer.
- Amounts ALWAYS POSITIVE. VT derives debit/credit from Type. Do not sign them.
- Primary account: the account NAME ONLY, no ledger prefix.
- Analysis account: MUST carry the prefix — "Cost of sales: Purchases".
- Analysis is net, Total is gross, VAT is the VAT amount. Integer pence internally,
  formatted to 2dp only at the emitter boundary. NEVER a float in the domain.
- Date: DD/MM/YYYY.

TWO LANDMINES FROM VT'S OWN CHANGELOG THAT WILL CRASH OR CORRUPT A REAL IMPORT:
1. VT builds older than May 2025 CRASH on any numeric token longer than 16 digits. Never
   emit one — not in a reference, a note, or inside a URL.
2. The Entry details column has a documented history of coercing numeric-looking strings
   into 2-decimal numbers. Anything you put there must contain at least one letter.
Write a test for each.

Structure it as a canonical row model plus a per-target emitter, so VT is one emitter and
not the architecture — §21 names scope capture by one client as a risk. Do not build the
Xero or Sage emitters; D42 puts them out of this release.

Full gate. PR.
```

---

## A8 · The source-document link

**Needs:** A7. **Owns:** `apps/api/src/modules/exports-public-api/`, the `/d/{token}` route.
**This is the acceptance test.**

```
Read §24.3.2 and D43.

Ship all four rungs — they are near-free and they de-risk an unconfirmed assumption:
1. A short capability token per document. Unguessable, view-only, revocable,
   access-logged.
   ⚠ MUST contain at least one letter — VT coerces numeric-looking strings in Entry details.
   ⚠ Under 20 characters — target reference fields truncate SILENTLY, one at 30 and another
     at ~25.
2. GET /d/{token} — unauthenticated by design; the token IS the authorisation. Document
   that in the file header, because it is the one route outside the session wall.
3. Token in Entry details; the full https:// URL plus "Imported from Neo Accounting" in
   Transaction notes.
4. A manifest CSV zipped with the original documents, each named by its token — so the
   link works even if VT renders nothing clickable.

⚠ THIS ROUTE IS AN UNAUTHENTICATED URL TO A CLIENT'S FINANCIAL DOCUMENT. The token is the
whole authorisation, so it needs: an expiry, a per-token and per-IP rate limit, revocation,
and an access log. None of those are optional extras here, and the privacy notice states
we have them.

Full gate. PR.
```

---

## A9 · The export screen

**Needs:** A7, A8. **Owns:** the export API surface + its screen in `apps/web/src/views/`.

```
Build the export surface: pick a client and a period, download (a) the VT import file and
(b) a ZIP of source documents named by their capability tokens.

DELIBERATELY FAKE THE LIFECYCLE. Generate synchronously in the request. No QUEUED state, no
worker, no async job, no progress polling. Cap the batch and say so in the UI when it is
hit. We are not building an export pipeline, we are building a download button that works.

COPY — this is D42 compliance, not style:
- "Export for VT" or "Download VT import file". NEVER "Send to VT", never "Publish to VT",
  never anything implying transmission. Nothing is sent.
- Published is an INTERNAL state meaning approved and released for export.

The UI is in apps/web: @neoting/contracts for data, react-intl for every user-visible
string (neoting/no-literal-string-in-jsx is an ESLint ERROR), design tokens for colour —
no hex literals in classNames, nothing lints that and a miss silently breaks the light
theme.

⚠ Coordinate with Mubasshir before touching shared components. Your paths are the export
view and the API; his are the shell, landing and portal.

Full gate. PR.
```

---

## A10 · The round trip — manual, on Windows

**Needs:** A9. **Owns:** nothing.
**Do this as early as A9 allows.** It can invalidate A7's design, and finding that out at
the end is fatal.

```
MANUAL. Needs a Windows machine and VT's free 60-day trial (VTInstaller from
vtsoftware.co.uk).

Generate an export containing: one supplier invoice with VAT, one zero-VAT line, one
document spanning two nominals, and one supplier name with BOTH a comma and an accented
character.

Transaction > Universal Input Sheet > Import from CSV File.

ANSWER FOUR THINGS AND WRITE THEM INTO §24.3.1:
(a) ENCODING — unknown. Nothing in 470k lines of VT research states it. Emit the same file
    three times: UTF-8 with BOM, UTF-8 without, Windows-1252. Which keeps the accent and
    the comma intact?
(b) DATE FORMAT — DD/MM/YYYY is inferred from VT's COM API, never stated. Two rows confirm
    or refute it.
(c) IS THE URL CLICKABLE in Transaction notes? §24.7's acceptance test depends on it. If it
    is not, rung 4 (the ZIP + manifest) becomes the primary route rather than the fallback.
(d) Does Analysis account accept a bare account CODE, or only "Ledger: Account"? If only
    the name, confirm the right-click > Convert dialog with a saved conversion table works.

Confirm the client runs VT Transaction+, not Cash Book. Cash Book has NO import of any
kind — the Universal Input Sheet is a Transaction+ / Accounts Suite feature.
```

---

## A11 · Client intake

**Needs:** S0. **Owns:** `apps/api/src/modules/clients-team-settings/`.

```
Read SoT §24.5, D47 and D44. Build apps/api/src/modules/clients-team-settings, currently an
empty skeleton: client intake, the client list, team management, a settings shell.

D47 IS THE SHAPE OF THIS STAGE: adding a client asks for NEITHER a bank connection NOR an
accounting-software connection. Both steps are skipped. If you find yourself building a
connection step, stop — you are building the wrong product.

What intake MUST capture instead is the BUSINESS-TYPE PROFILE. §24.4 makes it the
substitute for the ledger-synced chart of accounts this release does not have, so it is not
optional — it is the only context the coding engine gets, and A6 seeds from it.

Creating a client also creates its VT/MANUAL integration row (see A5), so the document can
later reach Published without anyone connecting anything.

D44: accountants and their team compose and edit; only the firm's super admin releases.

scopedDb(ctx) everywhere. Zod at every boundary. Stay inside the S0 contract; if you need a
field it does not cover, STOP and say so rather than editing packages/contracts or prisma/.

Full gate. PR.
```

---

## A12 · The release gate

**Needs:** A5, A11. **Owns:** `apps/api/src/modules/approvals/`.

```
Read D44 and Governance §10, §11.2.

Today ANY authenticated member can approve a chase.send — a text or email to someone else's
client — or a publish.batch. Those are the two irreversible outward acts in the product.

Add the server-side check, assertCan(actor, 'publish.release', resource), on the approve
path in modules/approvals. NOT in the UI. A hidden button is presentation; the server check
is the rule. Make the UI degrade honestly for a user without the permission rather than
pretending the action does not exist.

Also: document.reprocess and document.reject are registered as notImplemented(...) in
validation-dedupe/proposals/registry.ts. A document that fails extraction therefore cannot
be retried and a wrong one cannot be rejected — both are ordinary things an accountant will
try on day one. Implement them.

The coverage floor on the ActionProposal path is 95%. Test the refusals.

Full gate. PR.
```

---

## A13 · Chase by email

**Needs:** S2, A5. **Owns:** `apps/api/src/modules/chase/`.
**Cut #2 — trigger hour 22.**

```
Read modules/chase/CLAUDE.md and SoT §24.2.3.

The chase module is genuinely built — detection engine (a), composition, the portal token,
the chase.send executor, all proven against a real database. What it has no transport for
is delivery: SMS_SENDER admits only 'demo', which writes an outbox row and sends nothing.

Add an email sender behind the SAME seam, using the notifications module from S2. Config,
not import — the house pattern.

Ship ENGINE (a) ONLY: a bank line with no matched document. §24.2.3 argues it is the
differentiator; (c) period-gap and (e) expected-recurring are additive later.

⚠ Every message is shown VERBATIM in review before sending. That invariant predates this
push and is absolute — do not add a path that sends without showing.
⚠ Do not over-ask. Suppress against documents already received and chases already open.
Chasing a client for something you already have is how the product loses trust in week one.

Full gate. PR.
```
