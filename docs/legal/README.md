# Legal pack — what it is, and what it still needs

Four documents, drafted from the product's own documented behaviour and from the SoT's own
commitments:

| Document | Why it exists |
|---|---|
| `terms-of-service.md` | The contract with the accounting practice. |
| `privacy-notice.md` | UK GDPR Art. 13. Required **at the point of collection**. |
| `data-processing-terms.md` | UK GDPR Art. 28(3). Required **before** a practice uploads a client's records. |
| `refund-and-cancellation.md` | Stripe requires a reachable refund policy; customers need a way out. |

> **These are a drafting aid, not legal advice.** They have not been reviewed by a lawyer.
> A qualified UK solicitor should read them before they are published. Each file opens with
> a block saying the same thing — **delete that block before publishing.**

---

## Before any of these go live

**65 `[PLACEHOLDER: …]` markers remain** across the four documents. Grep for them. Each one is a fact the drafters
refused to invent, and most explain the risk of guessing. Do not publish a page with one
still in it — an unfinished legal page is worse than a missing one.

The ones that need a decision rather than a lookup:

### 1. The VAT registration number and the tax ID are both still missing

Both belong to **NEOVOGENT AI SOLUTIONS UK LTD** (15946429) and neither is held.
⚠ `9286810564` was recorded against **EXAM BINARY LTD**, the superseded entity (§7). It is a
tax ID, not a VAT registration number, and it must not be carried across to this company.
The documents now carry a placeholder for each rather than the wrong number.

**The VAT registration number is a separate nine-digit reference and it is still needed.**
It has to appear on every invoice, on the website, and in Stripe's tax-ID field, which
expects a `gb_vat` value. Putting the tax ID there produces invoices with the wrong number
on them, and a VAT invoice with the wrong registration number is not a valid VAT invoice.

This blocks switching Stripe to live mode.

### 2. Access from outside the UK — decided: it does not happen

**Policy, set 26 Aug 2026: personal data in Neo Accounting is not accessed from outside the
United Kingdom.** The team works from Bangladesh; client documents stay in `eu-west-2` and
are not opened, exported or supported from outside the UK.

That removes the restricted-transfer problem — but only for as long as it is true, and a
policy that lives only in someone's head is not a control. Two things make it real, and
both are cheap:

- **Say it in the documents.** The privacy notice and the processing terms now state it.
  Once stated, it is a contractual commitment to every practice that signs.
- **Enforce it where it is enforceable.** Access to production data is an AWS IAM question,
  not an honour question. A condition on the app role, or IP-restricted console access, is
  what turns the policy into something you could evidence if a client asked.

If the policy ever has to bend — a production incident nobody in the UK can reach — that is
the moment it needs an International Data Transfer Agreement and a transfer risk
assessment, not the moment after.

### 3. Backups may leave the UK

SoT D30 records **one named residency exception**: a cross-region disaster-recovery backup
target, because the UK has only one AWS region. If that exception is live, the privacy
notice must name the destination region and the transfer mechanism. If it is not live, say
backups stay in the UK. Either is fine; silence is not.

### 4. Cookies

The notice cannot state a cookie position without an inventory. List what
`neoacc.neovogent.com` and `/app` actually set. If anything beyond strictly necessary
cookies is set, PECR requires **consent before it is set** — which means a banner, and a
separate cookie notice.

### 5. The support mailbox

`support@neovogent.com` forwards through Cloudflare to a **free consumer Gmail account**.
That account has no Art. 28 processor contract, and clients' financial documents will pass
through it as attachments. Either move to a business mailbox with proper terms, or record
the decision and why it is acceptable.

### 6. ICO registration

The data-protection fee (£40–60/year) is not registered.
`docs/Kickoff_Requirements.md` §1.2 marks it blocking **before any real customer data**.
The registration number goes in the privacy notice.

### 7. The contracting entity is NEOVOGENT AI SOLUTIONS UK LTD

Decided 3 Sep 2026, superseding the 26 Aug 2026 decision that named EXAM BINARY LTD. The
contracting entity and merchant of record in all four documents is
**NEOVOGENT AI SOLUTIONS UK LTD** — company **15946429**, incorporated 10 September 2024,
registered office **Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham
B15 1NP**. Verified at Companies House, 3 Sep 2026.

**Why this reverses the August decision.** That decision rested on a single stated fact —
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
  services. Exam Binary is **85600, educational support services** — and the previous version
  of this section already warned that Stripe underwriting reads the company record, and that
  "an education company selling bookkeeping software is the kind of mismatch that triggers a
  review". On its own register entry, Neovogent is the stronger applicant.
- **Everything else already said Neovogent.** SoT D5 records the company as Neovogent, the
  legal pack's support address is `support@neovogent.com`, and the product is served from
  `neoacc.neovogent.com`.

**The sequencing rule still binds, in the other direction.** The entity that takes the money
must be the entity in the contract. So **Stripe live mode must be opened under 15946429**, and
no payment may be taken until it is. Because nothing is published and nothing is charging,
there is no window in which the two disagree — which is exactly why this was the moment to
change it, and at zero cost.

⚠ **Two things are still missing, and together they block charging anybody:**
NEOVOGENT AI SOLUTIONS UK LTD's **UK VAT registration number** and its **tax ID**. Neither is
on the public register; take them from the VAT certificate and the HMRC online account.
`9286810564` was recorded against EXAM BINARY LTD — it is a tax ID, not a VAT number, and it
must not be carried across. Stripe's tax-ID field expects a `gb_vat` value, and an invoice
carrying the wrong registration number is not a valid VAT invoice.

---

### 8. Who contracts with whom

The terms assume **the practice** holds the account. SoT §22 open decision #10 records the
payer as **the client business**. Those are different contracts with different parties, and
the documents must match whichever is true. Settle it before publication, not after.

---

## Where they are rendered

`docs/launch/MUBASSHIR.md` stage **M4** renders these as pages under `/legal/*`, linked
from the landing-page footer and — for the privacy notice — from the portal sign-in and
upload screens, because Art. 13 requires it where data is collected.

The markdown here stays the source of truth. Render it; do not retype it, or a correction
has to be made twice.
