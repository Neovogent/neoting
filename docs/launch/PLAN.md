# Neo Accounting — the launch plan

**Target:** a UK accounting practice signs up, pays by card, invites a client, the client
uploads a document, it is read and coded, the accountant approves it, it becomes
Published, and it exports as a VT Transaction+ import file with a working link back to
the source document.

That is SoT §24.7's definition of done, and it is the bar. Everything in these files
exists to reach it.

---

## How to use these files

There are four:

| File | Who |
|---|---|
| `docs/launch/PLAN.md` | this file — the rules, the dependency order, what "done" means |
| `docs/launch/SHAKIB.md` | infra, money, config, deploy |
| `docs/launch/ABDULLAH.md` | the backend spine and the export |
| `docs/launch/MUBASSHIR.md` | the surface — brand, landing, portal, copy |

**The loop.** Attach the codebase and your own file to Claude Code, then say:

> Finish stage **A3**.

The stage carries its own dependencies, its exclusive file paths, its definition of done
and a full prompt. When it is green, open a PR. Shakib reviews, tests, merges, deletes the
branch. Next stage.

**Running several agents at once.** Every stage declares **Needs** (what must be merged
first) and **Owns** (the paths it may touch). Two stages can run simultaneously if their
`Owns` lists do not intersect and their `Needs` are satisfied. Nothing else is required to
parallelise — that is what those two fields are for.

---

## The rules nobody breaks

These are the invariants from `CLAUDE.md`. Speed does not suspend them, because each one
is a thing that fails silently and is expensive to find later.

1. **Money is integer pence.** No floats, anywhere, ever. Format to 2dp only at an output
   boundary.
2. **Every Prisma query goes through `scopedDb(ctx)`.** An unscoped query is a tenancy
   leak, and RLS fails **closed and silent** — a wrong query returns nothing rather than
   erroring, so you will not notice.
3. **No state change outside the ActionProposal / Review → Approve path.** Approve stays
   server-gated on the review having been opened.
4. **Zod at every boundary** — controllers, job payloads, webhooks, portal endpoints,
   model output, adapter responses. Parse, do not trust.
5. **Untrusted content is data, never instructions.** Document text, email bodies,
   filenames and captions are wrapped before any model sees them.
6. **LAW paths change only through a contract-change issue Shakib approves first:**
   `packages/contracts`, `packages/component-grammar`, `packages/tokens`,
   `packages/validators`, `prisma/`. If a stage seems to need one and it is not in **S0**,
   stop and say so — do not edit them.
7. **No secrets in the diff.** Not in `.env`, not in a fixture, not in a comment.
8. **UTC in storage, Europe/London in rendering, UK d/m/y in parsers.** `04/08/2026` is
   4 August.
9. **Never say a ledger was written to.** D42: *Published* means approved and released for
   export. Not "posted", not "synced", not "sent to VT" — **"Export for VT"**.
10. **`pnpm` only.** Never npm, never yarn.

**Definition of done for every stage:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
all green, then a PR. A stage that cannot go green is a stage that is not finished — say so
rather than merging around it.

---

## What we found before starting

Three independent audits read the code. The plan below includes their findings, which is
why it is larger than "build the missing features". The five that reshaped it:

- **No accountant could create an account.** `auth-tenancy/demo-credentials.ts` *is* the
  credential store — two frozen entries. Only `prisma/seed.ts` could mint a practice.
- **Nothing could ever reach Published.** `publish-batch.ts` refuses without an active
  ledger integration, and `IntegrationKind` had no VT. Documents stopped at READY forever,
  so the export had nothing to export.
- **Nothing in the repo sent an email.** With SMS cut, the client had no delivery channel
  at all.
- **Real extraction could not safely be switched on.** `BedrockExtractor` accepts only
  png/jpeg/webp/gif while ingestion accepts PDF and HEIC, so real documents landed in
  FAILED — and with it off, `DemoExtractor` fabricates supplier, date and total from a
  filename hash and marks them Ready.
- **The web app silently substitutes seeded demo data when the API fails.** A paying
  accountant would see "American Burger Ltd" and believe it.

---

## Dependency order

Not a schedule — a partial order. Anything with satisfied `Needs` can start.

```
S0  contracts + prisma (LAW)   ← DONE, #164 / PR #165
 │
 ├─ S1 secrets & boot gates
 ├─ S2 email transport ──┬── A13 chase by email
 │                       └── M6 sign in by email
 ├─ S3 frontend to AWS ───── S4 Stripe
 ├─ A1 signup ──────────── A2 TOTP + lockout   (+S1)
 ├─ A3 upload sanitisation ─┐
 ├─ A4 extractor formats ───┴── S5 real extraction ON   (+S1)
 ├─ A5 publish w/o ledger ──┬── A6 chart of accounts
 │                          └── A12 release gate   (+A11)
 ├─ A7 VT emitter ── A8 source link ── A9 export ── A10 round trip
 └─ A11 client intake ───── M7 intake screen

NEVER NEEDED S0 — these could have started on day one, and still can:

  S6 legal pack (Shakib)  ·  M2 kill demo data (Mubasshir)  ·  M5 Xero purge (Mubasshir)
                                                                     │
                                                     M1 rename  ←────┘
                                                      └── M3 landing ── M4 legal pages  (+S6)

  M8 honest-copy pass      ← M1, M3, M4, M5 — genuinely last
  S7 deploy + walkthrough  ← everything
```

**S0 landed on 26 Aug 2026** — contract-change issue #164, PR #165. Three notes for
everyone downstream, because each would otherwise be discovered the hard way:

- **The client resource is `businesses`, not `clients`.** `POST /v1/businesses`,
  `POST /v1/businesses/{businessId}/members`. "Client" stays the word on screen.
- **`GET /d/{code}` is served at the origin root, not under `/v1`**, and is
  deliberately excluded from codegen — there is no generated client for it, on
  purpose. `apps/api/src/config/routing.ts` already carries its exclusion.
- **A9's export surface, A8's `document_links` table and a `document.revoke-link`
  proposal kind all exist in the contract already.** Build against them; if you find
  a field they do not cover, stop and say so rather than editing a LAW path.

### How many stages can run at once

Computed from every `Needs:` line, not estimated. S0 was the only true global blocker and
it is now done, so this is the live picture rather than a forecast:

| When | Runnable in parallel | What they are |
|---|---|---|
| Before S0 — *history* | 3 | S6 · M2 · M5 |
| **Now, S0 has landed** | **12** | S1 S2 S3 S6 · A1 A3 A4 A5 A7 A11 · M2 M5 |
| Those land | **10** | S4 S5 · A2 A6 A8 A12 A13 · M1 M6 M7 |
| Then | 2 | A9 · M3 |
| Then | 2 | A10 · M4 |
| Then | 1 | M8 |
| Last | 1 | S7 |

**Twelve stages are runnable right now**, split 4 / 6 / 2 across Shakib, Abdullah and
Mubasshir. Nobody is waiting on anybody. If you are idle, you are idle by choice — open
`Needs: S0` in your own file and start.

The tail is narrow and that is fine: A9→A10 and M3→M4→M8→S7 are verification and sweep,
not build. They are fast because the work is already done.

---

## Cut list, agreed in advance

If a stage is not started by its trigger, cut it. Decided now so nobody has to decide it
at hour 30.

1. **Bank statement extraction** — trigger hour 16. Clients send CSV; you import by hand
   for the first month.
2. **Chase by email (A14)** — trigger hour 22. Without statements there is little to chase.
3. **The demo tour** — any bug at all. It is already gated to synthetic; turning the button
   off is one line.
4. **Coding suggestions (A6 beyond a seeded chart of accounts)** — trigger hour 26. The
   accountant codes it by hand; the product still works.

**Never cut:** the VT export with a working source link, Stripe taking money, the legal
pack, and real extraction. Those four are the product, the revenue, the licence to
operate, and the thing that stops us lying to a customer.

---

## What "done" means, precisely

Run this yourself, as a real user, before you call it finished. If any step needs you to
open a database or a terminal, it is not done.

1. Sign up as a new practice at `neoacc.neovogent.com`. Set up MFA.
2. Add a client — a cleaning agency. No bank connection is offered; no accounting-software
   connection is offered.
3. The client receives an email and signs in with a code.
4. The client subscribes and pays **£8.50 + VAT** with a real card. A VAT invoice arrives.
5. The client uploads a supplier invoice **as a PDF** and a receipt **photographed on a
   phone**. Both are read.
6. The accountant sees the extracted fields, corrects one, and approves.
7. The super admin releases it. It becomes **Published**.
8. Export for VT. Import the file into VT Transaction+ with no mapping errors.
9. **From a line in VT, reach the source document.**
10. Cancel the subscription from the customer portal, and confirm what the policy says
    happens to the data.

Step 9 is the acceptance test. Steps 1, 4 and 10 are what make it a business.

---

## Standing risks

- **The click-through is unproven.** Whether VT renders a URL as clickable is unconfirmed
  (§22 open decision 11b). **A10** settles it early on purpose — do not let it slip to the
  end, it can invalidate the export design.
- **CI has no e2e and no eval suite.** Stages 6 and 7 are empty, so nothing mechanically
  catches a regression in a screen or a prompt. The walkthrough above is the only real
  integration test.
- **Stripe live activation and ICO registration are external clocks.** No amount of
  engineering shortens either. Start both at hour 0.
- **The staging environment is the launch target.** It was built to be disposable. Confirm
  what its deletion protection and backup posture actually are before a customer's records
  live in it.
- **`GET /d/{token}` is an unauthenticated URL to a client's financial document.** The
  token is the whole authorisation. Expiry, rate limiting and revocation are not optional
  extras on that route.

---

## Legal pack

Drafted and living in `docs/legal/`: terms of service, privacy notice, data processing
terms, refund and cancellation policy.

**They are a drafting aid, not legal advice.** They were written from the product's own
documented behaviour and the SoT's own commitments. A qualified UK solicitor should read
them before they go live. Two things in them need Shakib specifically: the company number,
and a decision about the Gmail forwarding — a free consumer Google account is not an
appropriate sub-processor for other people's financial records.

---

*Built against `main`. SoT v1.6, Governance v1.6. VT format from the research digest at
`Desktop/VT-Software-Research`.*
