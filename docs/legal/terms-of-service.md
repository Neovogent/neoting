> ### ⚠ CONTRACTING ENTITY IS TEMPORARY — READ BEFORE PUBLISHING
>
> For the **first customer only**, the contracting entity and merchant of record is
> **Exambinary Holding Ltd**, because that is the company holding the live Stripe account
> (`acct_1RQtbxGMdHp4NCWv`). Decision taken 26 Aug 2026.
>
> This matters and is not cosmetic:
> - The customer's **card statement** will read Exambinary. If the contract named a
>   different company, an accountant who does not recognise the name raises a chargeback.
> - The **VAT invoice comes from Exambinary's VAT registration**, because HMRC requires the
>   invoice to come from the entity that made the supply. Neovogent's VAT number is not the
>   one that belongs on it.
>
> So every reference below names Exambinary. **When Stripe moves to
> NEOVOGENT AI SOLUTIONS UK LTD** (company no. 15946429, registered office Suite 5,
> The Cloisters, 11–12 George Road, Edgbaston, Birmingham B15 1NP), these documents change
> back in the same commit as the Stripe migration — not before, and not after.

> ### ⚠ NOT PART OF THE PUBLISHED DOCUMENT — REMOVE THIS BLOCK BEFORE PUBLICATION
>
> This is a **drafting aid**, not legal advice. It was prepared from the product's own
> documented behaviour and from the facts supplied by Exambinary. It has **not** been
> reviewed by a qualified lawyer. It **must be reviewed and approved by a qualified UK
> solicitor before it is published, linked from the website, or presented to any
> customer**. Every `[PLACEHOLDER: ...]` must be resolved or deleted first — a published
> document containing a placeholder is worse than no document at all.

---

<!--
  DRAFTING NOTE — which legal requirement each clause is there to satisfy.
  (HTML comment: not rendered on the published page. Keep it for the reviewing solicitor.)

  Companies (Trading Disclosures) Regulations 2015 — business identity:
    Clause 1 (parties) and Clause 24 (company identity and contact details) carry the
    registered company name, company number, place of registration, registered office
    address and VAT number. The same details must also appear on the website and on
    every invoice.

  Electronic Commerce (EC Directive) Regulations 2002, reg. 6 and 9 — information to be
  given by a service provider contracting online:
    Clause 24 (identity, geographic address, email address, VAT number);
    Clause 3 (description of the service); Clause 9 (price, exclusive of VAT, and the
    fact that VAT is added); Clause 10 (how the contract is concluded and that these
    terms are available to store and reproduce).

  Provision of Services Regulations 2009 — Clause 24 (identity, contact point, VAT
  number, complaints route).

  UK GDPR:
    Art. 28(3) processor terms are NOT in this document. They live in the Data
    Processing Agreement referenced at Clause 15. This document must not contradict it;
    Clause 15 states the controller/processor split only, and defers to the DPA.
    Art. 13 transparency for individuals lives in the Privacy Notice, also referenced
    at Clause 15.

  Unfair Contract Terms Act 1977, s.2 and s.3 — the liability cap at Clause 20 is
  business-to-business and is subject to the reasonableness test. Clause 20.1 preserves
  the liabilities that cannot lawfully be excluded. The solicitor should sense-check
  that a cap set at fees paid is defensible for the risk this product carries; it is a
  low cap against books that feed a VAT return.

  Contracts (Rights of Third Parties) Act 1999 — excluded at Clause 22.6.

  Consumer legislation is deliberately not addressed: Clause 1.4 restricts the service
  to business customers. If the product is ever sold to a sole trader acting outside a
  business, consumer cancellation rights apply and this document does not cover them.
-->

# Neo Accounting — Terms of Service

**For accounting practices using Neo Accounting.**

---

## In plain English, before the formal wording

This document is the contract between your accounting practice and Exambinary for the use
of Neo Accounting. Neo Accounting collects your clients' business documents — receipts,
supplier invoices, bank statements — reads them, suggests how each one should be coded,
and produces an import file for VT Transaction+. **It reads documents using AI, and AI
can be wrong. Nothing it suggests goes anywhere until a person at your practice approves
it, and once you approve it, the figures are yours.** Neo Accounting does not post to a
ledger, does not connect to a bank, does not file anything with HMRC, and does not give
accounting advice. It costs GBP 8.50 per month plus VAT for each client business, billed
by card through Stripe. It is monthly and rolling — you can cancel at any time, export
everything, and delete it. Our liability to you is limited, and the limit is set out in
Clause 20. If anything below is unclear, email support@neovogent.com and ask before you
sign up.

---

## Contents

1. [Who this agreement is between](#1-who-this-agreement-is-between)
2. [The words we use](#2-the-words-we-use)
3. [What Neo Accounting does](#3-what-neo-accounting-does)
4. [What Neo Accounting is not](#4-what-neo-accounting-is-not)
5. [**AI, suggestions, and the human approval step**](#5-ai-suggestions-and-the-human-approval-step)
6. [Your responsibility for the books](#6-your-responsibility-for-the-books)
7. [Your account and your users](#7-your-account-and-your-users)
8. [Your clients' documents, and your authority to upload them](#8-your-clients-documents-and-your-authority-to-upload-them)
9. [Price, VAT and payment](#9-price-vat-and-payment)
10. [Term: monthly and rolling](#10-term-monthly-and-rolling)
11. [Cancelling, and what happens to your data](#11-cancelling-and-what-happens-to-your-data)
12. [Acceptable use](#12-acceptable-use)
13. [Availability, maintenance and support](#13-availability-maintenance-and-support)
14. [Security](#14-security)
15. [Data protection: who is responsible for what](#15-data-protection-who-is-responsible-for-what)
16. [Confidentiality](#16-confidentiality)
17. [Intellectual property](#17-intellectual-property)
18. [Changes to the service and to these terms](#18-changes-to-the-service-and-to-these-terms)
19. [Suspension, and termination by us](#19-suspension-and-termination-by-us)
20. [Limitation of liability](#20-limitation-of-liability)
21. [Complaints](#21-complaints)
22. [General](#22-general)
23. [Governing law and jurisdiction](#23-governing-law-and-jurisdiction)
24. [Who we are, and how to contact us](#24-who-we-are-and-how-to-contact-us)

---

## 1. Who this agreement is between

1.1 This agreement is between:

- **Exambinary Holding Ltd** [PLACEHOLDER: confirm the exact registered name at Companies House], a company registered in England and Wales, company number [PLACEHOLDER: Exambinary company number], registered office [PLACEHOLDER: Exambinary registered office], VAT registration number [PLACEHOLDER: Exambinary VAT number], a company registered in
  England and Wales, company number
  [PLACEHOLDER: Exambinary company number], tax ID **9286810564**, VAT registration number [PLACEHOLDER: UK VAT registration number. 9286810564 is the company TAX ID, not the VAT number — the VAT registration number is a separate nine-digit reference and must be obtained before any invoice is issued], whose
  registered office is in Birmingham at [PLACEHOLDER: Exambinary registered office]
  ("**Exambinary**", "**we**", "**us**", "**our**"); and
- the accounting practice named on the account ("**you**", "**your**", "**the
  practice**").

1.2 These terms apply from the moment you create an account, and they replace anything
said in a demonstration, an email or a sales conversation.

1.3 The person who creates the account confirms that they are authorised to enter into
this agreement on behalf of the practice.

1.4 Neo Accounting is supplied to businesses only. It is not offered to consumers, and
consumer cancellation rights do not apply.

---

## 2. The words we use

| Term | What it means |
|---|---|
| **Neo Accounting** | Our software service at `https://neoacc.neovogent.com`, including the application at `/app`. |
| **Client business** | One business belonging to one of your clients, set up as a separate workspace in Neo Accounting. Our price is charged per client business. |
| **Document** | A receipt, supplier invoice, bank statement or similar business document that you or your client uploads. |
| **Suggestion** | Anything Neo Accounting proposes — extracted figures, dates, supplier names, a nominal code, a VAT treatment, a match. A suggestion is a proposal, never a decision. |
| **Approval** | The step where a person at your practice reviews a suggestion and accepts it. |
| **Export file** | The import file Neo Accounting produces for VT Transaction+. |

---

## 3. What Neo Accounting does

3.1 Neo Accounting lets you collect your clients' business documents, reads them, and
suggests how each one should be recorded.

3.2 In outline it:

- (a) receives documents that you or your clients upload;
- (b) reads them using AI and extracts the figures, dates and supplier details it finds;
- (c) suggests a coding for each document;
- (d) puts every suggestion in front of a person at your practice for approval; and
- (e) produces an export file that you can import into VT Transaction+.

3.3 We provide the software. Your practice provides the professional judgement.

---

## 4. What Neo Accounting is not

This clause matters as much as Clause 3. Please read it.

4.1 **It is not a ledger.** Neo Accounting does not post entries to any accounting
ledger. It produces a file. You import that file yourself, into your own copy of VT
Transaction+, and you check the result.

4.2 **It is not connected to any bank.** We do not have and do not ask for a connection
to your clients' bank accounts. We read bank statements only as documents that someone
uploads.

4.3 **It does not file anything with HMRC.** Neo Accounting submits nothing — no VAT
return, no Making Tax Digital submission, no accounts, nothing. Any filing is made by
your practice, through your own software, on your own responsibility.

4.4 **It is not accounting, tax or legal advice.** Nothing in the product, in its
suggestions, in its help text or in a support reply is advice. We are a software
supplier, not your accountant and not your adviser.

4.5 **It is not a substitute for your professional obligations.** Your duties to your
clients, to your professional body, and under anti-money-laundering and tax law are
unaffected by using Neo Accounting.

4.6 VT Transaction+ is third-party software that we do not supply, control, host or
support. [PLACEHOLDER: confirm whether any partnership, reseller or endorsement
relationship with the publisher of VT Transaction+ exists before publication; if none,
state plainly that we are independent of them.]

---

## 5. AI, suggestions, and the human approval step

**This is the most important clause in this agreement. Do not skip it.**

5.1 **Neo Accounting uses AI to read documents.** Document images and their text are
processed by an AI model (Amazon Bedrock, running in the UK — see Clause 15.4). The
model reads what it can see and proposes values and a coding.

5.2 **The AI can be wrong, and sometimes will be.** It can misread a number, a date or a
supplier name. It can read a poor photograph badly. It can miss a page. It can propose
the wrong nominal code or the wrong VAT treatment. It can be confidently wrong — a
suggestion that looks tidy and reads well can still be incorrect. We do not warrant that
any suggestion is accurate, complete or suitable for the client's books.

5.3 **Nothing changes on its own.** No AI suggestion enters an export file, and no
suggestion changes the state of anything, until a person at your practice has opened the
review, looked at the document, and approved it. That approval step is built into the
product and enforced by our systems; it is not an optional setting and it cannot be
switched off.

5.4 **Approving is a professional judgement, and it is yours.** When one of your people
approves a suggestion, they are stating that they have checked it against the source
document and are satisfied it is right. We rely on that. You should treat every
suggestion as a first draft prepared by an assistant who has not seen the client, the
contract, or last year's file.

5.5 **You remain responsible for the books.** Neo Accounting does not review your work,
does not sign anything off, and does not reduce anyone's responsibility for the accuracy
of the records. The records, the VAT figures and anything filed using data that came out
of an export file remain your practice's responsibility and your client's.

5.6 **Do not use Neo Accounting as the only check on a document.** It is a tool that
speeds up reading and coding. It is not a control, and it is not an audit.

5.7 We keep a record of what was suggested, what was approved, and by whom, so that you
can see how a figure reached the export file.

---

## 6. Your responsibility for the books

6.1 You are responsible for what you approve, for what you export, and for what you do
with the export file after it leaves Neo Accounting.

6.2 You are responsible for checking the export file after you import it into VT
Transaction+, before you rely on the result.

6.3 You are responsible for the accuracy and completeness of the documents you and your
clients upload. We can only read what we are given. A document that is never uploaded is
never in the books.

6.4 You are responsible for keeping your own records to the standard your professional
body and the law require. Neo Accounting is not your statutory record.

---

## 7. Your account and your users

7.1 You may give access to your own staff. Each person must have their own login. Logins
must not be shared.

7.2 You are responsible for everything done under your account, including anything done
by your staff and by any of your clients you invite in.

7.3 **Multi-factor authentication is required for the roles that can release documents.**
You must keep it switched on for those users. If you turn it off or work around it, you
do so at your own risk and we are not responsible for what follows.

7.4 Tell us straight away at support@neovogent.com if you think an account has been
compromised.

7.5 You must keep the contact details on your account up to date. Notices we send to the
account's registered email address are treated as delivered.

---

## 8. Your clients' documents, and your authority to upload them

8.1 You confirm that you have the authority of each client, and any necessary
instruction from them, to upload their business documents to Neo Accounting and to have
them processed as described in these terms.

8.2 You confirm that you have told your clients, in whatever way your own engagement
terms and privacy notice require, that a third-party software provider processes their
documents on your instructions.

8.3 You must not upload documents or data that you have no right to process.

---

## 9. Price, VAT and payment

9.1 The price is **GBP 8.50 per month, plus VAT, for each client business** on your
account.

9.2 All prices are stated **excluding VAT**. VAT is added at the prevailing UK rate and
shown separately on the invoice.

9.3 Payment is by card, taken by **Stripe**, our payment processor. Checkout is hosted by
Stripe. **Card details never reach Exambinary's systems and we do not store them.** Your
use of Stripe's checkout is also subject to Stripe's own terms.

9.4 Billing is monthly in advance. [PLACEHOLDER: confirm the billing cycle mechanics —
which day the charge is taken, whether the first month and part-months are pro-rated, and
what happens to the charge when a client business is added or removed mid-month.]

9.5 [PLACEHOLDER: confirm whether a free trial is offered, how long it lasts, whether a
card is required to start it, and what happens at the end of it.]

9.6 **If a payment fails:** [PLACEHOLDER: confirm the retry and grace-period process,
how we notify you, and at what point access is suspended. Whatever is decided, it must
not cut off self-serve export — see Clause 11.4.]

9.7 **Refunds:** [PLACEHOLDER: confirm the refund position. State plainly whether a
part-month is refunded on cancellation, or whether the month already paid for simply runs
to its end.]

9.8 We may change the price. We will tell you at least [PLACEHOLDER: confirm notice
period, e.g. 30 days] before a change takes effect, by email to the account's registered
address. If you do not want to pay the new price, cancel before it takes effect under
Clause 11.

9.9 [PLACEHOLDER: confirm who the payer is — these terms assume the practice holds the
account and pays for every client business on it. If a client business may pay directly,
that arrangement needs its own wording here.]

---

## 10. Term: monthly and rolling

10.1 The agreement starts when you create your account and runs **month to month**.

10.2 It renews automatically each month until you cancel.

10.3 **There is no minimum term, no lock-in and no notice period beyond the current
month.**

---

## 11. Cancelling, and what happens to your data

11.1 You can cancel at any time, in the product, yourself. You do not need to raise a
support ticket, call anyone, or ask permission.

11.2 Cancelling stops the next payment. [PLACEHOLDER: confirm whether access continues to
the end of the paid month — see Clause 9.7.]

11.3 You can cancel a single client business without cancelling the whole account. The
charge for that client business stops at the next billing date.

11.4 **Export and erasure are self-serve.** At any time — during a trial, at the end of a
trial, and on or after cancellation — you can export your documents and data from within
the product, and you can delete them from within the product. Neither is gated on a
support ticket, and neither is withheld over a billing dispute.

11.5 **After cancellation** we keep your data for [PLACEHOLDER: confirm the
post-cancellation retention window and whether export and deletion remain available
throughout it], so that you can still export it. After that window we delete it. Once it
is deleted we cannot get it back.

11.6 Deletion does not extend to data we are required to keep by law — for example
billing records we must retain for tax purposes. That data is kept for as long as the law
requires and no longer.

11.7 Exporting from Neo Accounting is your responsibility to do in time. We will not
delete an account without notice, but we will not carry it indefinitely either.

---

## 12. Acceptable use

12.1 You must use Neo Accounting only for the bookkeeping purpose it is built for, and
only in accordance with the law.

12.2 You must not:

- (a) upload anything unlawful, or anything you do not have the right to process;
- (b) upload malware, or anything designed to interfere with the service;
- (c) try to break out of your own workspace, reach another practice's data, or test our
  security without our written permission;
- (d) reverse engineer, decompile, or copy the software, except where the law says you
  may;
- (e) resell, white-label or provide Neo Accounting to anyone outside your practice and
  your own clients [PLACEHOLDER: confirm whether any reseller or white-label arrangement
  is permitted, and on what terms];
- (f) use the service, or anything it produces, to build or train a competing product;
- (g) put an unreasonable load on the service — for example by automated bulk uploading
  outside normal working use [PLACEHOLDER: confirm whether any fair-use volume limit
  applies per client business, and state the number if so]; or
- (h) share logins, or give access to anyone who is not one of your staff or an
  authorised person at a client business.

12.3 If you break this clause we may suspend the account under Clause 19.

---

## 13. Availability, maintenance and support

13.1 We work to keep Neo Accounting available and we monitor it. **We do not currently
offer a guaranteed level of availability.** There is no uptime commitment, no service
credit and no service level agreement at this stage of the product. If that changes, we
will publish it and tell you.

13.2 The service may be unavailable for maintenance, for an upgrade, or because
something has gone wrong. We will keep planned interruptions short and, where we can,
outside UK working hours.

13.3 Parts of the service depend on suppliers we do not control (Clause 15.4). If one of
them has an outage, so do we.

13.4 **Support** is by email at **support@neovogent.com**. We respond within **24
hours**. Our support hours are **06:00–18:00 UK time** (our team works 11:00–23:00 local
time in Bangladesh).

13.5 Support covers using Neo Accounting. It does not cover your accounting questions,
your clients' affairs, VT Transaction+, or your own IT.

13.6 [PLACEHOLDER: confirm whether severity levels and different response targets apply,
or whether the single 24-hour target above is the whole commitment.]

---

## 14. Security

14.1 We take security seriously and we describe what we actually do, not what sounds
good:

- (a) data is encrypted in transit and at rest;
- (b) each tenant's data is isolated at the database row level, so one practice's records
  are not reachable from another's;
- (c) no state changes without a human approval step (Clause 5.3); and
- (d) multi-factor authentication is required for the roles that can release documents.

14.2 **We do not hold any security certification.** We are not ISO 27001 certified, we
do not hold a SOC 2 report, and we do not claim "bank-level security". If we obtain a
certification we will say so and you will be able to check it.

14.3 No system is perfectly secure. We will tell you without undue delay if we become
aware of a security breach affecting your data, and we will give you what you need to
meet your own reporting duties.

---

## 15. Data protection: who is responsible for what

15.1 **You are the data controller. We are the data processor.** Your practice decides
what personal data goes into Neo Accounting and why. We process it only on your
instructions, to provide the service described in these terms.

15.2 The personal data involved is what appears in ordinary business documents — sole
trader names and addresses, incidental personal detail visible in a document image — and
the contact details (name, email, mobile) of the people at your client businesses.

15.3 Our processing obligations, including everything UK GDPR Article 28(3) requires, are
set out in our **Data Processing Agreement** at [PLACEHOLDER: URL of the DPA]. It forms
part of this agreement. How we handle personal data more generally is described in our
**Privacy Notice** at [PLACEHOLDER: URL of the Privacy Notice].

15.4 **Sub-processors.** We use these, and only these:

| Sub-processor | What they do | Where |
|---|---|---|
| Amazon Web Services (AWS) | Hosting, storage and database | UK — eu-west-2 (London) |
| Amazon Bedrock (AWS) | The AI model that reads document images | UK — eu-west-2 (London), region-pinned; no cross-region inference is permitted |
| Stripe | Payment processing (hosted checkout; card details never reach our systems) | See the DPA |
| Cloudflare | Email routing for our support address | See the DPA |
| Google (Gmail) | The mailbox our support address forwards to | See the DPA |

15.5 **Data location.** Your clients' documents and data are stored and processed in the
UK (AWS eu-west-2, London). [PLACEHOLDER: confirm and state the one named exception —
the cross-region disaster-recovery backup target — and where it is, so that this clause
is accurate rather than absolute.]

15.6 We will give you reasonable notice before we add or change a sub-processor, so that
you can object.

15.7 Support email sent to us may be read in Google's Gmail. If you need to send us
something sensitive about a client, put it in the product rather than in an email.

---

## 16. Confidentiality

16.1 Each of us will keep the other's confidential information confidential, and use it
only for this agreement.

16.2 Your clients' documents and data are your confidential information. We do not look
at them except where it is necessary to run or fix the service, to deal with a support
request you have raised, or where the law requires it.

16.3 **We do not use your clients' documents or data to train AI models**, and we do not
sell or share them.

16.4 This clause continues after the agreement ends.

---

## 17. Intellectual property

17.1 We own Neo Accounting — the software, the interface and everything in it. You get a
licence to use it while you pay for it, and nothing more.

17.2 You (or your clients) own the documents and data you put in, and you own the export
files that come out. We claim nothing in them.

17.3 If you send us feedback or a feature suggestion, we may use it without owing you
anything for it.

---

## 18. Changes to the service and to these terms

18.1 We are actively developing Neo Accounting and it will change. We will not remove a
feature you rely on without telling you first.

18.2 We may change these terms. If a change materially affects you, we will email the
account's registered address at least [PLACEHOLDER: confirm notice period, e.g. 30 days]
before it takes effect. If you do not accept it, cancel under Clause 11 before it takes
effect; continuing to use the service after that date means you accept it.

18.3 The version and date at the foot of this document tell you which version you are
reading.

---

## 19. Suspension, and termination by us

19.1 We may suspend your access, without notice if we have to, if:

- (a) you break Clause 12 (acceptable use);
- (b) there is a security problem that makes suspension the safest thing to do; or
- (c) payment has failed and the process in Clause 9.6 has run its course.

19.2 We will tell you why, and restore access as soon as the reason has gone.

19.3 Either of us may end this agreement immediately if the other commits a serious
breach and does not put it right within [PLACEHOLDER: confirm cure period, e.g. 14 days]
of being asked to in writing, or becomes insolvent.

19.4 **Suspension does not remove your right to export.** Except where the law or a
security incident prevents it, we will give you a way to export your data before it is
deleted.

---

## 20. Limitation of liability

20.1 **Nothing in this agreement limits or excludes liability for:** death or personal
injury caused by negligence; fraud or fraudulent misrepresentation; or anything else that
cannot lawfully be limited or excluded.

20.2 Subject to Clause 20.1, **our total liability to you, for everything arising out of
or in connection with this agreement, is limited to the total fees you have paid us in
the [PLACEHOLDER: confirm the period — e.g. the 12 months immediately before the event
giving rise to the claim].**

20.3 Subject to Clause 20.1, we are not liable for: loss of profit, loss of business,
loss of anticipated savings, loss of goodwill, or any indirect or consequential loss.

20.4 Subject to Clause 20.1, **we are not liable for a suggestion that your practice
approved.** Clause 5 explains why: the AI proposes, a person at your practice checks and
approves, and the approved figure is the practice's. This includes penalties, interest,
professional-body findings or client claims arising from figures that were approved and
exported.

20.5 We are not liable for anything caused by: VT Transaction+ or how an export file
behaves once imported; documents that were never uploaded or were uploaded incorrectly;
your own systems; or an act or omission of yours or your clients'.

20.6 You should keep your own professional indemnity insurance. This agreement is not a
substitute for it.

20.7 This clause survives the end of the agreement.

---

## 21. Complaints

21.1 If something has gone wrong, email **support@neovogent.com** with "Complaint" in the
subject line. We will acknowledge it within 24 hours during our support hours and tell
you who is dealing with it.

21.2 [PLACEHOLDER: confirm the escalation route and target resolution time, and whether
any alternative dispute resolution or ombudsman scheme applies.]

---

## 22. General

22.1 **Notices.** Notices to you go to the account's registered email address. Notices to
us go to support@neovogent.com, and for anything legal also to our registered office
address in Clause 24.

22.2 **Assignment.** You may not transfer this agreement without our written consent
(which we will not unreasonably withhold). We may transfer it to a company that acquires
our business, and we will tell you if we do.

22.3 **Events outside our control.** Neither of us is liable for a failure caused by
something genuinely outside our reasonable control, for as long as it lasts.

22.4 **Waiver.** If we do not enforce something straight away, we have not given up the
right to enforce it later.

22.5 **Severability.** If a clause turns out to be unenforceable, the rest of the
agreement carries on without it.

22.6 **Third parties.** Nobody other than you and us has any right to enforce this
agreement under the Contracts (Rights of Third Parties) Act 1999. Your clients are not
parties to it.

22.7 **Whole agreement.** These terms, together with the Data Processing Agreement and
the Privacy Notice, are the whole agreement between us about Neo Accounting.

22.8 These terms are provided in English, and English is the language of the contract.
You can save and print this page at any time.

---

## 23. Governing law and jurisdiction

23.1 This agreement, and any dispute arising out of it, is governed by the law of
**England and Wales**.

23.2 The courts of **England and Wales** have exclusive jurisdiction.

---

## 24. Who we are, and how to contact us

**Exambinary Holding Ltd** [PLACEHOLDER: confirm the exact registered name at Companies House], a company registered in England and Wales, company number [PLACEHOLDER: Exambinary company number], registered office [PLACEHOLDER: Exambinary registered office], VAT registration number [PLACEHOLDER: Exambinary VAT number]
Registered in England and Wales, company number
**[PLACEHOLDER: Exambinary company number]**
Registered office: [PLACEHOLDER: Exambinary registered office], Birmingham,
[PLACEHOLDER: postcode]
Tax ID: **9286810564**
VAT registration number: [PLACEHOLDER: UK VAT registration number. 9286810564 is the company TAX ID, not the VAT number — the VAT registration number is a separate nine-digit reference and must be obtained before any invoice is issued]

**Support and general enquiries:** support@neovogent.com
**Response time:** within 24 hours, 06:00–18:00 UK time
**Service address:** https://neoacc.neovogent.com

---

**Version 0.1 — DRAFT, not for publication until legally reviewed.**
**Last updated: 26 August 2026.**
