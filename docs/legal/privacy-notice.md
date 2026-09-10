> ### ⚠ CONTRACTING ENTITY — STRIPE MUST MATCH BEFORE PUBLISHING
>
> The contracting entity and merchant of record is **NEOVOGENT AI SOLUTIONS UK LTD**
> (company no. 15946429, incorporated 10 September 2024, registered office Suite 5,
> The Cloisters, 11–12 George Road, Edgbaston, Birmingham B15 1NP). Decision taken
> 3 Sep 2026, superseding the 26 Aug 2026 decision that named EXAM BINARY LTD.
>
> This matters and is not cosmetic:
> - The customer's **card statement** must read Neovogent AI Solutions. If it names a
>   different company, an accountant who does not recognise the name raises a chargeback.
> - The **VAT invoice must come from NEOVOGENT AI SOLUTIONS UK LTD's own VAT
>   registration**, because HMRC requires the invoice to come from the entity that made
>   the supply.
>
> **So the Stripe live-mode account must be opened under this same entity.** No live
> charging exists yet — live mode is blocked on company verification and the VAT number
> (`docs/runbooks/stripe-billing.md` §1) — so there is no mismatch today, and this is the
> moment the two are aligned at zero cost. Do not publish these documents, and do not take
> a payment, until Stripe is verified under company 15946429.

> ⚠ **NOT LEGAL ADVICE — DRAFTING AID ONLY.** The document below was drafted from Neovogent AI Solutions’ own documented product behaviour and the facts supplied by the product owner. It has not been reviewed by a lawyer. It must be read and approved by a qualified UK solicitor (data protection) before it is published, linked from the landing page, or shown to any customer. Every `[PLACEHOLDER: ...]` marks something that could not be established from the facts and must be filled in or deleted before publication. This warning block is **outside** the document body and must not be published with it.

---

<!--
ART. 13 COMPLIANCE MAP — for internal review, not for the reader.
This notice is written to cover the UK GDPR Article 13 elements. Where we are a
PROCESSOR (client documents), Article 13 is the practice's duty, not ours; clause 4
tells the reader that and points them at the practice. The mapping below is to the
CONTROLLER parts of this notice.

  Art. 13(1)(a)  identity + contact details of controller ............ cl. 1
  Art. 13(1)(a)  UK representative (Art. 27) ........................ cl. 1.4 (not required — UK entity)
  Art. 13(1)(b)  data protection officer ............................ cl. 1.3
  Art. 13(1)(c)  purposes + lawful basis for each ................... cl. 5 (table)
  Art. 13(1)(d)  legitimate interests we rely on .................... cl. 5.2
  Art. 13(1)(e)  recipients / categories of recipient ............... cl. 6 (sub-processor table)
  Art. 13(1)(f)  transfers outside the UK + safeguard used .......... cl. 7
  Art. 13(2)(a)  retention period or the criteria for it ............ cl. 8
  Art. 13(2)(b)  rights: access, rectification, erasure, restriction,
                 objection, portability ............................. cl. 10
  Art. 13(2)(c)  right to withdraw consent ......................... cl. 10.2
  Art. 13(2)(d)  right to complain to the ICO ...................... cl. 11
  Art. 13(2)(e)  is provision statutory/contractual + consequences .. cl. 5.4
  Art. 13(2)(f)  automated decision-making / profiling .............. cl. 9

  Art. 14 (data we get about a person from someone else — e.g. a practice
  enters a colleague's details) ..................................... cl. 3.3

  Art. 28(3) processor terms are NOT in this notice. They live in the Data
  Processing Agreement, referenced at cl. 4.4.

  Companies (Trading Disclosures) Regulations 2015 identity details are at cl. 1.1;
  the same block must also appear in the website footer and on invoices.
-->

# Neo Accounting — Privacy Notice

**In one paragraph.** This notice explains what Neovogent AI Solutions does with personal data when you use Neo Accounting. It matters that we do two different jobs. When an accounting practice signs up, pays and uses the app, we decide how that practice's own account data is handled — for that data we are the **controller**, and this notice is your notice. When a practice uploads its clients' receipts, invoices and bank statements, we only do what the practice tells us — for that data the **practice is the controller and we are its processor**, and the practice's own privacy notice is the one that applies. Clause 2 sets out which is which. Everything below is written for an accountant to read, not a lawyer.

---

## Contents

1. Who we are, and how to contact us
2. The two roles we play — read this first
3. Part A — data we control: what we collect and where it comes from
4. Part B — data we process for you: your clients' documents
5. Why we use your data, and our lawful basis
6. Who else sees the data (our sub-processors)
7. Where the data is held, and transfers outside the UK
8. How long we keep things
9. AI, automated processing and human approval
10. How we protect the data
11. Your rights, and how to use them
12. Complaining to the ICO
13. Cookies and similar technology
14. Changes to this notice

---

## 1. Who we are, and how to contact us

**1.1 The company.**

| | |
|---|---|
| Trading name | Neovogent AI Solutions |
| Registered name | NEOVOGENT AI SOLUTIONS UK LTD |
| Company number | **15946429** — verified at Companies House, 3 Sep 2026 |
| Registered office | Birmingham, United Kingdom — Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham, West Midlands B15 1NP |
| VAT registration number | Not registered — Neovogent AI Solutions UK Ltd is not currently registered for UK VAT |
| ICO registration number | Registration with the Information Commissioner's Office is in progress. The number will be published here as soon as it is issued |
| Product | Neo Accounting — https://neoacc.neovogent.com (the app is at /app) |

**1.2 How to reach us about privacy.** Email **hello@neovogent.com**. Our support hours are **09:00–17:00 UK time, Monday to Friday**, and standard support is closed at weekends. We acknowledge a privacy enquiry within 2 business days. A critical incident — a suspected breach, or anything else putting data at risk — is picked up immediately, including at weekends. Our team works from Bangladesh; clause 7.3 explains what that means for your data.

**1.3 Data protection officer.** We have not appointed a data protection officer. Given the nature and scale of what we process, we do not believe Article 37 requires one. We keep that assessment under review and will appoint one if our processing changes or grows.

We do not route privacy matters to one named individual. Send privacy questions to **hello@neovogent.com** with "Privacy" in the subject line; the responsible team member takes it on, investigates it, and coordinates it through to a resolution.

**1.4 UK representative.** We are a UK company, so we do not need a UK or EU representative under Article 27.

---

## 2. The two roles we play — read this first

This is the most important part of this notice. Getting it wrong would send people to the wrong company with their questions.

| | **Part A — we are the controller** | **Part B — we are the processor** |
|---|---|---|
| Whose data | The accounting practice and its staff: the people who sign up, sign in, pay and email support | The practice's **clients** — their business documents, and the contact details of their staff |
| Who decides what happens to it | **Neovogent AI Solutions** | **The accounting practice** |
| Whose privacy notice applies | This one | The practice's own privacy notice |
| Who a person asks about their data | Us — hello@neovogent.com | Their accountant. See clause 4.3 |
| What governs it | This notice, and our terms | Our Data Processing Agreement with the practice |

**2.1** In plain terms: **your account is ours to explain; your clients' documents are yours to explain.** We hold your clients' documents because you asked us to, and we do only what you instruct.

**2.2** If you are a client of an accounting practice and you have found this notice, go to clause 4.3.

---

## 3. Part A — data we control: what we collect and where it comes from

**3.1 What we collect.**

| Category | Examples | Where it comes from |
|---|---|---|
| Account and identity | Name, work email address, **mobile number**, the practice name, your role in the practice, password credentials, multi-factor authentication settings | You, when you sign up or edit your profile |
| Billing | Billing contact, billing address, VAT number, subscription records, invoices, the number of client businesses you are billed for | You, and Stripe |
| Card details | **We never see or store these.** Payment card details are entered on a checkout page hosted by Stripe and go straight to Stripe | Not collected by us |
| Support correspondence | The emails you send to hello@neovogent.com and our replies, including anything you attach | You |
| Service and security records | Sign-in times, IP address, browser and device information, actions taken in the app, error and audit logs | Automatically, when you use the app |

**3.1a Why we ask for a mobile number.** A mobile number is required, not optional. We use it to send a one-time passcode when you sign in, and — where you have asked us to — to send reminders and document chases to a client business by SMS. Email on its own is not a reliable way for an accountant to reach a client about a missing receipt, which is why we ask for the number rather than offer it. We use it for authentication and for the service messages you have agreed to; we do not use it for unrelated marketing unless you separately agree. If you give us a client's mobile number, you are confirming to us that you are authorised to do so.

**3.2 What we do not collect.** Neo Accounting does not connect to any bank, does not post to any ledger, and does not file anything with HMRC. It produces an import file for VT Transaction+ that a person downloads and imports. So we never hold bank login credentials, and we never act on your behalf with HMRC.

**3.3 Data you give us about other people.** If you enter a colleague's details so they can use the app, we get their personal data from you, not from them. Please make sure they know. We use it only to give them an account and to run the service, on the same basis as your own account data. If they contact us we will tell them where their data came from.

---

## 4. Part B — data we process for you: your clients' documents

**4.1 What this covers.** Everything the practice — or its clients — uploads into Neo Accounting so that we can read and code it: supplier invoices, receipts, bank statements, and the contact details (name, email address, mobile number) of the client business's staff. These are business records, but they routinely contain personal data — a sole trader's name and address, a person's name on a receipt, incidental personal detail visible in a photograph of a document.

**4.2 Our role.** For all of this, **the practice is the controller and Neovogent AI Solutions is the processor**. We act only on the practice's documented instructions. We do not decide what to collect, we do not use it for our own purposes, and we do not sell it or share it with anyone except the sub-processors listed in clause 6.

**4.3 If you are a client of a practice.** If you want a copy of your data, want something corrected, or want it deleted, please ask **your accountant**. We are not allowed to act on your request directly — we would be acting without our customer's instruction. If you contact us anyway, we will pass your request to the practice and tell you we have done so. We record the request as soon as it reaches us and forward it securely to the responsible practice **without undue delay and in any event within 3 working days**, sooner where it is urgent. We give the practice reasonable technical help with it, and we keep a record of the request and of what was done about it.

**4.4 The processor terms.** The full Article 28(3) terms — instructions, confidentiality, security, sub-processors, assistance with data subject rights, breach notification, deletion or return at the end, and audit — are set out in our **Data Processing Agreement**, which forms part of our contract with the practice. That agreement, not this notice, governs Part B.

**4.5 Special category and criminal offence data.** We do not ask for health, biometric, political, religious or similar sensitive data, and Neo Accounting is not designed to handle it. Documents uploaded by a practice may nevertheless contain some incidentally — a medical receipt, for example. We treat whatever is in a document with the same protections as everything else, but the decision to upload it, and the lawful basis for doing so, belongs to the practice.

---

## 5. Why we use your data, and our lawful basis

This clause covers **Part A only** — the data we control. For Part B the lawful basis is the practice's to determine.

**5.1 Contract** — UK GDPR Article 6(1)(b). We need this data to give you what you have paid for.

| What we do | Why |
|---|---|
| Create and run your account, sign you in, manage multi-factor authentication | You cannot use the product otherwise |
| Take payment — GBP 8.50 per month per client business, monthly and rolling, through Stripe | To bill the subscription |
| Answer your support emails | To provide support |
| Send service messages — billing failures, security notices, changes that affect you | These are part of the service, not marketing |

**5.2 Legitimate interests** — Article 6(1)(f). We rely on this where it is reasonable and does not override your rights. Our interests are stated plainly:

| What we do | The interest |
|---|---|
| Keep sign-in, audit and error logs | Keeping accounts secure, investigating problems, proving who did what |
| Detect and prevent fraud and abuse | Protecting our customers and the service |
| Monitor whether the service is working, and fix it when it is not | Running a reliable product |
| Improve the product using how the app is used | Making the product better for the people who pay for it |

We have carried out a legitimate interests assessment and concluded that these interests do not override your rights:

- **Purpose.** We need limited account, contact, device and usage information to protect accounts, prevent fraud, keep the platform secure, and run the service reliably.
- **Necessity.** We use only what is reasonably required for that, and a less intrusive alternative wherever one exists.
- **Balance.** These are activities someone using a business application reasonably expects. We minimise what we collect, restrict who can reach it, apply the retention limits in clause 8, explain the processing here, and honour objections and opt-outs where they apply.

The full assessment is documented internally and is reviewed before we rely on this basis for anything new. You can object — see clause 11.

**5.3 Legal obligation** — Article 6(1)(c). We must keep invoices and VAT records to meet UK tax law, and we must respond to lawful requests from a regulator or a court.

**5.4 Do you have to give us this data?** Yes, for the account and billing data at clause 3.1. It is a contractual requirement: without it we cannot open an account, sign you in, or invoice you. The service and security records are collected automatically as a consequence of using the app.

**5.5 Marketing.** We send essential service messages about onboarding, account activity, security, changes to the service, and changes to our Terms or this notice. Those are part of the service, not marketing, and you cannot unsubscribe from them while you hold an account.

We may also send marketing or promotional email where the law allows it — relying on your consent, or on the soft opt-in for existing customers in regulation 22 of the Privacy and Electronic Communications Regulations. Every marketing email is clearly identifiable as one and carries an unsubscribe link; unsubscribing applies to marketing only and does not stop your service messages. We use a name, photograph, quotation or customer story in our own marketing only with that person's explicit permission.

---

## 6. Who else sees the data (our sub-processors)

We use a small number of suppliers to run the service. This is the complete list. Each one only gets what it needs.

| Supplier | What it does for us | What it can see | Where |
|---|---|---|---|
| **Amazon Web Services (AWS)** | Hosting, file storage, database | Account data and uploaded documents, encrypted at rest | UK — eu-west-2 (London) |
| **Amazon Bedrock** (an AWS service) | The AI model that reads document images | The contents of documents sent for reading | UK — eu-west-2 (London), region-pinned |
| **Stripe** | Payment processing and hosted checkout | Your card details (which never reach us), your billing details and payment history | See clause 7.2 |
| **Cloudflare** | Email routing for hello@neovogent.com | Emails sent to and from our support address, in transit | See clause 7.2 |
| **Google Workspace** | The managed business mailbox our support address forwards to | Emails sent to and from our support address, at rest | See clause 7.2 |

**6.1 We do not sell personal data**, and we do not share it with anyone for advertising.

**6.2 Other disclosures.** We may disclose data where the law requires it, or to a professional adviser under a duty of confidence. **We do not sell personal data to advertisers or to unrelated third parties.** If we go through a merger, acquisition, restructuring or a sale of the business, information may pass to the acquiring or successor organisation — and only where that is necessary to keep the service running. Any such transfer is subject to confidentiality, security and data protection requirements, the receiving organisation must go on protecting the information, and we will tell you where the law requires us to.

**6.3 Changing this list.** If we add or replace a sub-processor we email affected practices, normally at least **3 business days** before the change takes effect, and update this notice at the same time. A practice that objects can say so — clause 10 of our Data Processing Terms sets out what happens then.

**6.4 Our support mailbox.** Support email is handled in a managed **Google Workspace** business account — not a personal or consumer Gmail account — so it is covered by Google's Workspace data processing terms. Email is still email, though: if you need to send us something sensitive about a client, put it in the product rather than attach it to a message.

---

## 7. Where the data is held, and transfers outside the UK

**7.1 The product stays in the UK.** All documents, all database records and all AI processing happen in AWS's **eu-west-2 (London)** region. The AI model that reads documents is pinned to that region, and our systems are not permitted to use a cross-region inference profile — a request that tried to leave the region would fail rather than succeed quietly.

**7.2 Suppliers based outside the UK.** Stripe, Cloudflare and Google are international companies, and data they handle may be processed outside the UK. Where a supplier does process personal data outside the UK, we rely on the UK transfer safeguard carried in that supplier's own terms and data processing agreement — either the ICO's International Data Transfer Agreement or the UK Addendum to the EU Standard Contractual Clauses. We record which safeguard applies to each supplier, and we review it.

Their own privacy information explains what they do with data: [Stripe](https://stripe.com/gb/privacy), [Amazon Web Services](https://aws.amazon.com/privacy/), [Cloudflare](https://www.cloudflare.com/privacypolicy/) and [Google](https://policies.google.com/privacy).

**7.3 Our team is in Bangladesh, and does not access your data.** Our staff work from Bangladesh. Bangladesh does not have UK adequacy status, so if our team looked at your data it would be a transfer outside the UK — even though the data itself stays on servers in London.

**They do not.** It is our policy that personal data held in Neo Accounting is not accessed from outside the United Kingdom. Client documents are not opened, exported or supported from outside the UK, and our support team answers questions about the service without reading the documents in your account.

If that ever has to change — for example a technical fault that cannot be fixed any other way — we will put an International Data Transfer Agreement and a transfer risk assessment in place first, and we will tell you before it happens.

**7.4 Backups.** Disaster-recovery backups stay in the United Kingdom, in the AWS Europe (London) region (`eu-west-2`). No backup copy is replicated to Bangladesh or to any other country, so no international transfer mechanism is needed for backups. If that ever has to change, we will document the transfer safeguard and update this notice before any data moves.

---

## 8. How long we keep things

**8.1 Your clients' documents (Part B).** We keep them for as long as the practice tells us to. You can **export everything, and delete everything, yourself, from inside the app** — at any time, at the end of a trial, and when you cancel. This is a self-serve action; you never have to raise a support ticket to get your data out or to have it removed.

**8.2 After you cancel.** Your data stays available for **90 days** after your subscription ends. Both export and self-serve deletion stay open for the whole of that 90 days — neither is gated on a support ticket and neither is withheld over a billing dispute. You can also ask us, at hello@neovogent.com. After the 90 days we securely delete the data, except anything we are required to keep for legal or regulatory reasons (clause 8.3).

How long your clients' records must be kept for your own tax and professional obligations is your decision as controller, not ours — so export before the window closes.

**8.3 Your account data (Part A).**

| What | How long |
|---|---|
| Account and profile data | For as long as the account is open, then deleted **90 days after the account is closed**, except anything we must keep by law |
| Billing records and invoices | Six years from the end of the relevant accounting period, because UK tax law requires it |
| Support emails | Up to **12 months** after the enquiry is resolved, then securely deleted — longer only where an open complaint, legal matter or regulatory obligation needs them |
| Security, audit and error logs | Routine logs, **7 days**. Records relevant to a technical or security incident are kept for as long as the investigation needs them |
| A document you delete in the app | Held in Trash for **30 days**, then permanently deleted. A document that has already been exported is held indefinitely instead, so the link inside your export file keeps working |

**8.4 Backups** are kept separately for disaster recovery and overwritten on a rolling cycle, so data you delete may persist in a backup for a short period after it has gone from the live service. While it does, it stays encrypted, and it is not restored into use except as part of a full disaster recovery. You can export your data at any time during your subscription and throughout the 90-day window in clause 8.2 — backups are our recovery mechanism, not a copy you can ask us to retrieve from.

---

## 9. AI, automated processing and human approval

**9.1 What the AI does.** When a document is uploaded, an AI model hosted in Amazon Bedrock reads the image and suggests what it says — supplier, date, amounts, and a suggested code.

**9.2 What it does not do.** It does not make a decision about a person. It does not decide whether anyone gets credit, a job, a service or a payment. Nothing it produces changes any record until **a person reviews it and presses Approve**. Neo Accounting does not carry out automated decision-making that produces legal effects or similarly significant effects on an individual, within the meaning of Article 22.

**9.3 Training.** We do not use your data, or your clients' documents, to train any AI model — ours or anyone else's. Documents are read through Amazon Bedrock over a secure API, inside the UK region named in clause 7.1. AWS states that prompts and completions sent to Bedrock are not stored by AWS, are not used to train AWS or third-party models, and are not shared with model providers — see the [AWS Bedrock FAQs](https://aws.amazon.com/bedrock/faqs/) and [Bedrock data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html). We record the model, the region and the retention configuration we use, because retention can vary by model and by setting.

**9.4 Text in a document is data, not an instruction.** Anything written inside an uploaded document is treated by our systems as content to be read, never as a command to be followed.

---

## 10. How we protect the data

We are a small company and we will not claim more than we do. We hold **no** security certification — no ISO 27001, no SOC 2 — and we do not describe our security with marketing phrases. What we actually do:

**10.1** Data is encrypted in transit and encrypted at rest.

**10.2** Each practice's data is separated inside the database by per-tenant row-level isolation, so one practice's queries cannot reach another's records.

**10.3** No record changes state without a human approving it first.

**10.4** Multi-factor authentication is required for the roles that can release documents.

**10.5** Card details never touch our systems. Checkout is hosted by Stripe.

**10.6 If something goes wrong.** We keep appropriate technical and organisational measures in place, but no online service can promise an incident will never happen.

If there is a personal data breach affecting data we control, we will report it to the ICO within 72 hours where the law requires, and tell affected people where the risk to them is high. Where a suspected or confirmed breach affects data we process for a practice, we investigate and contain it immediately and tell that practice without undue delay and **within 48 hours** of becoming aware of it, so it can meet its own obligations. We give whatever detail we have at the time and keep sending updates as the investigation goes on. A critical incident is picked up outside standard support hours, including at weekends. The same commitment is in clause 13 of our Data Processing Terms.

---

## 11. Your rights, and how to use them

**11.1** For the data we control (Part A) you have the right to:

| Right | What it means |
|---|---|
| Access | Get a copy of the personal data we hold about you |
| Rectification | Have inaccurate data corrected |
| Erasure | Have data deleted, where there is no reason for us to keep it |
| Restriction | Have us pause using it while something is sorted out |
| Objection | Object to processing we base on legitimate interests (clause 5.2) |
| Portability | Receive data you gave us in a common machine-readable format, or have it sent on |

**11.2 Withdrawing consent.** We do not currently rely on consent for anything in Part A, other than any marketing that clause 5.5 confirms. Where we do rely on consent, you can withdraw it at any time, and withdrawing it does not make what we did beforehand unlawful.

**11.3 How to ask.** Email **hello@neovogent.com**. We will reply within one month. If a request is complex we may extend that by up to two further months, and we will tell you if we do. We may need to check who you are before we act. There is no charge, unless a request is manifestly unfounded or excessive.

**11.4 If your data is in a client document (Part B), ask the practice, not us.** See clause 4.3. This is not us avoiding the question — we are not permitted to change or hand over our customer's records on someone else's say-so.

---

## 12. Complaining to the ICO

**12.1** If you are unhappy with how we have handled your personal data, please tell us first — hello@neovogent.com — so we can try to put it right. Clause 21 of our Terms of Service sets out how a complaint is handled, and how long it should take.

**12.2** You can also complain to the UK regulator, the Information Commissioner's Office, at any time:

- Website: **ico.org.uk/make-a-complaint**
- Helpline: **0303 123 1113**
- Post: Information Commissioner's Office, Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF

Complaining to the ICO does not affect any other legal remedy you have.

---

## 13. Cookies and similar technology

**13.1 No analytics, no advertising, no consent banner.** Neo Accounting sets no analytics cookies, no advertising cookies and no third-party trackers. Nothing beyond what is strictly necessary is set, so no cookie consent banner is required and we do not show one. If we ever introduce analytics, advertising or other optional cookies, we will put a consent banner and a separate cookie notice in place, and ask you, before anything is set.

**13.2 The one cookie we set.**

| Name | What it is for | How long it lasts |
|---|---|---|
| `nt_session` | Keeps you signed in after you log in, and proves the request is yours. Strictly necessary — without it you cannot stay signed in | 12 hours, then it expires. Cleared when you sign out |

**13.3 Other browser storage.** We use your browser's own storage for a small number of strictly necessary or convenience items. These stay on your device; they are not sent to us as cookies, and they are not shared with anyone.

| Item | Where | What it is for |
|---|---|---|
| `nt-business-portal-bearer`, `nt-business-portal-expires` | Session storage | Keeps a client signed in to the client portal for the life of that browser tab. Cleared when the tab is closed |
| `nt.signed-in` | Local storage | Remembers that this browser has signed in before, so the app opens on the right screen instead of flashing a login page |
| `nt.theme` | Local storage | Remembers whether you chose the light or the dark appearance |

**13.4 What we never put in the browser.** Your clients' accounting records and document contents are not stored permanently in the browser, and nothing in browser storage is shared with a third party.

---

## 14. Changes to this notice

**14.1** We will update this notice when what we do changes. The version and date at the foot of the page tell you which version you are reading.

**14.2** If a change materially affects you — a new sub-processor, a new purpose, a change to where data is held — we will tell practices by email before it takes effect.

---

**Version:** 0.2 — draft, pending legal review
**Last updated:** 11 September 2026
