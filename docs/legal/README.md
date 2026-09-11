# Legal pack — version 1.0, in force

Four documents, drafted from the product's own documented behaviour and from the SoT's own
commitments, and **reviewed and approved by a UK solicitor on 11 September 2026**:

| Document | Why it exists |
|---|---|
| `terms-of-service.md` | The contract with the accounting practice. |
| `privacy-notice.md` | UK GDPR Art. 13. Required **at the point of collection**. |
| `data-processing-terms.md` | UK GDPR Art. 28(3). Required **before** a practice uploads a client's records. |
| `refund-and-cancellation.md` | Stripe requires a reachable refund policy; customers need a way out. |

> **Status: published.** All four are **version 1.0**, solicitor-reviewed and approved on
> 11 September 2026, in force from the same date. Both drafting banners have been removed
> from the source files, and `TERMS_VERSION_IN_FORCE` in
> `apps/api/src/modules/auth-tenancy/practice-signup.service.ts` moved `0.1` → `1.0` in the
> same change — a signup naming any other version is refused, so **the constant and the
> document footers move together or not at all.**

---

## The placeholders are resolved

**All 62 `[PLACEHOLDER: …]` markers are gone** as of 11 September 2026, answered from
`Neo_Accounting_Legal_Information_Checklist` — the owner's answers to the 37 questions the
drafts could not settle for themselves. The build-time renderer counts placeholders in the
*published* body; that count is now zero, so the four pages no longer render behind the
draft banner. (The three remaining hits for `PLACEHOLDER` are the drafting-aid banners
themselves, which the renderer strips before the page is built.)

What the checklist settled, one line each:

- The company is **not registered for UK VAT**, and the tax-ID field is deleted rather than
  guessed. `9286810564` belonged to EXAM BINARY LTD and is now nowhere in the pack.
- **ICO registration is pending.** The notice says so instead of claiming a number.
- Support is **09:00–17:00 UK, Monday to Friday**, closed at weekends — with critical
  incidents picked up at weekends anyway.
- First-response targets are **severity-based**: critical immediately, major within 8 hours,
  normal within 2 business days.
- **No DPO**, and no single named privacy owner. `hello@neovogent.com` marked "Privacy"
  reaches whoever takes it on.
- Complaints run **support → technical → management**, acknowledged in 1 business day and
  normally resolved in 3–5. **No ADR or ombudsman scheme** is designated.
- **Reselling and white-labelling are not permitted**; partnership enquiries go to
  `hello@neovogent.com` and need their own written agreement.
- **No fair-use or upload limit** today, with published notice before one is introduced.
- The liability cap is **18 months** of fees paid.
- **Marketing email may be sent**, on consent or the PECR soft opt-in, always identifiable
  and always with an unsubscribe. Testimonials need explicit permission.
- A **mobile number is required** at sign-up — for one-time passcodes and for SMS chases —
  and the notice explains why rather than burying it in a table.
- Data-subject requests that reach us are forwarded to the practice **within 3 working days**.
- The **legitimate interests assessment** is summarised in the notice (purpose, necessity,
  balance).
- The **business-sale** clause is written out: no sale of data to advertisers, transfer only
  where needed to keep the service running.
- Breach notification to a practice is **48 hours**, and does not pause for a weekend.
- **90 days** after cancellation for both export and deletion, then deletion.
- Account and profile deleted **90 days** after closure; support email kept **12 months**;
  routine logs **7 days**; a trashed document **30 days** (already the product's own rule).
- Sub-processor changes get **3 business days'** notice by email.
- The support mailbox is a managed **Google Workspace** account, not consumer Gmail — which
  closes the Annex B gap that used to block publication.
- Supplier transfers rely on each supplier's own **IDTA or UK Addendum**, and the four
  privacy policies are linked.
- Disaster-recovery backups **stay in `eu-west-2`**, so no international transfer mechanism
  is needed for them.
- **AWS Bedrock** commitments on training and retention are cited, with links.
- **No analytics and no third-party trackers**, so **no cookie banner** — and the one cookie
  (`nt_session`) plus the four browser-storage items are listed by name, taken from the code
  rather than from memory.

---

## What is still open

None of these blocks publication — the documents are live. They are the things a careful
reader would ask about next.

### 1. The ICO registration number

**This is the only blank left in the four documents.** Registration is in progress and they
say so, which is honest but not finished. The
data-protection fee is a legal requirement for a company processing personal data, and
`docs/Kickoff_Requirements.md` §1.2 marks it blocking **before any real customer data**. The
number goes into the privacy notice's identity table when it arrives.

### 2. The backup retention cycle, in days

Checklist item 25 deferred the figure to the technical team. The documents describe a
rolling overwrite cycle without naming a length — defensible, but a processor contract that
commits to removing deleted data from backups (processing terms, clause 15.5) reads better
with the number in it. Take it from the RDS and S3 retention settings.

### 3. ⚠ The product quotes "+ VAT" and the company is not VAT registered

The company is **not registered for UK VAT** (checklist item 2), so no VAT can lawfully be
charged. But the price is presented as **"£8.50 + VAT per month"** in the app and on the
landing page, and the Stripe price is configured tax-exclusive with a VAT rate
(`apps/api/src/config/env.ts`, `STRIPE_TAX`). The legal documents now state the position
plainly — Terms clause 9.2 says no VAT is added today — but the **product copy still says
"+ VAT"**, promising a VAT line the invoice will never show.

Two ways out, and it is a commercial decision, not an engineering one:

- **Register for VAT**, put the number into all four documents and Stripe's tax-ID field,
  and leave the copy alone; or
- **Drop "+ VAT" from the product copy** (`LandingView`, `BusinessOnboardingView`,
  `BusinessSettingsView`, `LapsedSubscriptionNotice`, `LivePortalSettings`) and set
  `STRIPE_TAX=none`, restoring both when registration happens.

Either is fine. Charging with the mismatch in place is not.

### 4. ⚠ The 90-day deletion is a promise nothing enforces

All four documents now commit to deleting a practice's data **90 days after cancellation**.
The product does not do this. `docs/Retention_and_Deletion_Policy.md` §3 records the owner's
ruling — *erasure on request, no automatic date* — and says in as many words that **no code
may read `erasure_requested_at` and act on it on a schedule**. The only automated sweep that
exists is `scripts/purge-expired-trash.ts`, which purges the 30-day document Trash, not a
lapsed workspace.

So the 90-day commitment is currently kept, if at all, by somebody remembering. Either build
the surface, or run it as a documented operator task with a diary entry — but do not leave a
contractual deletion deadline with nothing behind it.

Note also that purging destroys database rows and **does not reclaim the stored objects**
(same policy, §5). A deletion promise that leaves the document images in the object store is
not a deletion promise.

### 5. `hello@` must actually receive

All four documents, the landing page and the welcome-email template now point readers at
**`hello@neovogent.com`** — the address the checklist gives, replacing the older
`support@neovogent.com`. Send one test message and confirm it lands in the Workspace mailbox.
A legal document naming a bouncing address is worse than one naming none.

The app's outbound `Reply-To` is now `hello@` too — `EMAIL_REPLY_TO_ADDRESS` in
`apps/api/src/config/env.ts`, `.env`, `.env.example` and `infra/envs/staging/services.tf`
(owner's decision, 11 Sep 2026). **That makes the test above load-bearing:** every email the
product sends now invites a reply to `hello@`, so if that mailbox does not receive, customer
replies disappear. Staging carries the new value only after the next apply.

### 6. Things the documents assert that nobody has verified

None of these was in the checklist. Each is stated as fact in a document a customer will
rely on, so confirm rather than assume:

- **Processing terms 8.2** — every employee and contractor is under a signed confidentiality
  obligation. Name the instrument.
- **Processing terms 8.3** — people are briefed on their obligations before they get access.
  If that briefing does not happen, delete the clause rather than leave it standing.
- **Annex B row 1** — the AWS Data Processing Addendum is accepted on the account hosting
  the service.
- **Annex B row 3** — which Stripe entity contracts with us, and where it processes.
- **Annex B rows 4 and 5** — Cloudflare's DPA and the Google Workspace Data Processing
  Amendment are accepted.

### 7. Access from outside the UK — decided: it does not happen

**Policy, set 26 Aug 2026: personal data in Neo Accounting is not accessed from outside the
United Kingdom.** The team works from Bangladesh; client documents stay in `eu-west-2` and
are not opened, exported or supported from outside the UK. The privacy notice and the
processing terms both state it, which makes it a contractual commitment to every practice
that signs.

That removes the restricted-transfer problem — but only for as long as it is true, and a
policy that lives only in someone's head is not a control. **Enforce it where it is
enforceable:** access to production data is an AWS IAM question, not an honour question. A
condition on the app role, or IP-restricted console access, is what turns the policy into
something you could evidence if a client asked.

If the policy ever has to bend — a production incident nobody in the UK can reach — that is
the moment it needs an International Data Transfer Agreement and a transfer risk assessment,
not the moment after.

### 8. The contracting entity is NEOVOGENT AI SOLUTIONS UK LTD

Decided 3 Sep 2026, superseding the 26 Aug 2026 decision that named EXAM BINARY LTD. The
contracting entity and merchant of record in all four documents is
**NEOVOGENT AI SOLUTIONS UK LTD** — company **15946429**, incorporated 10 September 2024,
registered office **Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham
B15 1NP**. Verified at Companies House, 3 Sep 2026.

**Why this reversed the August decision.** That decision rested on a single stated fact —
that Exam Binary held the live Stripe account `acct_1RQtbxGMdHp4NCWv`, so the entity taking
the money had to be the entity named in the contract. The fact does not survive contact with
`docs/runbooks/stripe-billing.md` §0, which describes the **same account id** as a *personal*
account (`mubasshirkhan231@gmail.com`) holding products from an unrelated project, whose
objects live in **sandbox**, and says plainly: *"It is not where launch goes."* Company
verification has never been completed for either company, so **no entity holds a verified
live Stripe account** and the premise for preferring Exam Binary was void.

Two further facts point the same way:

- **SIC codes.** Neovogent AI Solutions is registered for 58290 other software publishing,
  62012 business and domestic software development, 62020 IT consultancy and 62090 other IT
  services. Exam Binary is **85600, educational support services** — and Stripe underwriting
  reads the company record. An education company selling bookkeeping software is the kind of
  mismatch that triggers a review.
- **Everything else already said Neovogent.** SoT D5 records the company as Neovogent, and
  the product is served from `neoacc.neovogent.com`.

**The sequencing rule binds, and it is now only written here.** The entity that takes the
money must be the entity in the contract. So **Stripe live mode must be opened under company
15946429, and no payment may be taken until it is** — otherwise the customer's card statement
names a company they have never heard of, and the first thing that happens is a chargeback.
Until 11 Sep 2026 this warning sat in a banner at the top of all four documents; the banner
went when the pack was approved for publication, so this paragraph is the surviving copy.

The **tax ID and VAT number that used to block this section are gone.** The company is not
VAT registered (see item 4 above), and the tax-ID field has been deleted from all four
documents rather than filled with a number belonging to a different company.

### 9. Who contracts with whom

The Terms now settle it: **clause 9.9 makes the client business the payer**, matching SoT
D48. The refund policy said the opposite until 11 Sep 2026 and has been corrected to match.

One consequence is worth watching: **removing a client business in the app does not cancel
its subscription.** `offboard-business.ts` writes no money column, deliberately. The Terms
(11.3) and the refund policy (2.3) now say so, and point the customer at the Stripe billing
portal. If that is not the intended behaviour, the fix is in the product, not the wording.

---

## Where they are rendered

`docs/launch/MUBASSHIR.md` stage **M4** renders these as pages under `/legal/*`, linked
from the landing-page footer and — for the privacy notice — from the portal sign-in and
upload screens, because Art. 13 requires it where data is collected.

The markdown here stays the source of truth. Render it; do not retype it, or a correction
has to be made twice.
