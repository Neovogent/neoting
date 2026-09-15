# Ledger input APIs — the full list, and the request tracker

**Prepared:** 12 September 2026
**For:** Shakib (owner), in answer to the PM's ask — *"list of all accounting software, start requesting the input API (same as VT but with an API), tell me which ones you're starting on"*
**Companion to:** `docs/research/accounting-platform-api-access-guide.md` (3 Sep 2026) — that document is the *how*, this one is the *who, and where we are with them*.

---

## 0. What "input API" means here, stated once

Today Neoting's only egress is a **VT Transaction+ import file** (D42). The accountant downloads it and imports it into VT by hand. An *input API* is the same job done over the wire: Neoting calls the ledger and the approved transaction lands in the client's books, with the source document attached (D43).

⚠ **Nothing in this document ships in Initial Delivery.** D42 stands: export is the sole egress for ID, and *Published* means "approved and released for export". These requests are being sent now **because several of them take 3–9 months to come back**, not because an adapter is being built. Sending a request costs an email and commits us to nothing.

---

## 1. "All accounting software" — the honest size of the list

**HMRC's recognised-software finder returns 466 products** ([finder](https://www.tax.service.gov.uk/making-tax-digital-software), checked 12 Sep 2026). That is the literal answer to "all", and it is a useless answer: most of those 466 are **bridging tools** — spreadsheet add-ins that file a VAT return and keep no books at all. You cannot post a purchase invoice into a bridging tool because there is nothing to post it into.

The list that matters is **the ledgers a UK practice actually puts a client business on**. That is about **30 products**, of which **17 have some kind of input path** and **5 are worth our time first**.

A useful cross-check: **Dext publishes to 17 destinations** and **AutoEntry to a similar set**. Two competitors with a decade of head start have already priced this market's edges for us — anything neither of them bothered to build is very unlikely to be worth our building it.

> **Dext's destination list** ([Connect & Export](https://help.dext.com/en/collections/878041-connect-export), checked 12 Sep 2026): Xero · QuickBooks Online · QuickBooks Desktop · Sage 50 UK · Sage 50 Canada · Sage Accounting · Sage Accounting South Africa · MYOB AccountRight Live · MYOB Essentials · KashFlow · ApprovalMax · FreeAgent · Twinfield · Zoho Books · Nomi · BrightBooks · Bill.com
>
> **AutoEntry adds:** SortMyBooks · AccountsIQ · Clear Books · Reckon One · Exact
>
> ⚠ **Neither publishes to Sage 200.** That is a market judgement, not an oversight.

---

## 2. Tier A — real ledgers with an input path. These are the candidates.

Ordered by *how much UK small-practice work they represent*, not by how easy they are.

| # | Platform | Input API? | How you get in | Cost to ask | Gate | **Status** |
|---|---|---|---|---|---|---|
| **1** | **Xero** | ✅ REST, OAuth2 | Self-serve: [xero.com/signup/developers](https://www.xero.com/signup/developers/) | **£0** | 5 connections free, 50 with a card. Certification for 1,000 | ⬜ **Not started** |
| **2** | **QuickBooks Online** | ✅ REST, OAuth2 | Self-serve: [developer.intuit.com](https://developer.intuit.com/app/developer/myapps) | **£0** | App Assessment Questionnaire before production | ⬜ **Not started** |
| **3** | **Sage Business Cloud Accounting** | ✅ REST, OAuth2 | Self-serve + upgrade form: [developer.sage.com/accounting](https://developer.sage.com/accounting/guides/getting-started/developer_signup/) | **£0** | None for production. 3–5 working days for the dev account | ⬜ **Not started** |
| **4** | **FreeAgent** | ✅ REST, OAuth2 | Self-serve + email `integrationsrequests@freeagent.com` for the Practice sandbox | **£0** | None — a hostname swap | ⬜ **Not started** |
| **5** | **Clear Books** | ✅ REST, OAuth2 | ⚠ **On request only** — `api@clearbooks.co.uk` / [support/api](https://www.clearbooks.co.uk/support/api/) | **£0** | A human says yes. No self-serve credentials | ⬜ **Not started** |
| 6 | **KashFlow (IRIS)** | ⚠ SOAP only | Contact form on [kashflow.com/developers](https://www.kashflow.com/developers/integrate-your-app/) | £0 | Partnership conversation | ⬜ Not started |
| 7 | **Nomi (Nomisma)** | ⚠ Undocumented, but real | BD email — no public portal | £0 | ⚠ **Also a competitor** (WhatsApp receipt capture) | ⬜ Not started |
| 8 | **BrightBooks** (ex-Surf Accounts, Bright Software Group) | ✅ Real API — BrightPay posts to it | BD email to Bright | £0 | IE-first, growing UK | ⬜ Not started |
| 9 | **QuickFile** | ⚠ Public API, **but MD5-hash auth, not OAuth** | Self-serve: [api.quickfile.co.uk](https://api.quickfile.co.uk/) | £0 | 1,000 calls/day | ⬜ Not started |
| 10 | **Zoho Books** | ✅ REST, OAuth2 | Self-serve | £0 | ⚠ 20 refresh tokens per user | ⬜ Not started |
| 11 | **Twinfield (Wolters Kluwer)** | ⚠ SOAP + OIDC | Partner programme | ⚠ **~€53/month per API link** | 5% rate limit until certified; no marketplace listing before that | ⬜ Not started |
| 12 | **Exact Online** | ✅ REST | Self-serve dev portal | £0 (not verified) | NL-first; thin UK practice share | ⬜ Not started |
| 13 | **AccountsIQ** | ⚠ SOAP 1.1 + newer REST endpoint | Invite-only Developer Portal — `integration@accountsiq.com` | £0 (not verified) | Client's Integration Admin must invite us **per client** | ⬜ Not started |
| 14 | **SortMyBooks** | Not verified — AutoEntry posts to it | Unknown | ? | IE, small | ⬜ Not started |
| 15 | **Reckon One** | ✅ REST, OpenAPI | Self-serve | £0 | AU market | ⬜ Not started |
| 16 | **MYOB** (Business + AccountRight) | ✅ REST | Application form | ⚠ **A$110–630/month** | AU launch only; ⚠ UK-domiciled applicant unconfirmed | ⬜ Not started |
| 17 | **FreshBooks** | ✅ REST, OAuth2 | Self-serve dev page | £0 | Negligible UK practice share | ⬜ Not started |

---

## 3. Tier B — has an API, wrong customer

These serve **one mid-market finance team**, not **a practice with two hundred small clients**. The API is not the obstacle; the shape of the customer is. Revisit only if a practice asks for one by name.

| Platform | Note |
|---|---|
| **Sage 200 (UKI)** | ⚠ **Correction to the 3 Sep guide**, which called this "partner-gated with no public reference". There *is* a portal — [developer.sage.com/200-uk](https://developer.sage.com/200-uk) — with a REST API for Sage 200 Standard Online and Professional. The **SDK.net** route still needs a paid ISV subscription. Still excluded, but for the customer-shape reason, not the access reason |
| **Sage Intacct** | [developer.intacct.com](https://developer.intacct.com/), XML API, Partner Network |
| **Microsoft Dynamics 365 Business Central** | Full API. ERP customer |
| **NetSuite** | Full API. ERP customer |
| **iplicit · Xledger · Aqilla** | UK/IE mid-market cloud finance. APIs exist to varying degrees; **not verified** |
| **Access Financials** | Mid-market |
| **Odoo** | ⚠ External API is **Custom-plan only**; XML-RPC removal scheduled 2028 |

---

## 4. Tier C — no input API. The file lane, permanently.

This is the lane VT is in, and the reason the export emitter is not a stopgap.

| Platform | Why |
|---|---|
| **VT Transaction+ / VT Cashbook** | ❌ **No API exists and none is planned.** VT's published roadmap mentions MTD and Companies House filing, and nothing about an API, cloud or partners. **Do not spend time lobbying VT.** The file is the permanent answer |
| **Sage 50 UK** | Technically reachable via a Windows COM agent at ~£2,500+VAT/year and 5–9 months — and ⚠ **D43 is unachievable**: Sage's own AutoEntry posts a link, not the file. See guide §2.4. **Declined** |
| **QuickBooks Desktop** | Windows bridge only. Dext supports it; we will not |
| **Pandle** | No public API, despite good in-product receipt attachment |
| **Capium** | No published API (`api.capium.com` 404) |
| **Liberty Accounts** | No public API found. Small; charity/not-for-profit niche |
| **Solar Accounts · Adminsoft · Andica · MoneySoft · Instant Accounts** | Desktop, no API |
| **Bokio** | ⚠ **Leaving the UK market on 30 June 2026.** Dead end — but note its users are actively migrating and need somewhere to land |

---

## 5. Tier D — wrong layer, and Tier E — competitors

**Wrong layer** — these are accounts-production, tax and practice-management tools. They *consume* bookkeeping data; they are not the books we post into. Integrating means feeding a tool that sits *after* us, not landing a transaction.

IRIS Accountancy Suite / IRIS Elements · CCH (Wolters Kluwer) · TaxCalc · BTCSoftware / Bright · Absolute · Capium's practice side

> ⚠ **IRIS is the exception worth a conversation.** No public API surface at all (`developer.iris.co.uk` does not resolve), but IRIS is genuinely large in UK practices and owns KashFlow, which *does* have one. **That makes IRIS one BD conversation covering two products.**

**Competitors, not targets** — Dext · AutoEntry · Hubdoc · Nomi (partly) · Pandle's capture feature.

**Bank-bundled books** — Coconut · Countingup · ANNA · Tide Accounting · Starling Business Toolkit · Mettle · Crunch. Each is a closed book inside a bank account, sold direct to the business, not through a practice. **Crunch is itself an accountancy practice** — integrating means integrating with a competitor's client base.

---

## 6. What we are starting on, and why these five

> **Xero · QuickBooks Online · Sage Business Cloud Accounting · FreeAgent · Clear Books**

| | Why it is in the first five |
|---|---|
| **Xero** | Where the customers are. Free to register, five connections immediately, fifty with a card on file — enough for a whole pilot with **no review, no questionnaire, no certification**. The only platform offering **both** a real file attachment **and** a clickable link back to the source, which is D43 satisfied twice over. And the repo has already committed to it: `IntegrationKind` holds `XERO` and a `DemoXeroAdapter` exists |
| **QuickBooks Online** | The clear number two in UK practices. ✅ **No connection cap at all** once the questionnaire clears — it scales *further* than Xero without certification. ⚠ Its questionnaire is the first real gatekeeper we meet, which is exactly why it should be started early rather than when we need it |
| **Sage Business Cloud Accounting** | Arguably the **best mechanics of any platform on this list**: no connection cap, 7-day idempotency, free — and **Partner Edition gives one consent covering every client a practice manages**, instead of one consent per client. Also a documented competitor gap: **Dext falls back to a link on Sage Accounting while the API supports a real attachment.** We can beat them on their own integration |
| **FreeAgent** | Cheapest win on the board: free, real sandbox, ~4–7 weeks, a Practice API with one grant for all clients — and **the only platform in this entire market that sends money as a decimal string rather than a float**, which matters a great deal to a codebase whose central rule is integer pence. Its reach is also understated: **NatWest, RBS, Ulster Bank and Mettle customers get FreeAgent free** |
| **Clear Books** | The odd one out, and deliberately. It is smaller than the other four — but it has **no self-serve credentials at all**, so a human at Clear Books has to say yes. **That clock only starts when we send the email.** It costs one message today and removes a months-long delay later |

**Three more letters going out at the same time, because they cost nothing and their clocks are the longest:** **IRIS/KashFlow**, **Nomi** and **Bright (BrightBooks)**. None of these have a developer portal to sign up to; all three need a person to reply. Asking now and hearing back in three months is strictly better than asking in three months.

**Deliberately not asking yet:** MYOB (Australia, and it costs money), Twinfield (€53/month per link buys nothing until we have a customer asking for it), everything in Tier B, and everything in Tier C.

---

## 7. The requests themselves

**Four of the five are self-serve** — Xero, QBO, Sage and FreeAgent need an account created and a form filled, not an email answered. **Two things block that today, and they are the same two things that block Stripe live mode:**

- ⚠ **The company number is blank.** `docs/legal/terms-of-service.md` says *"registered in England and Wales, company number ___"*. Every application form on this list asks for it.
- ⚠ **No VAT registration number.** The legal pack states *"not currently registered for UK VAT"*. Several programmes ask; some require it.

**One of the five and all three letters need a written request.** Draft below — one template, five recipients.

> **Subject:** API access request — Neovogent AI Solutions UK Ltd (bookkeeping automation for UK practices)
>
> Hello,
>
> We are Neovogent AI Solutions UK Ltd, a UK software company building a document-to-bookkeeping tool for accounting practices. Receipts and invoices arrive from a client by photo, email or WhatsApp; we read and code them; **an accountant reviews and approves every single one**; and the approved transaction is then released into the client's ledger with the original document attached to it.
>
> We would like to request access to your API so that our customers — UK practices who keep their clients' books in your software — can have those approved transactions land directly rather than being exported and re-imported by hand.
>
> A few things you will want to know up front:
>
> - **Nothing is ever written without a human approving it.** There is no automatic-posting path in our product, and that is enforced on our server, not in the interface.
> - **We are multi-tenant by nature.** Our customers are practices acting for many client businesses, so one practice may connect a large number of separate organisations. If that needs a different programme or tier than a single-business integration, please point us at it.
> - **We need to attach the source document to the transaction**, so that anyone opening the entry can see the receipt it came from. If your API supports file attachments on purchase invoices or expenses, that is the endpoint we most want to understand.
> - **We are not asking to go live today.** We are at the stage of understanding what is possible and what the process is, and we would rather start that conversation early than late.
>
> Could you tell us what the route to production API access looks like — whether there is a developer programme to join, an application to complete, a fee, and a rough timescale?
>
> Happy to get on a call.
>
> Many thanks,
> [name]
> Neovogent AI Solutions UK Ltd — Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham B15 1NP
> hello@neovogent.com

**Recipients:**

| To | Address | Note |
|---|---|---|
| **Clear Books** | `api@clearbooks.co.uk` — or the [support/api](https://www.clearbooks.co.uk/support/api/) contact form | The only one of the first five that needs this |
| **IRIS / KashFlow** | [kashflow.com/developers](https://www.kashflow.com/developers/integrate-your-app/) contact form | ⚠ Ask about **IRIS Elements** in the same message — one conversation, two products |
| **Nomi** | Via their website contact | ⚠ They are partly a competitor. Say what we do plainly; do not oversell |
| **Bright (BrightBooks)** | Via Bright Software Group | They already run an API for BrightPay, so one exists |
| **AccountsIQ** *(optional)* | `integration@accountsiq.com` | Only if a practice asks. Access is per-client-invite, which is awkward at scale |

---

## 8. What is not known, and would change something

| Unknown | Why it matters | How to close it |
|---|---|---|
| **Company number and VAT number** | Blocks every application form, and Stripe live mode | Owner. One errand |
| **Whether pilot practices' clients already run two uncertified Xero apps** | ⚠ Xero caps an organisation at **two** uncertified apps. A client already on Dext plus one other tool **cannot connect us**, and this is invisible until it blocks | Ask two pilot practices to check |
| **Nomi, BrightBooks, SortMyBooks API terms** | All three are reached only by asking | The letters above |
| **iplicit / Xledger / Aqilla API surfaces** | Tier B, low priority | Defer until asked for |
| **Sage 200 REST API write + attachment support** | Would move it out of Tier B if a practice asks | [developer.sage.com/200-uk](https://developer.sage.com/200-uk) returned 403 to automated fetch; needs a browser |

---
---

## 9. "Does it follow the same process Dext does?" — asked by the PM, 12 Sep 2026

**Short answer: yes, the same three steps — and our code is already shaped for them.**

**What Dext actually does** (verified against Dext's own help centre, 12 Sep 2026):

| Step | Dext | Us |
|---|---|---|
| **1. Connect** | The practice is redirected to Xero/Sage, signs in, picks the organisation, consents. **One connection per client business**, and ⚠ only one primary ledger per Dext account ([how to connect](https://help.dext.com/en/articles/339551-how-to-connect-dext-to-your-accounting-software)) | Identical. This is the OAuth layer that does not exist yet — guide §4.2, step 0 |
| **2. Pull the lists down** | On connect, Dext imports categories, suppliers, customers, tax rates, products, projects and bank accounts | We already have `ReferenceSync` for exactly this |
| **3. Push each item** | Creates a **record through the vendor's API**: in Xero a **supplier invoice** under *Purchases → Bills to pay*, or a **Spend Money** on a bank account; in Sage Accounting a **Purchase Invoice** or **Other Expense** ([Xero](https://help.dext.com/en/articles/377055-how-to-publish-documents-to-xero), [Sage](https://help.dext.com/en/articles/603424-how-to-publish-items-to-sage-accounting-from-dext)) | `LedgerAdapter.publishBill()` — `publishing/ledger-adapter.ts`. Same payload: supplier, category, currency, total, tax, date, reference, attachment, and back comes the vendor's own reference |
| **4. Attach the source document** | Where the platform allows it | `PublishBillRequest.attachment` + `LedgerPublishSuccess.attachmentSent`, which "reports what actually travelled, never a claim" |

**Where we differ — and two of the three are in our favour.**

1. ⚠ **The receipt on Sage is the opening.** Dext's own page: *"Because Quick Entries don't support file attachments in Sage Accounting, Dext adds a link to the item's image in the Details field instead."* But **Sage Accounting itself takes up to 10 attachments per purchase invoice** (PDF/GIF/JPG/JPEG/PNG, 2.5 MB each — [Sage help](https://help.accounting.sage.com/en-gb/accounting/invoicing/attachments-accounting.html)). **If we publish as a Purchase Invoice and attach the file, we do something Dext does not.** On Sage 50 Dext cannot send the file at all. On Xero, Dext does attach, and we would match them.

2. **Approval happens on opposite sides of the wire.** Dext lets you choose the state an item lands in — Draft, Awaiting Approval, Awaiting Payment, or Paid where possible — so the approving can happen *in the ledger, after the push*. Ours is approved **before** anything leaves, server-enforced, with no path around it. Landing status then becomes a setting we choose rather than a workflow we depend on. ⚠ **We should still default to Draft or Awaiting Approval**, because it is the practice's own Xero workflow and not ours to skip.

3. **None of it is switched on.** D42 stands: we export a file, and the adapter is a working seam with a demo implementation behind it, not a live connection. `DemoXeroAdapter` proves the full path end to end; the real Xero client drops in behind the same interface with no call-site change.

---

## 10. Decisions taken — PM, 12 September 2026

| # | Asked | Answer | Consequence |
|---|---|---|---|
| 1 | ICO registration number | **Still pending** | Forms answered "ICO registration in progress". True, and acceptable |
| 2 | Mobile number for sign-up | **Try a Bangladesh number first; only escalate if a UK one is required** | ✅ Mostly moot — see below |
| 3 | Which email | **`developers@neovogent.com`, routed to `neovogentukltd@gmail.com`** | Needs a Cloudflare Email Routing rule before any sign-up |
| 4 | Logo | **Ask Samim** | ⬜ Outstanding. Not blocking — every platform accepts one later |
| 5 | Company website | **Build a one-page company site** | Written: `site/index.html`. Needs deploying to `neovogent.com` |
| 6 | Xero connection tier | **Free tier for now** | 5 client businesses, no card. Upgrade to 50 is one click, later |
| 7 | Sage 50 | **Skip** | ⚠ Read as *Sage 50 only*. **Sage Accounting (cloud) stays in Wave 1** — different product, free, and one of the best on the list |
| 8 | The five emails | **Confirm wording first** | Drafts below, awaiting sign-off |
| 9 | Browser session | **He will be at the keyboard** | Sign-in, terms and any card entry are his; everything after the login wall is mine |

### 10.1 ⚠ The phone-number question is smaller than it looked

**Four of the five portals do not need a phone number at all.** They use an authenticator app (time-based codes), which is country-agnostic — no SIM, no SMS, no UK number:

| Platform | What sign-in needs |
|---|---|
| **Xero** | Authenticator app (Xero Verify, Google Authenticator, any TOTP app). **No phone number.** Backup is a second email address or security questions — [Xero MFA FAQs](https://www.xero.com/us/security/multi-factor-authentication/faq/) |
| **FreeAgent** | 2FA optional; when on, an authenticator app — [FreeAgent 2FA](https://support.freeagent.com/hc/en-gb/articles/360001536700) |
| **Sage** | Sign up with GitHub or an email address — [signup](https://developer.sage.com/accounting/guides/getting-started/developer_signup) |
| **Zoho** | TOTP supported |
| ⚠ **Intuit / QuickBooks** | **Wants a phone number on file** as a fallback before an authenticator app can be added — [Intuit 2FA](https://accounts-help.intuit.com/app/intuit/1995121) |

**So there is exactly one number needed, for Intuit.** Whether Intuit accepts **+880** is **not documented anywhere public** — their help pages on this are login-gated. The plan is therefore: **try the Bangladesh number live during the session; if Intuit refuses it, stop and ask for a UK one.** That is a 30-second test, not a research project, and it is exactly the order the PM asked for.

### 10.2 ⚠ Correction — the company website exists

**I was wrong.** I tested `https://neovogent.com` and it did not resolve, and I concluded there was no company site. **There is one, at `https://www.neovogent.com`** — a full marketing site for Neovogent AI Solutions UK Ltd, with the registered office, a contact number and a client list. The `site/index.html` page I wrote has been deleted; it was not needed.

**Use `https://www.neovogent.com` on every form** — with the `www`, which is the part that matters.

Three things found on it that do affect these applications:

1. ⚠ **The bare domain still goes nowhere.** `neovogent.com` without `www` does not resolve at all. Every form will accept the `www` version, so this does not block anything — but anyone typing the short version finds nothing, and it is one DNS record to fix.

2. ⚠ **The site and our privacy notice describe different architectures, and a reviewer reads both.** The website says data *"never leaves"*, that assistants *"live directly in your private environment"*, model location *"On-Device Resident"*, leakage probability *"0.00% Absolute"*. Neo Accounting's privacy notice says documents are read by **Amazon Bedrock in AWS London** — a cloud service. Both may be true of *different products*; the website is plainly describing the AI-assistant line, not Neo Accounting. **But the security questionnaire asks exactly this question**, an assessor will click from the application to the website, and an inconsistency between the two is the kind of thing that stalls a review. Worth reconciling before we submit, not after.

3. ⚠ **Neo Accounting is not mentioned on the site.** A reviewer arriving from an application for an app called "Neo Accounting" lands on a page that never names it. **One line and a link would close that gap** and is probably the single cheapest improvement available to these applications.

**Possible answer to the phone question:** the site's footer carries **+44 7713 623778**. If that number can receive text messages, it may be all Intuit needs — see §10.1.

### 10.3 The email address, in plain words

`developers@neovogent.com` will not be a new mailbox anyone has to check. It is a **forwarding address**: anything sent to it lands in `neovogentukltd@gmail.com`. Cloudflare does this for free, and it takes three steps in their dashboard — turn Email Routing on, confirm the Gmail address by clicking a link sent to it, then add the rule. ⚠ **It must be working before the first sign-up**, because every portal sends a verification link to it.

---

## 11. Portal recon — walked in the browser, 12 September 2026

No accounts created, nothing submitted. The point was to know every field before the live session.

| Portal | Real entry point | What it actually is | ⚠ Correction |
|---|---|---|---|
| **FreeAgent** | [dev.freeagent.com/signup](https://dev.freeagent.com/signup) | ✅ **Fully mapped.** Five fields and nothing else: Email · Name · Password · Password confirmation · Url. **No phone, no company details, no terms checkbox on the form.** API terms are a link, not a tick | — |
| **Xero** | `developer.xero.com/app/manage` → redirects to `login.xero.com` | A standard Xero account login. **The developer portal is not a separate sign-up** — it sits behind an ordinary Xero account | Sign-up is via [xero.com/pricing-plans](https://www.xero.com/pricing-plans/), not a developer-specific form |
| **Sage** | [developer.sage.com/signup](https://developer.sage.com/signup) → redirects to `id.sage.com` | One Sage ID across all Sage products. **Email-first**: enter the address, then it decides whether to log you in or create the account | ⚠ **The URL in the 3 Sep guide is dead.** `developer.sage.com/accounting/guides/getting-started/developer_signup/` returns **404**. Live paths: `/signup`, `/auth/login`, and a new **Console at `/console/organisations`** — which also supersedes the `developerselfservice.sageone.com` route the guide cites |
| **Intuit** | `developer.intuit.com/app/developer/myapps` | Hangs on a loading spinner when signed out — it is an app that assumes a session. Nothing to read until the account exists | — |

**The pattern, and it is the same everywhere:** ⚠ **all four portals are behind a login, and the login is an ordinary product account, not a developer one.** There is no further preparation possible without the account existing. The `developers@neovogent.com` address is therefore the true first domino — not a nicety.

**Browser permissions.** Claude in Chrome grants access per domain. Already open: `developer.xero.com`, `login.xero.com`, `developer.sage.com`, `dev.freeagent.com`, `developer.intuit.com`. ⚠ **Still needed: `id.sage.com`** (Sage's login redirect), plus `api-console.zoho.com`, `accounts.zoho.com`, `www.clearbooks.co.uk`, `www.kashflow.com`, `www.nomi.co.uk`, `brightsg.com`.

**Logo.** Received as an image — dark teal rounded square, white N monogram. ⚠ An **SVG** is coming, and **no portal on this list accepts SVG**; they want PNG at fixed pixel sizes. ImageMagick (`convert`) is available locally to rasterise it. The supplied artwork also carries its own rounded-square background, and some portals apply their own rounding on top — a flat square on transparent is the safer master if one exists.

---

## 12. Live status — 13 September 2026

⚠ **No credentials are recorded in this file, deliberately.** Client IDs and secrets live in the portals and in the owner's password manager, never in the repo.

| Platform | Account | App | Notes |
|---|---|---|---|
| **FreeAgent** | ✅ | ✅ **Done** (app 12548) | **"accountancy practice managers only"** — Accountancy Practice API enabled, the one-approval-covers-all-clients route. Our redirect is first, so it is the default. ⚠ Secret shown once only, and was exposed in chat — regenerate |
| **Xero** | ✅ | ✅ **Done** | Web app, standard auth code. **AI training: No.** Company URL, redirect URI, privacy-notice and terms URLs saved. **0 of 5 connections**, free tier. ⚠ Never start a Xero trial or buy a subscription — the developer portal needs only the login |
| **Intuit** | ✅ | ✅ **Created** — *in development* | Workspace *Neovogent AI Solutions* (id 9341457906047710), app *Neo Accounting*, QuickBooks. Company name, country and full address saved. ⚠ **Redirect URIs not yet set.** ⚠ **Sandbox company not yet created — its region is permanent and must be UK.** ⚠ Intuit warns Platform Fees are charged on the address entered |
| **Sage Accounting** | ✅ | ✅ **Done** | Created in the **self-service portal**, not the Sage ID console (§13). Name, support email, homepage and callback all set. ✅ **Client ID and secret stay retrievable behind *Show*** — unlike FreeAgent, they are not one-time |
| **Zoho** | ⬜ | ⬜ | Lowest priority; not started |

**Values used on every form** — email `shakib@neovogent.com` · name Shakib Bin Kabir · company URL `https://www.neovogent.com` · redirect `https://api.neoting.neovogent.com/v1/integrations/{vendor}/callback` · app name **Neo Accounting**.

⚠ **Xero's sign-up asks for a phone number** (with a country selector) — a correction to §10.1, which said Xero needed none. That was true of its two-factor sign-in, not of account creation. Still outstanding: whether a Bangladesh number is accepted.

---

## 13. ⚠ Sage has TWO developer systems, and the new one is not ours

**Found by walking it, 13 September 2026.** This corrects §11 and the 3 Sep guide.

| | **Sage ID Console** — `developer.sage.com/console` | **Accounting Self Service** — `developerselfservice.sageone.com` |
|---|---|---|
| Login | Sage ID (`id.sage.com`) | ⚠ **Separate account**, via AWS Cognito (`developer-selfservice.auth.eu-west-1.amazoncognito.com`) |
| APIs offered | Sage Operations / X3 SaaS · Sage 200 Spain Essential · Sage 200 Spain Professional · Sage Intacct *(locked, "Enrol to Unlock")* | **Sage Business Cloud Accounting** |
| Use to us | ❌ **None of these is the UK product we want** | ✅ **This is the one** |

**So the Sage ID account and Console organisation set up today do not lead to Sage Accounting.** They are not wasted — the org record (address, country, contact) is filled and saved, and that is the right home if Sage 200 or Intacct ever matter — but **a second, separate sign-up is required at `developerselfservice.sageone.com`**, and it needs a password, so it is owner-side.

⚠ **Two documentation URLs in the 3 Sep guide are dead**, both returning 404: `/accounting/guides/getting-started/developer_signup/` and `/accounting/guides/getting-started/client_app_registration/`. The Sage Accounting docs themselves are alive at `developer.sage.com/accounting` (v3.1 API reference, migration guide, and an "ISV partner journey" page).

⚠ **The Cognito login domain must be allowed in the browser extension** before any of this can be driven from here.

---

## 14. Wave 1 complete — 13 September 2026

All four platforms registered, configured and branded. **Credentials live in `.env.integrations` (gitignored); the API details live in `ledger-api-build-reference.md`. Neither requires going back to the vendors' sites.**

| | Account | App | Redirect | Logo | Credentials captured |
|---|---|---|---|---|---|
| **Xero** | ✅ | ✅ | ✅ | ⚠ n/a | ✅ id + secret |
| **QuickBooks Online** | ✅ | ✅ | ✅ | ✅ | ✅ dev id + secret |
| **Sage Accounting** | ✅ | ✅ | ✅ | ✅ | ✅ id + secret |
| **FreeAgent** | ✅ | ✅ | ✅ | ✅ | ✅ id + secret |

⚠ **Xero has no logo field on the app configuration.** Its icon is part of an App Store listing, which we are not doing — the app is private on the free tier. Nothing was missed; there is nowhere to put one.

✅ **Intuit accepted the 624×607 logo and scaled it itself**, despite asking for 100×100. A true square export from Samim would still be better for the platforms that do not rescale.

**Two corrections to earlier entries in this file:**

- ⚠ **§12 warned the Intuit sandbox region was permanent and account-wide.** It is **per sandbox company**, and ten are allowed. A US sandbox was auto-created; a **GB** one now sits alongside it (`9341457906234565`). The warning was overstated.
- ✅ **Xero's granular scopes include `accounting.attachments`** — confirmed on the Configuration page. Our app was created after Xero's 2 March 2026 cutoff so it gets granular scopes only, and the one D43 depends on is granted.

**Still open, deliberately:** Zoho Books is not registered. Lowest UK practice share of the five, and nobody has asked for it.


*Status column is meant to be edited. When a reply arrives, change the box and add the date — this file is the tracker, not a snapshot.*