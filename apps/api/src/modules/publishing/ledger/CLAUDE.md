# publishing/ledger — the live ledger connection (D50)

**Built:** 15 September 2026 · **Decision:** D50 (supersedes D42) · **Brief:** `docs/ledger-connect-build-brief.md`

## What this is

A practice connects a client business's books once; thereafter an **approved**
document becomes a transaction in that client's ledger with the original receipt
attached, and the vendor's own reference comes back as proof. Four platforms:
Xero, QuickBooks Online, Sage Business Cloud Accounting, FreeAgent.

⚠ **Export is not retired and never will be.** VT Transaction+ has no API and
neither does anything else in Tier C of `docs/research/ledger-input-api-request-list.md`.
This is a **second** egress. Every string on this lane has to survive that
reading, and `publish-batch.ts`'s export arm still says *released for export*.

## The four rules that govern every file here

1. **No state change outside Review → Approve.** Nothing in this directory
   posts a transaction. `publishBill` is reachable only from
   `validation-dedupe/proposals/publish-follow-up.ts`, which the engine calls
   **after** an approved `publish.batch` commits. The connection surface manages
   credentials and reads lists; it has no publish method, and giving it one
   would be the second door the whole spine exists to prevent.
2. **No external HTTP call holds a tenant transaction open.** Every vendor call
   sits between short `scopedDb` transactions, never inside one. The comments
   marked "⚠ THE VENDOR CALL" are where that is load-bearing.
3. **A per-item failure is a RESULT, not a throw.** `HttpLedgerAdapter` catches
   even a vendor module that throws, because a bug in one adapter must not take
   a batch of forty down. The only throw left is the world being broken.
4. **Money is integer pence, and `ledger-money.ts` is the only boundary.**
   Three of the four vendors put money on the wire as a JSON number.

## Where the tokens live, and why it is not where the brief said

The brief asked for one **Secrets Manager secret per connection**. That was
taken to Shakib on 15 Sep 2026 and he chose otherwise, because the brief's own
premise does not hold:

- Secrets Manager *is* wired — for PLATFORM credentials, at TASK START, through
  the ECS agent's `valueFrom`. That mechanism cannot carry a value minted when a
  practice presses Connect and replaced on every rotation, and the task role is
  deliberately granted no Secrets Manager read at all.
- `infra/envs/<env>/secrets.tf` says in capitals that a client's Xero refresh
  token must never be written there, for two reasons that still hold:
  **$0.40/connection/month** (~£400/month at 1,000 clients, against an
  £8.50/month product) and a **tenancy boundary enforced by IAM instead of by
  RLS**, which is the inversion Governance §5.2 exists to prevent.

So: **the tokens are sealed with AES-256-GCM and the ciphertext lives in the
`integrations.token_ref` column that already exists.** The one secret is the
platform key, `INTEGRATION_TOKEN_KEY`, which belongs in the `auth` group beside
`SESSION_SECRET`. No schema change (which the brief did ask for), no
per-connection cost, tenancy stays on RLS.

⚠ **Rotating `INTEGRATION_TOKEN_KEY` does not re-seal anything.** Every practice
would have to reconnect every client. `token-vault.ts` carries a `v1` prefix so
a staged rotation can be built; it does not exist.

## The files

| File | What it owns |
|---|---|
| `token-vault.ts` | seal/unseal, the state HMAC, constant-time compare |
| `oauth.ts` | authorisation-code flow, signed `state`, token exchange and refresh, Intuit discovery |
| `token-store.ts` | read → refresh → **conditional** persist; health |
| `vendors.ts` | the four as DATA — endpoints, scopes, limits, idempotency windows |
| `ledger-config.ts` | env → credentials, and the two vendors whose HOST changes with sandbox |
| `ledger-money.ts` | integer pence ⇄ the wire, both directions |
| `ledger-http.ts` | one bearer, one Zod parse, one honest `retryable` |
| `attachment.ts` | fetch, downscale, or say why it could not travel |
| `reference-sync.ts` | the client's own accounts/suppliers/tax rates/bank accounts |
| `xero.ts` · `quickbooks.ts` · `sage.ts` · `freeagent.ts` | the per-vendor half |
| `http-ledger-adapter.ts` | the `LedgerAdapter` router — one implementation, four ledgers |
| `ledger-connections.*` | the connect/sync/disconnect surface |
| `refresh-scheduler.ts` | keeps an **idle** connection's refresh token alive |

## ⚠ THE RELEASE SCREENS SAID "for export" OVER A LIVE CONNECTION

Found 17 Sep 2026 by driving a real release against Sandbox Company GB, and it
is the worst thing this lane has done so far.

D42 gave `publish.batch` one egress and one sentence: *Published means approved
and released for export; nothing leaves Neo Accounting on its own.* D50 added a
SECOND egress and left that sentence everywhere. So with QuickBooks connected:

| Screen | What it said |
|---|---|
| Ready tab, "Releases to" | `VT import file` — hardcoded, took no argument |
| Publish dialog title | *Release 1 item for export* |
| Publish dialog body | *Nothing leaves Neo Accounting on its own* |
| **The SERVER's review card** | *Release 1 document for export* · *nothing here reaches accounting software* |

The last row is the serious one. That card is what D44 puts the firm's super
admin in front of, and its hash is what they echo on approve — so the product
was asking a human to authorise an act by describing its exact opposite.

**The rule is symmetric and both halves are load-bearing.** The export arm must
never say *posted*, *synced* or *sent to*; the ledger arm must never say *file*,
*for export* or *nothing reaches accounting software*. `render-summary.test.ts`
now enforces BOTH directions — the export test was there from the start, and
nothing enforced the mirror, which is why this survived.

⚠ **An undeterminable lane names NO destination**, and that is deliberate.
Defaulting to "export" is what produced the defect: the older arm is not the
safer guess, it is the one that understates what approving does.

The lane rides `RenderContext.release`, resolved at FIRST REVIEW from
`resolveTarget` — the executor's own function, exported rather than restated,
because two copies of "which lane is this" can disagree and the card would then
describe an act other than the one approve performs. Not the payload: a
connection can be made or revoked between propose and approve.

## ⚠ The callback must live on the host that holds the SESSION

Found 17 Sep 2026, on the first consent that got far enough to fail properly.

`LedgerConnectionsController.callback` calls `context.require()` — the vendor's
redirect has to arrive carrying the practice's session. The session cookie is
set with **no `domain`** (`auth-tenancy/auth.controller.ts`), so it is
**host-only**, and the web app calls the API **same-origin**
(`VITE_API_BASE_URL` is deliberately unset in `deploy-web.yml`). The cookie
therefore exists on `neoacc.neovogent.com` and nowhere else.

The four applications were registered against `api.neoting.neovogent.com`. Both
names serve the same API behind CloudFront, so every request *worked* — except
the one that needed a cookie. Every vendor's consent ended on
`?connectionError=Authentication+required`, after a correctly formed request and
a completed sign-in, which reads like a broken integration and is a hostname.

⚠ **`SameSite` is a red herring here and cost time.** `lax` already permits a
top-level GET navigation; a **host-only** cookie is not sent to a different host
at any `SameSite` value. Do not go looking at the cookie flags.

The fix is `local.app_host` in `infra/envs/staging/edge.tf`, which
`APP_ORIGIN` and all four `*_REDIRECT_URI` values are now built from, plus one
re-registration per vendor portal. ⚠ **A redirect URI must match byte for byte**,
so the portals and the task definition move together or the consent 400s at the
vendor instead.

## ⚠ THE MONEY SHAPE IS DIFFERENT ON EVERY PLATFORM — read this before editing any adapter

Each line below was established by POSTING A REAL BILL and reading back what the
vendor actually stored. None of it came from a document, and two of them are
the opposite of what the code assumed.

| Vendor | What goes on the line | Tax | Proven by |
|---|---|---|---|
| **QuickBooks** | the **NET** (`totalPence − taxPence`), `GlobalTaxCalculation: 'TaxExcluded'` | a `TaxCodeRef` the client actually has, matched on the code's REAL rate | a £899.99 invoice recorded at **£1,079.99** when sent as gross-inclusive. ✅ **Re-proven correct 20 Sep 2026** — `NT-29SSIAUO2XTGB`, £130.00 + £26.00 VAT = £156.00 on Intuit's own Bill screen, receipt attached |
| **FreeAgent** | the **GROSS**, inside `bill_items[]` | `sales_tax_rate` as a percentage; the read-back is **NEGATIVE** on a purchase | a £156.00 bill recorded at **£0.00**, then at **£130.00**. ✅ **Proven correct 20 Sep 2026** — `WOL-1099`, £86.40 inc £14.40 VAT on FreeAgent's own Bills screen, paperclip showing |
| **Xero** | gross, `LineAmountTypes: Inclusive` | `TaxType` off the synced rates | ✅ **Proven correct 20 Sep 2026** — `NT-2R1HSW0ES391Z`, **Awaiting Payment**, 72.00 net + 14.40 VAT = £86.40 on Xero's own bill screen, PDF attached. ⚠ That view renders *Tax Exclusive* though we send Inclusive; the arithmetic lands on the same total and the returned `Total`/`TotalTax` matched, so `reconcile` stayed silent. WHY the display differs is NOT established — do not build on it |
| **Sage** | not yet posted live | | |

⚠ **Do not "make the four consistent".** They are not consistent. An edit that
unifies them will silently misstate somebody's VAT — which is what each of the
first two did, in opposite directions, on the same afternoon.

⚠ **`TxnTaxDetail` is not sent to QuickBooks and must not be.** Supplying a
second tax figure invites it to disagree with itself: given both, it ignored
ours (£150.00) and booked its own (£180.00).

⚠ **`bill_items` is required by FreeAgent.** `category` and `total_value` at the
top level are accepted, attached to, and returned with a bill URL — and produce
a bill worth nothing, listed in their own screen as "Zero Value".

## ⚠ THREE MORE THINGS A GREEN SUITE CANNOT SEE — the Xero walk, 20 Sep 2026

Every figure on the Xero bill was right the first time. Three other things were
not, and each one is the same shape as the eighteen before it: **a plausible
answer that is wrong and looks ordinary.**

### 1. The bill was a DRAFT, and nothing said so

`NT-2FH97ZFSZ021D` landed in Xero with the right supplier, the right account,
the right tax rate, £899.99 gross and £150.00 VAT — as a **Draft**, with an
unpressed Approve button. A draft is not in the books: not on the P&L, not on
the VAT return, not in Bills to pay, until a human opens Xero and approves it a
second time.

Meanwhile the publish dialog had told the accountant *"Approving creates these
entries in this client's Xero books"*, `reconcile` had compared the figures and
correctly said nothing, the `publishes` row read SUCCEEDED and the document was
PUBLISHED. **Every number agreed and the sentence was false.** That is worse
than a wrong number, because a wrong number is visible.

It was deliberate — the old comment argued Xero's own approval workflow belongs
to the practice — and the owner overruled it on 20 Sep 2026: **post live.** Two
reasons. D44 already reserves release for the firm's super admin, so approving
again inside Xero is the same person agreeing twice. And QuickBooks and
FreeAgent both post live, so DRAFT made one Approve button mean two different
things depending on which vendor a client happened to use.

`xero.test.ts` pins `Status: 'AUTHORISED'`, `LineAmountTypes: 'Inclusive'` and
the gross on the line. **The unit suite was entirely green on the day it shipped
a draft**, because nothing anywhere asserted the shape of the request body.

### 2. The connection screen named the books with a GUID

The Xero card read `Organisation  e5e7917d-6621-4666-8264-d81ccb7758ea`,
directly under its own warning: *"Xero has no test company of its own. Connect
their free Demo Company (UK) unless you mean to write to this client's real
books."* The warning asks a question the line below it cannot answer.

`connectedOrganisation` was **in the contract, described, and hardcoded `null`**
in `toDto` — the field was designed and never filled. Every vendor hands back a
name in the same response that carries the id (Xero `tenantName`, Sage
`displayed_as`, FreeAgent the company `name`), and all three were parsed and
discarded one line later.

`resolveOrgRef` now returns `ResolvedOrg { ref, name? }`, and the name is stored
in the additive nullable `integrations.org_name`. The web already read
`connectedOrganisation ?? orgRef ?? '—'`, so the screen needed no change — the
server was the whole of the bug. ⚠ Null stays permanent for **QuickBooks**,
whose realm id arrives on a query string with no company attached to it.

⚠ **Writing it only at connect was a HALF fix, and the deploy proved it.** The
column shipped, the existing connection read null, and the card still showed the
GUID — fixing a label would have cost a full consent round trip. `sync()` now
resolves the name when it is MISSING, in the same pass that reads the lists: one
extra vendor call, only where needed, outside every transaction, logged and
dropped on failure, never written back to null. Pressing **Sync lists** turned
`e5e7917d-…` into `Neoting Sandbox Ltd` on the deployed product. Same self-repair
principle as the empty-list branch beside it.

### 3. "Release for export" sat as the heading over "Release 1 document into Xero"

The 17 Sep sweep fixed the review card's TITLE and missed the **kind label**
above it — a static `ProposalKind → string` map in two places (`render-summary.ts`
and the web's `proposals.ts`). It is rendered from the kind alone, with no client
and no connection behind it, so it cannot know the lane; it said `Release for
export` and sat as a header over a card whose own title read *Release 1 document
into Xero*.

Both are now `Release documents`, which is true in either lane. ⚠ **Not "into the
ledger" either** — the API's copy reaches an accountant in a denial email
("Not approved: …"), where naming the wrong egress is the same lie with a stamp
on it. The lane is named by the server-rendered title directly below.

## ⚠ The read-back check is the only reason any of that was found

`reconcile` compares what the vendor STORED against what the document says, and
`publish-follow-up.ts` raises a `publish.recalculated` notification carrying its
sentence. Both halves are load-bearing and both were once broken:

- Every adapter used to DISCARD `reconcile`'s answer — three ignored the return
  value, the fourth branched into two identical returns. A £899.99 invoice
  became £1,079.99 behind a green tick.
- The notification then could not be READ: the bell's projection drops
  `payload` (trace ids, session ids), and the web was reading a field it is
  never sent. `NotificationItem.detail` is the contracted sentence now.

⚠ Compare tax by MAGNITUDE where a vendor signs purchases negative (FreeAgent).
A check that fires on every correct bill is worse than no check.

## ⚠ The four things most likely to be got wrong next

1. **Rotation.** Xero, QuickBooks and Sage retire the old refresh token the
   moment it is used. `token-store.ts` persists the new one with
   `updateMany({ where: { id, tokenRef: <exactly what we read> } })` —
   optimistic concurrency on the ciphertext itself, so a second process cannot
   install a token the vendor has already retired. `ledger-lane.integration.test.ts`
   asserts that `where` clause directly, because nothing else can see it.
2. **`LedgerAdapter` is obtained from a FACTORY.** A real adapter reads its own
   client's sealed tokens through `scopedDb`, so it needs a tenant context and
   cannot be a boot-time singleton. `LedgerAdapter` itself is unchanged; only
   who constructs one is (`publishing/select-ledger-adapter.ts` carries the two
   rejected alternatives).
3. **`tokenExpiresAt` on the row is a PROJECTION.** The authoritative access
   expiry is inside the sealed blob. The column exists for the screen and the
   sweep; ageing it does not make the store refresh.
4. **`attachmentSent` must stay honest.** Where a vendor will not take the file,
   the publish still succeeds and the result says `false` with the reason
   logged. Claiming an attachment that did not travel makes D43 unverifiable.

## Per-vendor, the bits that bite

- **Xero** — ⚠ **no sandbox**: a developer connects a REAL organisation, so the
  only safe target is Xero's own **Demo Company (UK)**, and the connection
  screen says so because no flag can. 6-minute idempotency window (short enough
  that a slow retry duplicates — `InvoiceNumber` is the guard that outlives it).
  ~98 float money fields. Two-uncertified-app limit per organisation, invisible
  until it blocks. ⚠ Bills are created **AUTHORISED** — it said DRAFT until
  20 Sep 2026; see "THREE MORE THINGS" above, because a DRAFT bill is not in
  the books and nothing in the product said so. Still one line in `xero.ts` and still
  deliberately not an environment variable.
- **QuickBooks Online** — ⚠ **no idempotency at all**; `DocNumber` is the only
  guard. `realmId` arrives on the CALLBACK, not in the token. Reads are metered,
  so reference sync uses **Change Data Capture** after the first pull.
  `UnitPrice` overrides `Amount`, so only `Amount` is ever sent. `intuit_tid` is
  captured off every response.
- **Sage** — ✅ 7-day idempotency. ⚠ **Start cannot take purchase invoices**, and
  Start is what practices put their smallest clients on: the adapter probes by
  attempting and falls back to `other_payments`. Access tokens last ~5 minutes,
  which is why the store is consulted per item and not per batch.
- **FreeAgent** — ✅ decimal strings, attachment on the same call, a refresh token
  that effectively never expires. ⚠ **5 MB cap**, the tightest, so downscaling
  is mandatory. ⚠ PDFs go up as the non-standard **`application/x-pdf`**.
  The 1 Dec 2026 breaking change is on BANK-TRANSACTION EXPLANATION attachments
  and does not touch bills, which is what we post.

  ⚠ **PER-BUSINESS, not per-practice — owner's decision, 18 Sep 2026.** The app
  was registered for the **Accountancy Practice API** ("accountancy practice
  managers only"), which is one approval covering every client a practice
  manages. A business account then cannot approve it at all: FreeAgent answers
  *"This app is only for accountants"* and the consent stops dead.

  The setting is now **off** — "Who may use this app? all users" — and each
  client connects individually, like Xero and QuickBooks. That also matches
  what `freeagent.ts` already did: `resolveOrgRef` reads `/company` because
  *"FreeAgent's token is already company-specific, so there is nothing to route
  on"*. The adapter was written per-business all along; only the registration
  disagreed.

  ⚠ The cost is real and was accepted: a practice with fifty clients does fifty
  consents. Turning the Practice API back on is a checkbox, but it is not a
  checkbox alone — `resolveOrgRef` would have to list companies and choose one,
  and `integrations.org_ref` would have to hold that choice.

## Tests

```bash
pnpm --filter @neoting/api test -- ledger           # unit, offline
docker compose up -d && pnpm db:migrate
pnpm --filter @neoting/api test -- ledger-lane      # real DB + a real HTTP vendor
```

`ledger-lane.integration.test.ts` stands up a server speaking FreeAgent's shapes
over a real socket and drives connect → sync → publish → attach → rotate →
revoke, plus the four deliberate breakages. Ids are prefixed **`led_`** — a stem
no other suite shares in either direction, because Prisma compiles `startsWith`
to an UNESCAPED `LIKE` and `_` is a wildcard there.

⚠ **It cannot prove a vendor accepts our JSON.** Only the vendor can, through a
consent journey that needs a human with a sandbox password. That half is
recorded as owed rather than implied.

## Current state, honestly

✅ **LIVE on staging since 15 Sep 2026** — `LEDGER_ADAPTER=http`, real
credentials in `/neoting/staging/ledger`, all four offered on the client
Connections tab. The boot gates passed, which is what proves the sealing key and
the applications are genuinely valid rather than merely present.

✅ **All four reach their real consent screen since 17 Sep 2026.** Xero's
`invalid_scope` was OUR scope string: `accounting.transactions` is a BROAD scope,
retired for every app created after 2 March 2026, and this app was created on
13 September. Xero's granular replacement for creating a bill is
**`accounting.invoices`**; `vendors.ts` now asks for that.

⚠ **Two traps left behind by getting that wrong**, both recorded in
`docs/runbooks/ledger-connections.md`:

1. **Never probe Xero scopes one at a time.** `offline_access`, `profile` and
   `email` are OIDC modifiers valid only alongside `openid`, so a solo probe of
   any of them answers `invalid_scope` and means nothing. The 15 Sep probe read
   three false refusals that way and cost a day aimed at a portal setting that
   does not exist.
2. **`app.connections` must stay OUT of the request** even though it is granted
   and `resolveOrgRef` calls that endpoint. It is non-tenanted — client
   credentials only — and adding it re-breaks the consent.

✅ **THREE PLATFORMS ARE PROVEN IN THE VENDOR'S OWN SCREEN** (18–20 Sep 2026).

- **QuickBooks** — Sandbox Company GB. Bill `NT-395QHPCC8AWKR`, Currys Business,
  coded to Furniture and Equipment, **source PDF attached**. D43 satisfied on a
  real platform.
- **FreeAgent** — Neoting Sandbox Ltd. Bill `345756`, London Linen Co, coded to
  a FreeAgent category, **receipt attached** (the paperclip on their Bills
  screen).
- **Xero** — Neoting Sandbox Ltd. Bill `NT-2R1HSW0ES391Z`, Wolseley, Cost of
  Goods Sold, `20% (VAT on Expenses)`, 72.00 + 14.40 VAT = **£86.40**, PDF
  attached (*"Attached the file … through the Xero API using Neo Accounting"*).
  ⚠ The status is what matters: **Awaiting Payment**, with a Make payment
  button — a real payable. `NT-2FH97ZFSZ021D` sits directly below it in the
  same list, still a **Draft**, posted twenty minutes earlier by the same code
  before the fix. That pair is the clearest before/after this lane has.

⚠ **Sage is the one still owed**, parked on the owner's call: its trial wants a
card, and its Start plan cannot take purchase invoices at all.

⚠ **Getting those two bills right took EIGHTEEN fixes**, and not one of them was
visible to the test suite — every single one needed a real document landing in a
real ledger. The recurring shape is *a plausible answer that is wrong and looks
ordinary*: a bill at the wrong total, a domestic purchase coded as an EC
acquisition, a delta overwriting a list, a sandbox host lost after connect.
`docs/runbooks/ledger-connections.md` and the sections above carry them.

✅ Built and proven against a real database and a real HTTP vendor: the shared
layer, all four adapters, the connection surface, the refresh sweep, and the
ledger arm of `publish.batch`.

⚠ **Local runs still need a localhost callback per vendor.** Every application
is registered against `https://api.neoting.neovogent.com/...`, so a laptop needs
`http://localhost:3000/v1/integrations/<vendor>/callback` added at each portal.
**FreeAgent's is added** (15 Sep 2026). ⚠ On STAGING none of that is needed —
the registered URIs are the staging ones, which is why the live test got
further than the local one did.

✅ **Staging RUNS this lane**: `LEDGER_ADAPTER=http`, real credentials in
`/neoting/staging/ledger`, and the four redirect URIs on `local.app_host`.
(This paragraph used to say the opposite.)

## TODO

- [x] **DONE, 17 Sep 2026 — Xero's `invalid_scope`.** It was not a portal
      grant. `accounting.transactions` → `accounting.invoices` in `vendors.ts`;
      both research docs corrected. ⚠ `accounting-platform-api-access-guide.md`
      had the right mapping in a table BEFORE the build and it was not carried
      into the code — the research was read, that line was not applied.
- [ ] The four vendor screenshots — the acceptance evidence the brief asks for.
      **THREE OF FOUR DONE (20 Sep 2026)**, each a full walk: upload → code →
      Read review → Approve → the vendor's own screen showing the right pence,
      the right VAT and the receipt attached.
      - [x] **FreeAgent** — `WOL-1099`, Wolseley, £86.40 inc £14.40.
      - [x] **QuickBooks** — `NT-29SSIAUO2XTGB`, London Linen Co, £130.00 net +
            £26.00 VAT = £156.00, `3.4b-london-linen-2026-08-26.pdf` attached,
            and `reconcile` raised NO warning, which is the first time silence
            from it has been evidence rather than absence of it.
      - [x] **Xero** — `NT-2R1HSW0ES391Z`, Wolseley, £86.40 (72.00 + 14.40
            VAT), PDF attached, and **Awaiting Payment** rather than Draft.
            Found three defects on the way through, all fixed and re-verified on
            the deployed product; see "THREE MORE THINGS A GREEN SUITE CANNOT
            SEE" above. ⚠ Suppliers synced 0 → 2 across the walk, because our
            own bills created the contacts — the earlier `0 suppliers` was an
            empty organisation, not a broken sync.
      - [ ] **Sage** — parked at the owner's instruction: the portal refuses
            `@neovogent.com` addresses, a trial wants a card, and the Start plan
            cannot take purchase invoices at all (which is the fallback path in
            `sage.ts`, itself unexercised).
- [ ] The infra PR: a `ledger` secret group + the four redirect URIs and
      `LEDGER_SANDBOX` on `services.tf`, then drop the twelve allowlist entries.
- [ ] The **QuickBooks App Assessment Questionnaire** (~1 hour). Every answer is
      already in the published privacy notice; discovery and `intuit_tid` are
      implemented because it asks about both by name.
- [ ] Xero's `Url` field — the second half of D43 on that platform (a clickable
      link *and* the file). Needs the capability-link service, which is another
      module's seam.
- [ ] Supplier matching is exact-on-normalised-name; SoT §17.1 wants fuzzy +
      VAT number with confirmation. Creating a contact is currently part of the
      approved publish rather than its own decision.
- [ ] Update this file on exit — it is how the next session picks up.
