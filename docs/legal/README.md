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

**105 `[PLACEHOLDER: …]` markers remain** across the four documents. Grep for them. Each one is a fact the drafters
refused to invent, and most explain the risk of guessing. Do not publish a page with one
still in it — an unfinished legal page is worse than a missing one.

The ones that need a decision rather than a lookup:

### 1. The VAT registration number is still missing

`9286810564` is the company **tax ID**, not the VAT registration number — confirmed
26 Aug 2026. The documents now say so.

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

### 7. The contracting entity is Exambinary, and it is temporary

Decided 26 Aug 2026. For the **first customer only**, the contracting entity and merchant
of record in all four documents is **Exambinary Holding Ltd**, not
NEOVOGENT AI SOLUTIONS UK LTD.

The reason is that Exambinary holds the live Stripe account (`acct_1RQtbxGMdHp4NCWv`), and
the entity that takes the money is the entity that makes the supply:

- The customer's **card statement** will read Exambinary. A contract naming a company the
  accountant has never heard of is how a legitimate charge becomes a chargeback.
- The **VAT invoice comes from Exambinary's VAT registration**, because HMRC requires the
  invoice to come from the supplier. Neovogent's number cannot go on it.

**Three things are still missing and each blocks publication:** Exambinary's exact
registered name at Companies House, its company number, and its VAT registration number.
They are marked `[PLACEHOLDER: Exambinary …]` in every document.

**Reverting is a single commit, and it must be the same commit as the Stripe migration** —
not before it, and not after. Publishing terms naming Neovogent while Stripe still charges
as Exambinary reintroduces exactly the mismatch this decision avoids.

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
