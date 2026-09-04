# Neo Accounting — Client Welcome Email Template

**Status: DRAFT — do not send until the VAT registration number placeholder in the footer is resolved.**
Prepared 3 September 2026. British English throughout.

Merge-field syntax used throughout this document: **`{{double_curly_braces}}`** — one syntax, everywhere, including subject lines.

---

## 1. Merge fields

| Field | Meaning | Example | If empty |
|---|---|---|---|
| `{{contact_first_name}}` | First name of the person who registered the practice (the account holder named on the account) | `Amina` | Use the documented greeting fallback: **"Dear {{firm_name}} team,"**. Never send "Dear Concern", "Dear Sir/Madam" or a blank salutation. |
| `{{firm_name}}` | The accounting practice's name as registered on the account | `SME Outsourcing` | **Do not send.** The firm name is captured at registration; if it is missing, the account record is broken — fix the record first. |
| `{{recipient_email}}` | The email address the account was registered with | `amina@smeoutsourcing.co.uk` | **Do not send.** There is no one to send to. |
| `{{sender_name}}` | The sender's full name, printed under the sign-off | `Md Rakib Saleh` | **Do not send.** A welcome email carrying terms-bearing statements must not go out unsigned. |
| `{{sender_title}}` | The sender's job title as it appears in the signature asset | `Founder, Neovogent AI Solutions UK Ltd` | **Do not send** (same reason as `{{sender_name}}`). |
| `{{send_date}}` | Date the email is sent, UK format, Europe/London | `3 September 2026` | Default to the system date at the moment of sending. Never render blank. |

---

## 2. Primary template

**To:** `{{recipient_email}}`
**Subject:** Welcome to Neo Accounting — {{firm_name}}

---

Dear {{contact_first_name}},

Thank you for registering {{firm_name}} with Neo Accounting. We are pleased to be working with you and look forward to supporting your team.

**Getting started**

The quickest way to see Neo Accounting working is with one real client:

1. **Sign in at https://neoacc.neovogent.com and add your first client business.** The setup form asks for the business's details, a primary contact with a mobile number, and a short business-context questionnaire. The questionnaire matters: it is what the AI uses to code that client's documents sensibly.
2. **Upload a recent bank statement for that client.** A CSV or spreadsheet export from online banking is ideal; a PDF works too.
3. Neo Accounting reads the statement, identifies the paperwork that is missing, and prepares document requests for your team to review. Nothing is sent to your client and nothing is finalised until someone at your practice approves it — every AI suggestion waits for a human decision.

Once the documents are in and approved, Neo Accounting produces an import file for VT Transaction+, with each line carrying a reference back to the source document it came from.

**How we look after your data**

Protecting your practice's information and your clients' information is central to how Neo Accounting is built. We are committed to meeting the applicable requirements of the UK GDPR and the Data Protection Act 2018, both as amended by the Data (Use and Access) Act 2025, and of the Privacy and Electronic Communications (EC Directive) Regulations 2003 (PECR) where they apply to cookies and electronic marketing. We are likewise committed to meeting our obligations under the Equality Act 2010 as they relate to accessibility and preventing discrimination.

In developing and operating the service we are committed to following the ICO's guidance on AI and data protection, and the principles set out in the UK Government's AI regulation white paper — safety, security and robustness; appropriate transparency and explainability; fairness; accountability and governance; and contestability and redress. The last of these is built into the product itself: no AI suggestion takes effect until a person at your practice has reviewed and approved it, and you can question, correct or reject any of it.

**Support**

Throughout your time with Neo Accounting, our team is available to help with onboarding, product queries and technical issues. Reply to this email, or write to support@neovogent.com — we respond within 24 hours, between 06:00 and 18:00 UK time.

We look forward to a productive and lasting working relationship.

Kind regards,

*(signature image: `ceo-sign.png` — see usage notes)*

**{{sender_name}}**
{{sender_title}}

---
Neo Accounting · https://neoacc.neovogent.com
The Neo Accounting service is provided under contract by **EXAM BINARY LTD**, registered in England and Wales, company number 16261850. Registered office: Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham, West Midlands B15 1NP.
VAT registration number: **[PLACEHOLDER — EXAM BINARY LTD's UK VAT registration number, nine digits, format GB123456789, from the company's VAT certificate or HMRC online account. `9286810564` is a tax ID and is NOT it. This email must not be sent while this placeholder stands.]**
Support: support@neovogent.com · Sent {{send_date}}

---

## 3. Subject-line alternatives

| Subject | When it fits |
|---|---|
| `Welcome to Neo Accounting — {{firm_name}}` | **Primary.** Personalised without being promotional; safe default whenever the firm name is held (it always should be). |
| `Welcome to Neo Accounting` | Fallback if the firm name would make the subject unwieldy (very long names), or for a generic re-send. Mirrors the product owner's draft. |
| `{{firm_name}}, your Neo Accounting account is ready` | When the email is triggered by account provisioning completing some time after the sign-up itself — it answers "did my registration work?" |
| `Getting {{firm_name}} started with Neo Accounting` | When the welcome is sent as the first onboarding step (e.g. by an account manager following a sales conversation) rather than as an automatic registration receipt. |

---

## 4. Plain-text version

```
To: {{recipient_email}}
Subject: Welcome to Neo Accounting — {{firm_name}}

Dear {{contact_first_name}},

Thank you for registering {{firm_name}} with Neo Accounting. We are
pleased to be working with you and look forward to supporting your team.

GETTING STARTED

The quickest way to see Neo Accounting working is with one real client:

1. Sign in at https://neoacc.neovogent.com and add your first client
   business. The setup form asks for the business's details, a primary
   contact with a mobile number, and a short business-context
   questionnaire. The questionnaire matters: it is what the AI uses to
   code that client's documents sensibly.

2. Upload a recent bank statement for that client. A CSV or spreadsheet
   export from online banking is ideal; a PDF works too.

3. Neo Accounting reads the statement, identifies the paperwork that is
   missing, and prepares document requests for your team to review.
   Nothing is sent to your client and nothing is finalised until someone
   at your practice approves it -- every AI suggestion waits for a human
   decision.

Once the documents are in and approved, Neo Accounting produces an
import file for VT Transaction+, with each line carrying a reference
back to the source document it came from.

HOW WE LOOK AFTER YOUR DATA

Protecting your practice's information and your clients' information is
central to how Neo Accounting is built. We are committed to meeting the
applicable requirements of the UK GDPR and the Data Protection Act 2018,
both as amended by the Data (Use and Access) Act 2025, and of the
Privacy and Electronic Communications (EC Directive) Regulations 2003
(PECR) where they apply to cookies and electronic marketing. We are
likewise committed to meeting our obligations under the Equality Act
2010 as they relate to accessibility and preventing discrimination.

In developing and operating the service we are committed to following
the ICO's guidance on AI and data protection, and the principles set out
in the UK Government's AI regulation white paper -- safety, security and
robustness; appropriate transparency and explainability; fairness;
accountability and governance; and contestability and redress. The last
of these is built into the product itself: no AI suggestion takes effect
until a person at your practice has reviewed and approved it, and you
can question, correct or reject any of it.

SUPPORT

Throughout your time with Neo Accounting, our team is available to help
with onboarding, product queries and technical issues. Reply to this
email, or write to support@neovogent.com -- we respond within 24 hours,
between 06:00 and 18:00 UK time.

We look forward to a productive and lasting working relationship.

Kind regards,

{{sender_name}}
{{sender_title}}

--
Neo Accounting . https://neoacc.neovogent.com
The Neo Accounting service is provided under contract by EXAM BINARY
LTD, registered in England and Wales, company number 16261850.
Registered office: Suite 5, The Cloisters, 11-12 George Road, Edgbaston,
Birmingham, West Midlands B15 1NP.
VAT registration number: [PLACEHOLDER -- must be resolved before sending]
Support: support@neovogent.com . Sent {{send_date}}
```

---

## 5. Usage notes

**Who sends it.** Sent in the name of **Md Rakib Saleh, Founder, Neovogent AI Solutions UK Ltd** — the name and title exactly as printed on the company's signature asset (`ceo-sign.png`, also served at `https://api.neovogent.com/images/policy-email/ceo-sign.png`), the same asset used on the 29 August 2026 company policy email and the salary slips. In HTML sends, place the signature image above the printed name; in plain-text sends, the printed name and title stand alone. The sending mailbox should be one the practice can actually reply to — replies are routed to support (support@neovogent.com per the Terms of Service, clause 24).

**When it is triggered.** When an accounting practice completes registration (and, where billing is live at intake, subscribes) on Neo Accounting. One send per practice; it is a welcome, not a receipt — Stripe issues the payment documents separately.

**Check before sending — all of these:**

1. **The VAT placeholder is resolved.** The footer must carry EXAM BINARY LTD's real UK VAT registration number. It is not on Companies House; it comes from the company's VAT certificate or HMRC online account. An email carrying `[PLACEHOLDER]` must not leave the building.
2. **The contracting entity is still Exam Binary.** The Terms of Service (docs/legal/terms-of-service.md, header block, decision of 26 Aug 2026) name **EXAM BINARY LTD (company no. 16261850)** as the contracting entity and merchant of record **for the first customer only**, because it holds the live Stripe account — the client's card statement will read Exam Binary. When Stripe migrates to **NEOVOGENT AI SOLUTIONS UK LTD** (company no. 15946429, same registered office), this footer changes in the same commit as the legal documents — not before, not after. Note the web app's landing footer currently shows the Neovogent identity; the legal documents govern, and the mismatch is reported to the owner.
3. **A contact name is held.** If `{{contact_first_name}}` is empty, the greeting falls back to "Dear {{firm_name}} team," — never "Dear Concern".
4. **The legal documents are published.** This email points to commitments the Terms of Service and Privacy Notice carry; both are marked *DRAFT — not for publication until legally reviewed*. Do not send a terms-bearing welcome email before the documents it leans on are live.
5. **Capability wording is intact.** The email must not say or imply that Neo Accounting posts to a ledger, connects to a bank feed, or files anything with HMRC. In this release, export is the sole egress and "Published" is an internal state meaning approved-and-released-for-export (Source of Truth v1.6, D42). If anyone edits the copy, re-check this.
6. **The sender's name is confirmed by the owner.** The signature asset (`ceo-sign.png`, supplied by the owner on 29 Aug 2026 and used on the company policy email and salary slips) prints **"Md Rakib Saleh — Founder, Neovogent AI Solutions UK Ltd"**, and that is what this template uses. However, the company's own HR onboarding letters of 31 July 2026 are signed **"Md. Rakib Ahmed, Founder & CEO"** for the same company. One of these spellings is wrong on a formal document somewhere; confirm the correct legal rendering of the name with the owner before this template carries it to a client.

**Empty merge-field behaviour (summary).** `{{contact_first_name}}` → fall back to "Dear {{firm_name}} team,". `{{firm_name}}`, `{{recipient_email}}`, `{{sender_name}}`, `{{sender_title}}` → block the send and fix the record. `{{send_date}}` → default to the system date.

---

## 6. Claims made in this email, and what backs each

| Claim (as worded in the email) | Backing | Verified? |
|---|---|---|
| "the UK GDPR and the Data Protection Act 2018, both as amended by the Data (Use and Access) Act 2025" | The ICO states verbatim: *"The DUAA amends, but does not replace, the UK General Data Protection Regulation (UK GDPR), the Data Protection Act 2018 (DPA) and the Privacy and Electronic Communications Regulations (PECR)"* — https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-what-does-it-mean-for-organisations/ · Royal Assent 19 June 2025, and *"All the provisions affecting data protection law and [PECR] are now in force"* — https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/ · Canonical text: https://www.legislation.gov.uk/ukpga/2025/18 | **Verified** (3 Sep 2026), via the ICO's official pages. Note: legislation.gov.uk itself was unreachable at verification time (AWS WAF bot challenge on every path tried), so the Act's existence, assent date, in-force status and amendment scope were verified against the ICO — the statutory regulator — instead; the legislation.gov.uk link is supplied as the canonical citation but was **not independently fetched today**. |
| "Privacy and Electronic Communications (EC Directive) Regulations 2003 (PECR)" — the formal name | The ICO states: *"Their full title is The Privacy and Electronic Communications (EC Directive) Regulations 2003"*, and links the instrument at http://www.legislation.gov.uk/uksi/2003/2426 — https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/what-are-pecr/ (same page confirms PECR covers marketing emails/texts and cookies) | **Verified** (3 Sep 2026) |
| "Equality Act 2010" | *"The Equality Act 2010 legally protects people from discrimination in the workplace and in wider society"* — https://www.gov.uk/guidance/equality-act-2010-guidance · Canonical text: https://www.legislation.gov.uk/ukpga/2010/15 | **Verified** (3 Sep 2026). The email's wording is deliberately qualified ("as they relate to accessibility and preventing discrimination") — the gov.uk overview page confirms the discrimination protections; the reasonable-adjustments/accessibility duty wording is kept conditional rather than asserted. |
| "the ICO's guidance on AI and data protection" | Exact title confirmed as *"Guidance on AI and data protection"* — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/guidance-on-ai-and-data-protection/ (page fetched 3 Sep 2026; note the ICO flags this guidance as under review following the DUAA) | **Verified** (3 Sep 2026) |
| "the principles set out in the UK Government's AI regulation white paper — safety, security and robustness; appropriate transparency and explainability; fairness; accountability and governance; and contestability and redress" | White paper *"AI regulation: a pro-innovation approach"*, published 29 March 2023; the five cross-sectoral principles confirmed verbatim from the HTML edition: "Safety, security and robustness", "Appropriate transparency and explainability", "Fairness", "Accountability and governance", "Contestability and redress" — https://www.gov.uk/government/publications/ai-regulation-a-pro-innovation-approach/white-paper | **Verified** (3 Sep 2026) |
| "produces an import file for VT Transaction+" — and deliberately **not** "posts to your ledger" | Source of Truth v1.6 §24.1, D42 (export is the sole egress; *Published* means approved-and-released-for-export, never posted-to-a-ledger); Terms of Service plain-English summary and clause 4.3 | Verified against `/Users/mubasshir/neoting/docs/Source_Of_Truth.md` and `/Users/mubasshir/neoting/docs/legal/terms-of-service.md` |
| "each line carrying a reference back to the source document it came from" | Source of Truth v1.6, D43 — every exported transaction carries a resolvable link to its source document | Verified against `/Users/mubasshir/neoting/docs/Source_Of_Truth.md` (D43) |
| "nothing is finalised until someone at your practice approves it" | Source of Truth §24.2 stages 8–10 (accountant edits, super admin releases, D44); repo-wide invariant "no state change outside the Review → Approve path" | Verified against `/Users/mubasshir/neoting/CLAUDE.md` and `docs/Source_Of_Truth.md` |
| "we respond within 24 hours, between 06:00 and 18:00 UK time" | Terms of Service clause 24 ("Response time: within 24 hours, 06:00–18:00 UK time") and the landing page support copy | Verified against `/Users/mubasshir/neoting/docs/legal/terms-of-service.md` §24 |
| Footer identity: EXAM BINARY LTD, company no. 16261850, registered office as shown, VAT number `[PLACEHOLDER]` | Terms of Service clause 1.1 and clause 24 | Verified against `/Users/mubasshir/neoting/docs/legal/terms-of-service.md` (the VAT number is genuinely a placeholder there — carried through as one) |

*"We are committed to meeting the applicable requirements" is used deliberately instead of "we comply with": the company's own legal documents are drafts awaiting solicitor review and the VAT registration is unresolved, so an unqualified written compliance representation is not yet defensible. See the accompanying report.*
