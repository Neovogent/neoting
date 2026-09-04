# Neoting — Australia Market-Entry Research

**Date:** 3 September 2026 · **Status:** research and gap analysis, not a decision. Verified codebase state as of this date; regulatory and market claims cite URLs. Claims marked **[INFERENCE]** or **[UNVERIFIED]** are exactly that — see §7 for the full register.

---

## Executive summary

**Recommendation: CONDITIONAL GO — sequenced, not now.** Australia is a real, well-shaped market for Neoting, but not for Initial Delivery. Enter after UK ID proves, as the first international market, on the four conditions below.

### The three things that matter most

**1 · The free incumbent is real, and it is getting better.** Hubdoc is bundled free with every paid Xero business plan, and 64% of surveyed Australian bookkeepers already use it with clients (ICB Annual Survey Ed. 13) — more than Dext (36%). Worse: Xero is replacing Hubdoc with JAX-powered "Smart Document Capture" — free, native, claiming multi-line itemised extraction, in AU/NZ beta since July 2026. Any pitch built on "Hubdoc can't do line items" has a shelf life measured in quarters. The durable wedge is the spine Xero is not building: identity-gated multi-channel intake, SMS chasing with no app, provable statement completeness (D41), cross-client practice triage, enforced Review→Approve, and source-linked export. That spine has **no single competitor at any price** in Australia — the nearest functional stack (Dext + ApprovalMax) exceeds A$80/entity/month.

**2 · The build is UK-specific at the edges, not the core — with three correctness-critical exceptions.** Integer pence→cents, UTC storage, and day-first date parsing all carry over unchanged (Australia is day-first, cents-exact electronically). What does not: (a) the whole **VAT/HMRC field model** must become GST/ATO/ABN — tax-invoice fields are legally prescribed and different, ABN replaces the VAT number with its own mod-89 checksum and a free ABR lookup API; (b) **`Europe/London` is hardcoded in rendering** (`sms-copy.ts`, `email-copy.ts`, web) and Australia has up to five simultaneous local times with partial DST — per-tenant timezone is mandatory, not cosmetic; (c) the **VT Transaction+ export target does not exist in Australia** — the egress question reopens as "Xero, and probably via API," which collides with D42's export-only stance. Plus one new legal duty with no UK analogue: **TFNs must be detected and never stored** (Privacy (TFN) Rule 2015).

**3 · The regulatory path is clear and mostly favourable — with two launch gates.** The ATO accepts digital images of paper receipts as records (TR 2018/2) — the core product claim holds. Software vendors do not need TPB registration when positioned as a tool used by registered agents (TPB(GS) 14/2011), and D44's super-admin-release model maps cleanly onto the registered BAS/tax agent. There is no legal data-residency requirement, but APP 8 and market expectation both point at AWS Sydney — where Textract and Bedrock-with-Claude are both available, so the extraction stack can run in-country (a D30 versioned amendment). The two hard launch gates: the **ACMA SMS Sender ID Register** (mandatory since 1 July 2026 — an unregistered "Neoting" sender ID gets stamped "Unverified" on every chase), and **GST/pricing treatment** of D48's client-paid subscription (unregistered micro-clients count as "consumers" toward the A$75k inbound-supplies registration threshold).

### Conditions on the GO

1. **Wedge check against JAX** at decision time: if Xero has shipped free line-item extraction *and* client chasing, the case collapses to chasing + completeness + practice spine only — still real, but thinner.
2. **An egress decision before entry:** VT has no AU analogue; ship a Xero-shaped CSV emitter at minimum, and accept that a competitive AU launch almost certainly needs the D6 Xero API adapter (attachment-travels-with-bill is the incumbent norm there).
3. **A Sydney deployment as a D30 versioned amendment**, with the D28 model IDs re-verified for ap-southeast-2 (in-region Claude availability confirmed in general; the exact pinned IDs are not — §7).
4. **Localisation scoped as one package** (GST/ABN/BSB/tax-invoice fields, per-tenant timezone, AU bank dialects, ACMA/Spam Act SMS compliance, AUD Stripe price ~A$15–20 ex GST) — roughly 6–10 engineering weeks **[INFERENCE]**, dominated by contract (LAW) changes, not by the money or date cores, which already fit.

### Price

£8.50 ≈ **A$16.00** ex GST (GBP/AUD ≈ 1.88, RBA 3 Sep 2026). That lands in the lower-middle of the paid capture band (EzzyBills ~A$11–25, AutoEntry A$22+, Dext direct A$33.58+, Datamolino A$35+) and 4–5× under the nearest functional stack — but the reference price in the buyer's head is **zero**, because two-thirds of bookkeepers use free Hubdoc. Price in AUD locally; do not convert.

---

## A · Government, regulator and compliance

All primary-source claims below were researched 3 Sep 2026. ato.gov.au and tpb.gov.au block automated fetches; where content was confirmed via search excerpts/verbatim reproductions rather than a direct page read, substance is verified but exact punctuation is reconstructed.

### A.1 GST

- **Rate 10%**, unchanged since 1 July 2000. No rate change legislated or formally proposed as of Sept 2026 (the Aug 2025 Economic Reform Roundtable saw external proposals only; any change needs all states' agreement). https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/how-gst-works
- **Registration threshold A$75,000** GST turnover (current or projected 12-month); **A$150,000** for non-profits; register within 21 days of crossing. Mandatory regardless of turnover for taxi/ride-sourcing. https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst
- Contrast with UK VAT: one flat rate (no reduced/zero-rate ladder to model for the common case), and GST is conventionally computed as **1/11 of the GST-inclusive total**.

### A.2 BAS and IAS — the "VAT return" analogue, but broader

- The **Business Activity Statement** reports GST (1A/1B, G-labels), **PAYG withholding** (W-labels), **PAYG instalments**, FBT instalments, WET, LCT, fuel tax credits — one form, several taxes. https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/due-dates-for-lodging-and-paying-your-bas
- **Cycles:** monthly mandatory at ≥ A$20M GST turnover (due 21st of following month); **quarterly is the small-business norm**; annual only for voluntary registrants under the threshold. "Simpler BAS" is default under A$10M.
- **Quarterly due dates:** 28 Oct / 28 Feb / 28 Apr / 28 Jul. Self-lodged online: +2 weeks on Q1/Q3/Q4. **Via a registered agent (the lodgment program):** Q1 25 Nov, Q2 28 Feb (no concession), Q3 26 May, Q4 25 Aug. https://www.ato.gov.au/tax-and-super-professionals/for-tax-professionals/prepare-and-lodge/bas-agent-lodgment-program-2026-27
- **IAS** (Instalment Activity Statement): a stripped-down BAS for periods/entities with PAYG obligations but no BAS — e.g. medium withholders lodging monthly IAS between quarterly BAS. Trigger thresholds ($25k withholding) are practitioner-sourced, **[UNVERIFIED]** against a primary page.
- **Product meaning:** the natural period object for an AU practice is the **BAS quarter** (Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun), not the UK VAT quarter; chase cadence and "statement coverage grid" framing should align to it.

### A.3 PAYG withholding and instalments

- **PAYG withholding** ≈ UK PAYE: tax withheld from wages (and from suppliers quoting no ABN), remitted via BAS/IAS, reported per-payday through STP. https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding
- **PAYG instalments** — prepayments of the business's **own** income tax, ATO-initiated. **No UK analogue**; do not conflate. Both appear as ATO payments on bank statements and must be coded (and chase-redirected) correctly. https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/payg-instalments

### A.4 Tax invoice requirements — constrains extraction fields directly

Per the ATO (QC 22436), a tax invoice for a sale **under A$1,000** must show **seven things**:
1. intent that the document **is a tax invoice** (usually the words "Tax Invoice");
2. the **seller's identity**;
3. the **seller's ABN**;
4. the **issue date**;
5. a **brief description incl. quantity (if applicable) and price**;
6. the **GST amount** — shown separately, or if GST is exactly 1/11 of the total, the statement "**Total price includes GST**";
7. **the extent to which each sale is taxable**.

For sales of **A$1,000 or more (GST-inclusive)**: all of the above **plus the buyer's identity or ABN**.

The **A$82.50 rule**: a tax invoice is required to claim a GST credit only for purchases **over A$82.50 GST-inclusive**; at or below that, other evidence suffices (receipt, docket, bank statement). Sellers must supply a tax invoice within 28 days of request. https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices · https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits/when-you-can-claim-a-gst-credit

**Extraction consequences:** first-class fields become supplier **ABN** (not VAT number), the **"Tax Invoice" heading** (its absence on a >$82.50 purchase invoice is a flaggable defect — D46 territory), **GST amount or "total includes GST"** statement, **taxable-extent** markers, and **buyer identity/ABN at ≥ A$1,000**. A non-GST-registered supplier must NOT issue a "tax invoice" or charge GST — an "invoice" headed correctly with no GST is valid and common (unregistered tradies), and the validator must not flag it as an error.

### A.5 ABN and ACN

- **ABN**: 11 digits, issued via the **Australian Business Register** (ATO). **ACN**: 9 digits, issued by **ASIC** at company registration. A company's ABN = **2 check digits + its ACN**. https://abr.business.gov.au/Help/AbnFormat · https://www.asic.gov.au/for-business-and-companies/companies/register-a-company/australian-company-number-acn
- **ABN checksum (modulus 89):** subtract 1 from the first digit; weight digits by 10,1,3,5,7,9,11,13,15,17,19; sum; valid iff sum mod 89 = 0. (abr.business.gov.au/Help/AbnFormat, fetched directly.)
- **ACN checksum (modulus 10 complement):** weight first 8 digits by 8,7,6,5,4,3,2,1; sum mod 10; check digit = 10 − remainder (0 if 10). ASIC-published algorithm.
- **Free lookup API — the HMRC check-VAT analogue exists:** ABR web services (ABN Lookup) are free; register, accept the agreement, receive an authentication GUID. Returns entity name, ABN status, **GST registration status** — which the tax-invoice validator needs. https://abr.business.gov.au/Tools/WebServices
- **Field mapping:** on invoices the identifier that appears is the **ABN** (not the ACN) — so `vatNumber` maps to ABN; `companyNumber` (Companies House CRN) maps to **ACN** for companies, but many clients (sole traders, partnerships, trusts) have an ABN and **no ACN** — the intake model must not require a company number.

### A.6 STP and superannuation — out of scope, but visible in the data

- **Single Touch Payroll**: employers report pay/withholding/super to the ATO each pay run from STP-enabled software. **Superannuation guarantee: 12% from 1 July 2025 (final legislated rate)**; "Payday Super" from 1 July 2026. https://www.ato.gov.au/businesses-and-organisations/hiring-and-paying-your-workers/single-touch-payroll/what-is-stp · https://www.ato.gov.au/businesses-and-organisations/small-business-newsroom/the-final-sg-rate-increase-is-coming-on-1-july
- **Assessment [INFERENCE]:** neither touches a product that does not run payroll. Obligations attach to the employer and their payroll software. Neoting will *see* wages, super and ATO lines on bank statements and must code and chase-redirect them (super → provider schedule, wages → payroll run — the §24.2.3 redirect list, re-pointed). Do not claim or imply STP capability.

### A.7 TPB — who may legally do this work

- Registration with the **Tax Practitioners Board** is required to provide a **tax agent service** or **BAS service** *for a fee*. Bookkeepers providing BAS services for a fee must register as **BAS agents**. https://www.tpb.gov.au/bas-agent-registration · https://www.tpb.gov.au/bas-services
- **Software alone does not require registration.** TPB(GS) 14/2011: a provider who "writes and sells non-customised accounting software is not providing a tax agent service, even if the software includes tax calculators or a lodgement feature" — it is a tool. Risk arises only where the vendor gives advice on a client's particular circumstances requiring interpretation of tax law, or bundles an outsourced service. "Mere data entry" and coding under supervision of a registered practitioner are explicitly not BAS services (TPB factsheet). https://www.tpb.gov.au/tpb-gs-14-2011-digital-service-providers-and-tax-agent-services-act-2009
- **Fit with our role model:** D44's composition-vs-release split maps cleanly — the practice super admin (the registered agent, accountable to the TPB) releases; the product composes and the human approves. AI auto-coding *relied upon* by an end business, sold for a fee without an agent in the loop, is the grey zone — the standalone-business persona (SoT §3.2) deserves Australian legal advice before it is marketed there. **[INFERENCE on the fit; guidance citations verified.]**
- **Unregistered conduct penalties:** civil penalties up to 250 units ($82,500) individual / 1,250 units ($412,500) body corporate; a draft expansion (criminal offences, higher maxima) was consulted on — **[UNVERIFIED as enacted]**. https://www.tpb.gov.au/civil-penalty-provisions
- **Code of Professional Conduct Determination 2024** (F2024L00849, from 1 Jan/1 Jul 2025): s 15 (no false/misleading statements to ATO), **s 30 (keep proper records of services — 5 years)**, s 45 (keep clients informed). A platform that evidences who did what, when, with source documents attached, directly supports s 30 — a sales asset. https://www.legislation.gov.au/F2024L00849/latest/text

### A.8 Record keeping — the core product claim holds

- **5 years**, running from when the record was prepared/obtained or the transaction completed, whichever is later (longer for open review periods, CGT, FBT). https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/record-keeping-for-business/overview-of-record-keeping-rules-for-business
- **Digital images of paper records are accepted**: "The ATO accepts images of business paper records saved on a digital storage medium, provided the digital copies are true and clear reproductions" — and **the paper can then be discarded** unless another law requires it. Governing ruling TR 2018/2: images must be unaltered once stored, retrievable, readable, in English. This is the UK "digital records are fine" claim, verified for Australia. https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/record-keeping-for-business/setting-up-and-managing-records/business-record-keeping-systems/digital-record-keeping
- Product notes: immutable original + provenance-tracked corrections (our Stage 8 design) matches TR 2018/2's no-alteration requirement; the archive default should be ≥ 5 years (UK's 6-year habit over-complies harmlessly).

### A.9 Privacy Act 1988, APPs, data residency (vs D30)

- **Coverage:** APP entities = government + organisations with **annual turnover > A$3M**, plus carve-outs (health providers, traders in personal information, etc.). The $3M small-business exemption **still stands as of Sept 2026** — its removal is in the **Tranche 2 exposure draft (Privacy Amendment (Personal Data Protection) Bill 2026)**, consultation only, not law. Separately, from 1 July 2026 AML/CTF tranche 2 made accountants and BAS/tax agents "reporting entities", pulling them under the Privacy Act via the AML carve-out — i.e. **our customers are APP-covered even when small**. https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business
- **APP 8 (cross-border):** before disclosing personal information overseas, take reasonable steps to ensure the recipient complies with the APPs, and remain **accountable** for their breaches (s 16C). A UK-hosted deployment serving AU practices is lawful but drags every accountant into cross-border disclosure posture. https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information
- **Data residency: no general legal requirement** for accounting/tax or business records — the ATO's test is producibility, not location (TR 2018/2 contemplates offshore cloud). Sector exceptions exist (My Health Records, APRA). **Market expectation is the real constraint**: AU firms prefer onshore hosting (competitor Annature leads with "documents never leave Australia"). https://resourcehub.bakermckenzie.com/en/resources/global-data-and-cyber-handbook/asia-pacific/australia/topics/data-localization-and-regulation-of-non-personal-data
- **Against D30:** D30 promises UK residency as a versioned-amendment-only commitment, chosen because "a residency promise to accountants handling their clients' financial records outranks a model version." The same logic lands in Sydney for Australia: **an AU deployment needs its own region (ap-southeast-2) via a D30-style versioned amendment**, not config. AWS Sydney has Textract (since Dec 2019) and Bedrock with Anthropic Claude (since Apr 2024) — the extraction stack can run in-country. Melbourne (ap-southeast-4) is too thin for primary; it is the natural DR target, which is *better* than the UK's position (D30's one exception exists because the UK has a single region — Australia has two). https://aws.amazon.com/about-aws/whats-new/2024/04/amazon-bedrock-sydney-region · https://aws.amazon.com/about-aws/whats-new/2019/12/amazon-textract-now-available-sydney-north-california-regions
- **NDB scheme:** eligible breaches notified to OAIC + individuals; 30-day assessment ceiling. **2024 Act:** statutory privacy tort live since 10 June 2025; automated-decision transparency in privacy policies required from **10 Dec 2026** — relevant to AI coding suggestions. https://www.oaic.gov.au/privacy/notifiable-data-breaches/when-to-report-a-data-breach
- **TFN Rule (no UK analogue):** the Privacy (Tax File Number) Rule 2015 restricts who may collect/record TFNs; unauthorised recording is an offence (TAA ss 8WA/8WB). TFNs appear on payment summaries and super letters that clients WILL photograph. **The pipeline must detect and redact/refuse to store TFNs** — the PAN-handling analogue. https://www.oaic.gov.au/privacy/privacy-legislation/the-privacy-act/tax-file-numbers

### A.10 Peppol e-invoicing

- ATO is the Australian **Peppol Authority**; no central clearance platform; GST still reported via BAS. Mandate is **government-facing only**: Commonwealth NCEs must receive eInvoices (since 1 Jul 2022), with 2025–26 targets making eInvoicing their default. The proposed **B2B "Business eInvoicing Right" was not proceeded with** — adoption is voluntary; 400k+ businesses registered. https://www.ato.gov.au/businesses-and-organisations/einvoicing/einvoicing-for-government
- Ground truth on adoption: AU-native competitor EzzyBills **discontinued** its accredited eInvoicing service mid-2024 citing "extremely low adoption rates" (ezzybills.com/e-invoicing/). No compliance obligation for Neoting; Peppol UBL ingestion is a later differentiator, not a gate.

### A.11 CDR open banking — the TrueLayer analogue, and its real burden

- **Full Accredited Data Recipient (unrestricted) accreditation is heavy:** fit-and-proper checks, 24 prescribed Schedule-2 infosec controls over a defined "CDR data environment", AFCA membership, adequate insurance, and an **ASAE 3150 reasonable-assurance report** at accreditation plus Type 2 every two years (ISO 27001 alone does not qualify). Audits historically **$60k+ at the low end** (secondary); 6–12 month programmes are ecosystem folklore **[UNVERIFIED timing]**. Honest read: **wrong first step for a small SaaS** — ~64% of data recipients are representatives instead. https://www.cdr.gov.au/for-providers/become-accredited-data-recipient
- **The realistic routes:** (1) **CDR representative** — contract with a principal ADR who carries liability; live in weeks; this is the D4-analogue path. (2) **Sponsored accreditation** — lighter, little-adopted. (3) **Trusted adviser disclosures** — CDR Rule 1.10C(2) lists **registered tax agents and BAS agents** as trusted advisers who may receive CDR data with consumer consent; the natural fit for an accountant-facing product, noting the *software vendor* is not the trusted adviser — structure matters. https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/trusted-advisers-in-the-consumer-data-right-system
- **Accredited intermediaries exist and are real:** Basiq (Cuscal-owned), Frollo (ADR since day one, 110+ data holders), Adatree (Fat Zebra-owned). https://www.basiq.io/resources/open-banking-access-models.html
- **Screen scraping:** government has called it "fundamentally unsafe" and asked Treasury to advise on a full ban — **no ban legislated as of Sept 2026**, but plan for its demise; the AU bank-feed strategy is CDR-via-intermediary, exactly the provider-agnostic seam D4/D40 already preserve. https://treasury.gov.au/consultation/c2023-436961
- **For ID-equivalent scope none of this matters** — D40's manual-upload-only stance carries to AU unchanged, and §B.4 of this report shows AU banks' export formats make that viable.

### A.12 SMS rules — a hard launch gate

- **ACMA SMS Sender ID Register: mandatory now.** From **1 July 2026**, alphanumeric sender IDs must be registered; unregistered branded IDs are over-stamped **"Unverified"** on the recipient's phone (or blocked). Registered IDs must match the registering organisation's name/brand; ABN-holders register directly or via a participating telco. Twilio has separately required AU alphanumeric sender-ID pre-registration since 25 Apr 2023. **Consequence:** "Neoting" must be registered before the first chase is sent; per-practice branded sender IDs would each need registration under the practice's ABN — an onboarding-flow consideration. Fallback: numeric long code (no registration, less trusted, but two-way capable). https://www.acma.gov.au/articles/2025-11/call-action-all-organisations-using-branded-sms · https://www.twilio.com/en-us/blog/insights/australia-sender-id-register
- **Spam Act 2003:** commercial messages need consent + identification + unsubscribe. Purely **factual/transactional** messages are outside the definition (identification still required) — a document chase naming a transaction is plausibly factual, but ACMA polices the line aggressively (DoorDash, CommBank enforcement); one marketing link converts the message. Keep chase templates strictly factual — which D16/D44's controlled-template design already enforces. https://www.acma.gov.au/avoid-sending-spam

### A.13 GST on our own pricing (D48 in Australia)

- **Display:** prices shown to consumers must be GST-inclusive single figures (ACL s 48); **B2B-only pricing may be quoted ex-GST if clearly labelled** — the market convention for partner SaaS ("A$X + GST"). D48's tax-exclusive posture survives only if the audience is strictly business; since **the client business pays** in ID's model, and micro-clients may be unregistered, lean GST-inclusive on client-facing screens. https://www.accc.gov.au/consumers/pricing/price-displays
- **Registration:** a UK company selling SaaS to Australian **GST-registered businesses that provide an ABN** makes supplies "not connected with Australia" — no GST charged, not counted toward the threshold. Sales to **unregistered** businesses/individuals are consumer sales counting toward the **A$75,000** registration threshold ("Netflix tax"), with simplified GST registration available (no input credits). D48's payer is the client business, and many bookkeeping clients sit under the A$75k GST threshold — **so Neoting AU should expect to need GST registration**, and should verify each paying client's ABN/GST status via the free ABR API at signup (evidence + data-quality check in one). https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/gst-for-non-resident-businesses
- **Entity:** carrying on business in Australia requires ASIC registration as a foreign company (ARBN) or an AU subsidiary; pure offshore SaaS sales generally do not, hiring AU staff generally does. https://www.asic.gov.au/for-business-and-companies/foreign-companies/register-a-foreign-company-in-australia

---

## C · Terminology — the UK → AU translation table

Getting these wrong makes the product read as foreign on the first screen. All verified via the sources in §A / agent research unless marked. AU English keeps British spelling (colour, organise) — the en-GB copy base survives; the domain vocabulary does not.

| UK (in product today) | Australia | Notes / where it bites |
|---|---|---|
| VAT | **GST** | 10% flat vs 20%+reduced. Every label, validator name, seed row |
| VAT return / VAT quarter | **BAS** (Business Activity Statement) | Broader than VAT: GST + PAYG W + PAYG I. Quarters are Jul–Sep etc. |
| VAT number (GB…) | **ABN** (11 digits, mod-89 checksum) | The number on invoices. `vatNumber` fields, HMRC-check copy in `ClientIntakeForm.tsx` |
| HMRC | **ATO** | `LandingView.tsx` "does not file with HMRC" → ATO; bank-line coding (HMRC VAT/PAYE → ATO BAS/PAYG) |
| HMRC check-VAT-number API | **ABR ABN Lookup web services** (free, GUID auth) | Also returns GST-registration status — needed by the tax-invoice validator |
| Companies House | **ASIC** | Intake pre-fill: ASIC registry data is not a free-API equivalent — use ABR name→ABN search instead **[INFERENCE]** |
| Company number (CRN, 8 chars) | **ACN** (9 digits, mod-10-complement check) | Companies only; sole traders/partnerships/trusts have ABN, **no ACN** — `companyNumber` must be optional |
| Confirmation statement | **Annual review** (fee A$342 + solvency resolution) | Copy-level only |
| Ltd | **Pty Ltd** | Entity-name parsing/supplier matching: "Pty Ltd", "Pty. Ltd.", "Proprietary Limited" |
| Sort code (XX-XX-XX) | **BSB** (6 digits, XXX-XX X format **XXX-XXX**) | No checksum; AusPayNet register lookup. `sortCode` in prisma, `BankView.tsx`, `generate.ts` |
| Account number (8 digits) | **6–10 digits, variable by bank** | Parsers must not assume fixed length |
| PAYE | **PAYG withholding** | Plus **PAYG instalments** — a second concept with no UK analogue |
| Pension / auto-enrolment | **Superannuation** ("super"), SG 12% | Chase-redirect list: super → provider schedule |
| Tax year 6 Apr – 5 Apr | **Financial year 1 Jul – 30 Jun** ("income year"; "EOFY" is a load-bearing cultural term) | Year-end defaults, "current FY" labels, period pickers |
| Invoice | **Tax invoice** (legally loaded heading) | >$82.50 claims need one; ≥$1,000 must add buyer identity/ABN. Absence of the heading is a flaggable defect |
| "Missing VAT" status | "Missing GST" | `apps/web/src/lib/generate.ts:608` and friends |
| NI number | **TFN — must NOT be stored** (TFN Rule 2015) | New extraction *redaction* requirement, not a rename |
| FSCS | **FCS (Financial Claims Scheme)** **[UNVERIFIED — not researched this session]** | Only appears in demo statement generation (`scripts/demo/bank-statement/plan.ts:187`) |
| £ / pence | **$ / cents** (AUD) | `£` symbol hardcodes in `grounding.ts:185`, `sms-copy.ts` `formatGbp`, `resolver.ts`, `workflowParser.ts`, `document-detail.ts` |
| +44 7… mobiles | **+61 4…** (04XX XXX XXX domestic) | Chase SMS validation; quiet-hours per tenant |
| CHAPS/BACS/Faster Payments | **BPAY / EFTPOS / Osko / PayID / Direct Entry (BECS) / NPP** | Chase-suppression descriptor list (SoT §4 Stage 7) needs an AU table |
| SumUp/Worldpay payout descriptors | **Tyro, Square AU, Zeller** etc. **[INFERENCE — descriptor strings unverified]** | Same suppression list |
| Barclays/NatWest/Lloyds/HSBC/Starling (demo data) | **CBA, Westpac, ANZ, NAB** (+ Macquarie, Bendigo) | `scripts/demo/bank-statement/plan.ts` bank list |
| "Paid in / Paid out" statement columns | Varies: signed **Amount** (CBA, NAB) or **Debit Amount / Credit Amount** (Westpac) | `statement-parser.ts` header regexes — see gap D-U1 |
| Cheque (`CHQ` in VT types) | Cheque — declining; national wind-down announced **[UNVERIFIED date]** | Low impact |
| Date format d/m/y | **Same — day-first d/m/yyyy** (Aust. Govt Style Manual) | `parseStatementDate` carries over UNCHANGED — verified, not assumed. https://www.stylemanual.gov.au/grammar-punctuation-and-conventions/numbers-and-measurements/dates-and-time |
| Europe/London | **Per-tenant IANA zone** (`Australia/Sydney`, `Brisbane`, `Adelaide`, `Perth`, `Darwin`, `Hobart`…) | Not a rename — an architecture change; see D-W3 |
| en-GB speech recognition | **en-AU** | `apps/web/src/lib/useSpeech.ts:57` |
| "Accountant / bookkeeper" | Same words — but AU bookkeepers are **registered BAS agents** (a regulated identity) | Marketing and role copy should name BAS agents explicitly |

Currency mechanics note (verified): 1c/2c coins withdrawn 1992; **cash** rounds to 5c but **electronic amounts stay exact to the cent** — integer-cents arithmetic is untouched; a 1–2c mismatch between a cash receipt and its total is legitimate rounding, worth a matching tolerance rule.

Timezone facts (verified, timeanddate.com): three standard zones (AEST +10, ACST +9:30, AWST +8); NSW/VIC/SA/TAS/ACT observe DST (first Sun Oct → first Sun Apr), **QLD/WA/NT do not** — five distinct mainland local times each summer, plus Lord Howe's half-hour DST and Eucla +8:45.

---

## B · The competitive field

Researched 3 Sep 2026; prices AUD ex GST unless noted. Fuller sourcing in the agent register (§7 notes the partisan-source caveat: several comparison articles are competitor-authored; vendor pages preferred throughout).

### B.1 The two that define the market

**Dext (ex Receipt Bank; IRIS Software Group since 23 Dec 2024).** Sydney office since 2014; real AU presence. Business plan **A$33.58/mo annual (≈A$42 monthly)** for 250 docs; **line items are a paid add-on** (from A$28.50/mo or A$0.70/doc); bank statements extra. Partner (per-client) AUD pricing is unpublished — gated behind a plan builder; third-party estimates ~US$17.70–19.20/client with a 10-client minimum **[UNVERIFIED]**. Weaknesses, documented: the Aug 2023 move to per-client pricing produced 175%+ bill jumps and lasting resentment (AccountingWEB threads; firms moved to free Hubdoc); **paperwork requests require the client's mobile app** (Dext's own help docs — the exact gap our SMS/OTP chase attacks); cancellation friction; pricing opacity is the top complaint on an otherwise strong 4.8/5 Xero App Store AU rating (1,113 reviews). Sources: dext.com/au/business/pricing · help.dext.com/en/s/article/requesting-paperwork-for-bank-transactions · accountingweb.co.uk/any-answers/dext-pricing-change-from-today · irisglobal.com/news/iris-software-group-completes-dext-acquisition/

**Hubdoc (Xero-owned since Aug 2018, US$70M).** Bundled **free** with Xero business plans since 18 Mar 2020 (not Cashbook/Ledger); standalone US$12/mo still sold. Used with clients by **64% of ICB-surveyed bookkeepers** — the anchor product. Weaknesses, all documented: **header-only extraction — "Hubdoc doesn't automatically extract line item data" (Xero's own docs), and Xero stated no further Hubdoc development is planned**; no approvals; automated bank/supplier fetch retired in AU (Apr 2022 — no AU banks remain); widely reported slowness and stagnation. **The strategic finding: Xero is retiring the brand.** xero.com/au/pricing no longer names Hubdoc; "Smart document capture", powered by **JAX**, is in **AU/NZ beta since 2 July 2026** and explicitly promises multi-line itemised extraction, with GST extraction and bank-statement PDF conversion on the roadmap. Sources: central.xero.com/s/article/About-data-extraction-in-Hubdoc-US-SG-SA-ROW · blog.xero.com/product-updates/smart-document-capture/ · content.hubdoc.com/hubdoc-product-update/hubdoc-included-select-xero-plans · ICB Ed.13 PDF (icb.org.au)

### B.2 Platform-native capture (MYOB, QuickBooks)

- **MYOB**: In Tray + the new **MYOB Assist** app (free with paid plans) — **header-level only**; MYOB's own community answers confirm totals land as a single line; line items arrive only via Peppol eInvoicing or partner feeds. Supplier matching keys on **ABN** — the local convention we must match. Legacy Capture app dies 29 Sep 2026.
- **QuickBooks Online AU**: receipt capture in all plans (Simple Start A$33 → Advanced A$125, third-party-verified); extracts date, amount, vendor, card last-4 — **no line items**; expense claims need the top plan. Intuit Intelligence AI live in AU since Nov 2025.
- Both are single-file staging areas: **no practice-level inbox, no chasing, no cross-client triage** — an accountant with 50 clients works file by file.

### B.3 The adjacent field

| Player | What it is | Price (AUD/mo ex GST) | Weakness vs our spine |
|---|---|---|---|
| **Lightyear** (Access Group since May 2024; Sydney+Belfast) | Mid-market AP suite; genuine line items; approvals; 3-way matching | **$155–255**/org floor | Priced out of micro-clients; "100% accuracy" applies to digital-native PDFs emailed in, not photos; no chasing |
| **ApprovalMax** (Yttrium-funded, no acquisition) | Approvals layer on Xero/QBO/NetSuite; native Capture since Jun 2024 | $82.80/org legacy; 2026 usage-model AUD matrix unpublished | Approvals-first; capture depth thin off Xero; hourly Xero sync; per-org pricing stacks badly across a client book |
| **AutoEntry** (Sage since 2019) | Credit-based capture with line items (2 credits) | Bronze $22 (50 credits) → Sapphire $687 | Slow (30 min–24 h by its own docs); credit expiry friction; bank statements 3 credits/page |
| **Datamolino** (independent, Bratislava) | Capture incl. line items + approvals; AUD pricing; Xero AU 4.92/5 | $35 ($65 w/ line items) → $300 | Tiny company; line items double the price; no chasing/bank matching |
| **EzzyBills** (AU-native, EzzyDoc Pty Ltd) | Line items, GL coding, **ABN supplier matching**, approvals; Xero/MYOB/QBO | ~$11–50 equiv (annual-only, inc GST) | Thin reviews; dated UX; offshore-hosting claim [UNVERIFIED]; discontinued its own Peppol service for lack of demand |
| **Annature** | **Not a competitor** — AU eSigning/KYC (DocuSign rival), pay-per-envelope | n/a | Same buyer, zero overlap; plausible integration partner (engagement letters, TPB-compliant ID verification at client onboarding) |
| **Content Snare** (Brisbane) | Client document/info collection with automatic reminders | US$35–215 (no AUD list) | The closest chasing competitor — but email/portal reminders, no SMS, no extraction, no coding, no matching |
| **Thriday → Tyro Accounting** (Tyro-owned Jan 2026) | Banking+bookkeeping+tax for sole traders | $29.95 (Time-saver) | Competes for the end-client, not the practice; watch Tyro's 76k-merchant distribution |
| **Weel, XBert, FYI, Squirrel Street, Process AI, BookWell, Tofu, Hnry** | Spend mgmt / data-quality audit / practice DMS / legacy scanning / new AI AP | various | None covers intake→chase→approve→export; XBert (13% ICB usage) audits *other* tools' output — complementary |

**The structural finding:** nobody in Australia sells the full spine — capture vendors don't chase, the chasing tool doesn't extract, approvals vendors assume coded documents arrive, and Lightyear's floor prices out the micro-client. Dext + ApprovalMax stacked ≈ **A$80+/entity/month** to approximate what Neoting does at ~A$16.

### B.4 The ledger layer — Xero is not a choice, it is the market

- **Xero:** company-reported AU subscribers 1.57M (FY23) → 1.77M (FY24) → 1.9M (H1 FY25); ANZ ~2.8M at FY26 ⇒ **AU ≈ 2.1M derived [company AU-only split UNVERIFIED for FY26]**. The decisive channel stat (ICB Annual Survey Ed. 13, n=1,057): **software used with clients — Xero 90%, MYOB 71%, QBO 39%, Reckon 20%**; bookkeepers' own practice: Xero 63%. Sources: ASX announcements (see register) · ICB Ed.13 PDF.
- **MYOB** (KKR since 2019): "1.2M businesses" incl. desktop/payroll [cloud split UNVERIFIED]; strong AccountRight legacy; second target, not first.
- **QBO AU:** last official figure 100k (2017); no current breakout exists. **Reckon:** flat Reckon One users, A$8.9M cloud revenue — effectively irrelevant.
- **Consequence: build Xero first; MYOB second; QBO third; Reckon never.** Same order of dominance as the UK stack assumption (D6 named Xero first anyway), so porting risk is low — and Xero is correspondingly the single point of platform risk (JAX, App Store terms).
- **Bank statement export reality (big four, for D40 upload-only):** all four offer CSV or spreadsheet export + universal PDF statements. **CBA**: CSV/OFX/QIF; the CSV is 4 columns (Date, Amount, Description, Balance) **with no header row** [widely reported, not confirmed on a CBA page]; ~2-year window. **Westpac**: CSV/QBO/QIF/OFX (primary-verified); CSV has split Debit/Credit columns **with running balance**. **ANZ**: CSV with date/description/amount, **no running balance** reported [partially UNVERIFIED]; ANZ Plus PDF-only. **NAB**: XLSX/QIF/PDF personal (primary-verified — no plain CSV), CSV/PDF/QIF on NAB Connect; single signed amount column. Running balance in CSVs is therefore inconsistent — D41's `reduced` assurance class will fire often, and PDF statements (which conventionally do carry balances) remain first-class input. Sources: westpac.com.au/faq/business-how-export-detailed-transaction-history/ · nab.com.au/personal/online-banking/nab-internet-banking/transaction-history

---

## D · Gap analysis

### D.0 What we verified in the codebase first

Every item below was read in the tree on 3 Sep 2026, not assumed:

- **Money:** integer pence throughout; `parseMoneyPence` ("£1,234.56 → 123456") in `apps/api/src/modules/banking-matching/statement-ingest/statement-parser.ts`; `prisma/schema.prisma` defaults `baseCurrency`/`currency` to `"GBP"` (lines 44, 89, 774, 811); `statement-ingest.ts` hardcodes `currency: 'GBP'` (lines 87, 198); `publish-follow-up.ts:95` defaults missing document currency to GBP ("v1 is UK practices"); `grounding.ts:185` renders GBP as `£`.
- **Dates:** `parseStatementDate` is day-first with month-first only when forced (`statement-parser.ts:140–198`); `vt-format.ts` emits `DD/MM/YYYY` by string rearrangement, deliberately never constructing a `Date`.
- **Timezone:** `Europe/London` hardcoded in `chase/sms-copy.ts:106`, `notifications/email-copy.ts`, and web (`AppContext.tsx`, `api/chases.ts`, `LiveBusinessPortal.tsx`, `ClientExpenseClaims.tsx`, `BusinessOnboardingView.tsx`); `en-GB` locale formatting across `apps/web/src` (e.g. `AppContext.tsx:877`, `lib/business.ts:33`); `useSpeech.ts:57` pins `en-GB` STT.
- **VAT/HMRC:** `vatNumber` in extraction (`document-extractor.ts:84`, `bedrock-extraction-schema.ts:56,114`) and prisma (47, 92); `checkVatArithmetic` (net+tax=gross ±1p, `bedrock-extraction-schema.ts:142–158`); SoT §4 Stage 2 mandates "VAT number, validated against HMRC's check-VAT-number API" and GB-checksum validators; web copy "VAT numbers are validated against HMRC" (`ClientIntakeForm.tsx:333`). Note: `packages/validators` is still an S0 scaffold with no sources — the deterministic validators live inline in extraction, which *lowers* the LAW-change surface for this gap.
- **Companies House:** `companyNumber` (prisma:82, `client-intake.service.ts:166`), "Auto-fetched from Companies House" (`ClientIntakeForm.tsx:293`), SoT §16 Companies House API.
- **UK banking shapes:** `sortCode` (prisma:775, `BankView.tsx`, `lib/types.ts`); header regexes `paid out|paid in|amount \(gbp\)` (`statement-parser.ts:91–96`); §24.2.2's per-bank UK code tables; UK descriptor suppression list (SoT §4 Stage 7).
- **Export:** VT Transaction+ is the sole real emitter (`exports-public-api/emitters/vt/`), UK d/m/y cells, VT journal-import semantics; `GENERIC_CSV` exists because the enum demands it.
- **Billing:** Stripe price "GBP 8.50/month tax-EXCLUSIVE" with an explicit **20% GB VAT rate** (`config/env.ts:445–470`, `STRIPE_TAX_RATE_ID`).
- **Residency and models:** D30 pins everything to eu-west-2 (one DR exception); D28 pins `anthropic.claude-opus-4-6-v1` / `claude-sonnet-4-6` / `amazon.nova-lite-v1:0` in-region; D22 pins Transcribe `en-GB`.
- **Demo/seed UK content:** `prisma/seed.ts` (GBP, 20% VAT arithmetic helper at line 68, "GB checksum ok"), `scripts/demo/bank-statement/plan.ts` (HMRC VAT QUARTERLY / HMRC PAYE monthly lines, UK bank list, fictional sort code, FSCS note, "VAT GB334455667, company 09112233").
- **i18n:** Governance §12.6 mandates message catalogues (react-intl in `apps/web`, `defaultMessage` descriptors) — terminology swaps ride an `en-AU` catalogue rather than a grep-and-pray sweep. Field *names* in `packages/contracts` (e.g. `vatNumber`) are LAW and are the expensive half.

### D.1 Tier 1 — would produce WRONG BOOKS (or wrong legal claims) if shipped as-is

**W1 · Tax model: VAT→GST field semantics.** What breaks: extraction prompts and validators ask for VAT numbers and imply UK rates; an AU "tax invoice" is validated against the wrong legal template; a GB-checksum ABN "passes"/fails wrongly; unregistered-supplier invoices (no GST — legal and common) get flagged as defective. Where: `extraction/bedrock-extraction-schema.ts`, `extraction/document-extractor.ts`, SoT §4 Stage 2 validator table, `prisma` `vatNumber`, contracts. Fix: ABN field + mod-89 checksum + ABR lookup (free API, GUID auth); "Tax Invoice" heading detection; GST=1/11 convention in implied-rate checks (`checkVatArithmetic`'s net+tax=gross core is rate-agnostic and survives); the A$82.50 / A$1,000 thresholds in D46's acceptability judgement. Difficulty: **M** — the arithmetic core survives; the cost is contract (LAW) field additions and prompt/validator config.

**W2 · TFN handling.** What breaks: storing a TFN photographed on a payment summary is a legal breach (TFN Rule 2015; TAA ss 8WA/8WB) — no UK analogue, so nothing in the pipeline looks for it. Where: extraction output handling, vault, portal upload flow. Fix: TFN pattern detection (9 digits, known weighting) + redact-before-store + never render. Difficulty: **S–M**, but compliance-critical and easy to miss.

**W3 · Timezone rendering.** What breaks: `Europe/London` renders AU instants up to 11 hours wrong — a chase SMS says "on 9 Aug" for a 10 Aug purchase; date-boundary logic (quiet hours 20:00–08:00 *local*, "received today", coverage grids) is wrong for every tenant, differently by state, and QLD/WA don't shift with DST. Calendar dates from statements are safe (stored as bare `YYYY-MM-DD`, never instants — `vt-format.ts` proves the discipline), so exports don't corrupt; rendering and scheduling do. Where: `sms-copy.ts:106`, `email-copy.ts`, `publish-projection.ts` note, five web files. Fix: per-practice (arguably per-client) IANA zone setting threaded through every formatter; quiet-hours per tenant. Difficulty: **M** — mechanical but wide; the invariant "UTC in storage, Europe/London in rendering" (root CLAUDE.md, Governance §12) becomes "UTC in storage, tenant zone in rendering" — a governance-text change too.

**W4 · Chase suppression/redirect tables.** What breaks: the UK descriptor list (`CHAPS`, `SUMUP`, `WORLDPAY`…) won't match AU bank narratives, so clients get chased for BPAY fees, Osko transfers, ATO BAS payments and super contributions — the §24.2.3 "over-chasing kills the channel" failure, in week one. Where: Stage 7 suppression config, §24.2.3 redirect list (HMRC→ATO, pensions→super schedules). Fix: AU descriptor table (BPAY, EFTPOS, OSKO, PAYID, DIRECT CREDIT/DEBIT, ATO, super clearing houses, Tyro/Square payouts) — needs corpus work with real AU statements; descriptor strings are **[UNVERIFIED]** until then. Difficulty: **S config, M to get right**.

**W5 · Billing tax config.** What breaks: `STRIPE_TAX_RATE_ID` attaches a 20% GB VAT rate; charging AU clients UK VAT is simply the wrong tax, and D48's "VAT must be expressed in sterling" invoice logic doesn't apply. Fix: AUD price object, AU GST treatment per §A.13 (registration likely needed given unregistered micro-clients), GST-inclusive display client-side. Where: `config/env.ts:445–470`, Stripe runbook. Difficulty: **S–M** plus accountant/lawyer sign-off.

### D.2 Tier 2 — makes the product UNUSABLE in Australia (fails loudly, not wrongly)

**U1 · Bank statement dialects.** What breaks: `findMapping` requires a header row naming a date and an amount — **CBA's CSV reportedly has no header row at all**, so the most common AU business bank's export is refused outright (`noHeaderRow`); Westpac's "Debit Amount"/"Credit Amount" headers don't match the anchored regexes (`^(paid out|debit|money out|…)$`), so Westpac refuses too; `amount \(gbp\)` needs an AUD sibling. The good news: D41 means these fail **loudly** — no silent wrong books — and `parseMoneyPence` already strips `$`. Where: `statement-parser.ts:91–96, findMapping`; PDF statements ride Textract, available in Sydney. Fix: AU header vocabulary + headerless-CSV positional inference (4-column CBA shape) + per-bank fixtures from real exports; ANZ's balance-less CSV lands in D41's existing `reduced` class. Difficulty: **M** — the architecture (mapping + gates + reduced-assurance) was built for exactly this variance; it needs an AU corpus, and the §24.2.2 finding ("codes are a hint, never a classifier") transfers verbatim.

**U2 · No usable export target.** What breaks: the sole real emitter speaks VT Transaction+ journal-import; VT is a UK desktop product with no observed AU presence **[INFERENCE — VT's AU market share was not separately researched; ICB survey does not mention it]**. `GENERIC_CSV` exists but D43's whole ladder (capability code in `Paid to/invoice details`, VT conversion-table semantics) is VT-shaped. Where: `exports-public-api/emitters/`, canonical model (survives — it was built as "canonical + per-target emitters" for exactly this). Fix: a **Xero bank/bills CSV emitter** as the ID-equivalent floor — noting D43's own cross-target research already concluded Xero's CSV carries no URL column, so the AU link ladder is the short typable code + manifest bundle (rungs 2+4), stated honestly. The competitive reality (§B): every incumbent attaches the source document via the **Xero API**; an AU launch that wants "attachment travels with the bill" needs the D6 Xero adapter — i.e. **D42's export-only posture is an ID decision that does not port to AU as a market stance**. Difficulty: **M for CSV emitter; the API adapter is the existing D6 v1 commitment pulled forward for AU**.

**U3 · Regulator integrations.** What breaks: HMRC check-VAT calls fail/return nothing for AU numbers; Companies House auto-fetch has no AU meaning. Fix: ABR ABN Lookup web services (free, GUID) for validation + intake pre-fill by name→ABN search; ASIC registry has no equivalent free API **[INFERENCE]**. Where: SoT §16 third-party rails row; intake service + `ClientIntakeForm`. Difficulty: **S–M**.

**U4 · SMS channel compliance.** What breaks: an unregistered "Neoting" alphanumeric sender ID is stamped **"Unverified"** on every chase (ACMA register, enforced since 1 Jul 2026) — reputationally fatal for a trust product; Twilio AU requires pre-registration anyway. Fix: register the sender ID pre-launch (ABN prerequisite — ties to the entity decision, §A.13); keep templates strictly factual under the Spam Act; quiet hours per tenant zone. Difficulty: **S process, with lead time**. WhatsApp: D25's "dedicated UK virtual number" needs an AU number; AU WhatsApp penetration is materially lower than the UK's **[UNVERIFIED — not researched; treat inbound WhatsApp as nice-to-have, not a launch channel]**.

**U5 · Residency and model stack.** What breaks: D30 permits no non-UK processing without a versioned amendment — an AU deployment is a new region, new KMS/buckets, new DPIA posture (APP 8, NDB). Fix: ap-southeast-2 stack via Terraform variables (D36 anticipated exactly this); Textract ✓ Sydney since 2019, Bedrock+Claude ✓ Sydney since Apr 2024, Melbourne as DR. **Re-run the D22-style W0 verification: whether D28's exact pinned IDs (`claude-opus-4-6-v1`, `claude-sonnet-4-6`, `nova-lite-v1:0`) are in-region in Sydney is [UNVERIFIED]** — the AWS matrix read confirmed newer Claude models in-region, not these three; Transcribe needs `en-AU`. Difficulty: **M infra, known shape**.

### D.3 Tier 3 — merely FEELS FOREIGN (copy, defaults, demo data)

- **£ and "VAT" everywhere client-visible:** `formatGbp` (`sms-copy.ts`), `£` literals in `apps/web/src/lib/{workflowParser,resolver}.ts`, `api/document-detail.ts`, "Missing VAT" (`lib/generate.ts:608`), "does not file with HMRC" (`LandingView.tsx`), vault categories "VAT registration certificate / PAYE reference letter" (`lib/seed2.ts:250–251`). Fix: en-AU message catalogue + currency formatter keyed off `baseCurrency` — the i18n discipline (Governance §12.6) makes this tractable; the lint rule against hardcoded strings means most are already in catalogues. Difficulty: **S–M sweep**.
- **Field names that stay wrong internally but invisible:** `amountPence`, `formatPenceDecimal`, `statementFindingAmountPence` (contracts = LAW). Renaming to `amountCents` buys no correctness (both are 1/100 minor units); recommend **accepting the naming** and documenting "pence = minor units" rather than a LAW-wide rename. **[JUDGEMENT CALL — flag to Shakib.]**
- **Defaults:** prisma `@default("GBP")` → AUD per-tenant; year-end default 30 June; financial-year pickers Jul–Jun; `en-GB` Intl calls → tenant locale `en-AU`; `useSpeech.ts` → `en-AU`.
- **Demo/seed honesty (Governance: "seed updated so screens stay honest"):** `prisma/seed.ts` and `scripts/demo/bank-statement/plan.ts` are wall-to-wall UK — HMRC PAYE lines, sort codes, FSCS notes, Barclays/NatWest. An AU demo needs AU banks, BSBs, ATO BAS/PAYG lines, GST at 1/11, an FCS-style note **[FCS equivalence UNVERIFIED]**.
- **Sort code UI:** `sortCode` fields/labels → BSB (XXX-XXX); account-number length assumptions relaxed to 6–10.

### D.4 What carries over UNCHANGED — worth stating

- **Integer minor-unit money** (AUD has exact electronic cents; only cash rounds to 5c) — the single most load-bearing invariant ports intact.
- **Day-first date parsing** — Australia is d/m/yyyy (Style Manual); `parseStatementDate` needs zero changes.
- **The D41 completeness architecture** — AU banks' inconsistent running balances make `reduced`-assurance and printed-totals gates *more* valuable, not less.
- **Review→Approve, D44's release authority** — maps onto the TPB-registered agent as the accountable releaser.
- **The i18n catalogue discipline, Zod boundaries, scopedDb tenancy, capability-URL export links** — jurisdiction-neutral.
- **Digital-image record keeping** — ATO-accepted (TR 2018/2), same as the UK claim.

### D.5 Effort shape [INFERENCE]

Roughly 6–10 engineering weeks for the localisation package (W1–W5, U1–U4, T3 sweep), dominated by: contract-change issues for tax fields (G7 process, Shakib approval), the AU statement corpus for U1/W4, and the Stripe/GST/entity workstream which is calendar-bound (registrations, ACMA sender ID) more than code-bound. U5 (region) and U2 (Xero adapter) are separate, larger decisions — the latter is really D6 v1 scope pulled forward.

---

## E · Go-to-market

### E.1 Market size (verified)

| Population | Count | Source |
|---|---|---|
| Actively trading businesses (30 Jun 2026) | **2,814,778** (996,203 employing) | ABS CABEE, 18 Aug 2026 — abs.gov.au |
| Small businesses (0–19 employees) | ~2.74M (≈97%) | ABS/ASBFEO definition |
| Registered tax practitioners (30 Jun 2025) | **63,865** = 46,900 tax agents + **16,965 BAS agents** | TPB Annual Report 2024–25 — tpb.gov.au/annual-report |
| Accounting Services businesses | ~36,717 (2025) | IBISWorld (secondary) |
| Agent-lodged returns | 61% of individual, **95% of non-individual** | TPB AR 2024–25 |
| CPA Australia / CA ANZ / IPA members | ~176k / ~140k global / ~50k | vendor sites (global counts) |
| ICB Australia members | ~3k full / ~5k incl. students **[UNVERIFIED — secondary]** | training-partner page |

The channel is regulated and enumerable: **every practising AU bookkeeper who lodges BAS is on the public TPB register** — a licensable target list the UK does not offer.

### E.2 How AU practices buy

- **Through the Xero ecosystem.** Partner program tiers, the Xero App Store, and the advisor directory make accountants/bookkeepers Xero's "decentralised sales force"; partner-led additions drive most net new subscribers. The App Store's 15% revenue share was **retired 2 Mar 2026** for a tiered developer subscription (Free/5 orgs → A$35/50 → A$245/1,000 → A$1,445/10,000 + A$2.40/GB egress; **ingress free**) — at 1,000 connected orgs that is ~**A$0.25/client/month platform COGS**, and it rewards publish-heavy (ingress) designs. Source: devblog.xero.com · truto.one/blog/xero-api-pricing-changes-2026.
- **Events and media:** Xerocon returns to Australia in **2027** (none in 2026 — London/Denver); until then Xero's AU Summer Series roadshows, ABN's The Bookkeeper Event, Accounting Business Expo. Trade media: Accountants Daily / Accounting Times (Momentum), INTHEBLACK (CPA), Acuity (CA ANZ); vendor-sponsored awards are the normal channel.
- **Bookkeeper bodies:** ICB Australia, Australian Bookkeepers Network (+ ABA, a TPB-recognised association). ICB survey: live webinars are the preferred training method, phone the preferred support channel — a direct steer for AU onboarding/support design.
- **Buying conventions:** partner SaaS quoted **per client entity per month, ex GST**, billed to the practice (Dext's model). **Note the friction with D48:** ID bills the *client business*; the entrenched AU partner model bills the *practice* with volume tiers. Whether client-paid subscription survives contact with AU practice buying is an open commercial question — flag to the CEO alongside D48's other open items.

### E.3 The honest wedge assessment

- **Hubdoc being free with Xero is a serious commercial problem — confirmed, not folklore.** 64% of ICB-surveyed bookkeepers use it with clients; the capture category's anchor price is zero; and Xero's JAX "Smart Document Capture" (AU/NZ beta, Jul 2026) is adding the line items Hubdoc lacked, for free, natively. **Do not enter on an extraction-quality pitch.**
- **What the field genuinely lacks** (§B.3): SMS chasing with no app (Dext requires its mobile app; Content Snare chases but can't extract), provable statement completeness (no one gates on it), practice-level cross-client triage (MYOB/QBO capture is per-file), enforced Review→Approve with a named releaser (maps to the TPB-registered agent and the 2024 Code's s 30 record-keeping duty), and source-linked export/audit trail. That spine at ~A$16 vs a A$80+ stack is the entry story.
- **Sizing sanity check [INFERENCE]:** 16,965 BAS agents × a plausible early book of 20–40 chargeable clients each gives a serviceable obtainable market in the low hundreds of thousands of client-entities; at A$16/mo, 1% of BAS agents with 25 clients ≈ A$815k ARR — a beachhead, not a land-grab. Cloud adoption is world-leading (Xero ~2.1M AU subs against ~1M employing businesses), so there is no evangelism tax; the fight is displacement of "free + manual chasing."
- **Risks to name:** Xero platform dependence (JAX scope creep; App Store terms); Dext's IRIS ownership funding an AU push; Tyro/Thriday attacking the micro end directly; the FX-free AUD price needing local GST/entity plumbing before the first dollar.

### E.4 Sequencing recommendation [INFERENCE]

1. **Now:** nothing in-product. Track JAX quarterly; keep the canonical-model/emitter and provider-agnostic seams clean (they are the port).
2. **Decision gate (post-UK-ID proof):** re-run the JAX wedge check; take the D42/D6 egress decision for AU; CEO decision on practice-pays vs client-pays for AU.
3. **If GO:** localisation package (§D.5) + Sydney region amendment + ACMA/Stripe/entity registrations in parallel (calendar-bound); pilot with 3–5 BAS agents recruited via ICB/ABN channels before any Xerocon 2027 spend.

---

## §7 · Verification register — what this report could NOT verify

Everything below is either stated with an [UNVERIFIED]/[INFERENCE] tag above or listed here so no silent gap survives:

**Regulatory:** IAS entry thresholds ($25k medium withholder, $4k instalment income) — practitioner sources only · penalty-unit value from 1 Jul 2026 ($364 claim) · enactment of expanded TPB sanctions (draft as at latest sources) · Peppol eInvoices qualifying as tax invoices without the heading (vendor claim) · CDR full-accreditation end-to-end timeline (only the $60k+ audit floor and 1–3-month sponsored assessment were citable) · ABR web-services exact response field list · Children's Online Privacy Code commencement · exact ATO page punctuation where gov sites blocked fetches (substance corroborated).

**Market/competitive:** Dext AU partner per-client AUD pricing (gated; USD estimates only) · Dext monthly business price ~A$42 (derived) · IRIS–Dext consideration (£500–525M media only) · Xero AU-only FY26 subscriber split (~2.1M derived from ANZ) · MYOB active cloud count · QBO AU subscribers post-2017 · Reckon cloud users · ICB survey editions 14/15 (all figures are Ed. 13, 2023 fieldwork — the 64%/90% channel numbers are three years old) · ApprovalMax 2026 AUD price matrix · CBA CSV "no header row" (widely reported, not on a CBA page) · ANZ AU export format list · EzzyBills HQ town and offshore-hosting claim · Content Snare AUD pricing · Hubdoc "shut down May 2026" rumour (**likely false** — live pricing page contradicts it) · AU cloud-accounting adoption percentage (directionally strong, no authoritative figure).

**Product-relevant:** whether D28's exact pinned model IDs are in-region in ap-southeast-2 (newer Claude models confirmed in Sydney; the three pinned IDs not checked — re-run W0-style verification) · VT Transaction+ having no AU market presence (inference from its UK-only positioning and total absence from AU practice surveys; not separately researched) · FCS as the FSCS analogue in demo copy (not researched) · AU WhatsApp penetration vs UK (not researched) · AU bank narrative descriptor strings for the suppression table (needs a real statement corpus) · cheque wind-down date · Twilio AUD SMS unit pricing (not researched).

**Method note:** competitive-weakness sources include competitor-authored comparison content (Receiptflow, StackPick, Pulsify et al.); vendor pages and first-party docs were preferred wherever both existed, and review-platform scores are quoted with their bases. Exchange rate: RBA A$1 = £0.5310 (3 Sep 2026) ⇒ GBP/AUD ≈ 1.883.

*End of report.*
