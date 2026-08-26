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

**84 `[PLACEHOLDER: …]` markers remain.** Grep for them. Each one is a fact the drafters
refused to invent, and most explain the risk of guessing. Do not publish a page with one
still in it — an unfinished legal page is worse than a missing one.

The ones that need a decision rather than a lookup:

### 1. The VAT number may be wrong

The tax ID supplied is `9286810564` — **ten digits. A UK VAT registration number is
normally nine** (twelve for branch traders). Confirm it before it appears on a published
page or a Stripe invoice. If it is a different kind of tax reference, the VAT number still
has to be found.

### 2. Staff access from Bangladesh is an international transfer

The team is in Bangladesh; the data is UK client financial records in `eu-west-2`. Staff
access from outside the UK is a **restricted transfer** under UK GDPR and needs an
International Data Transfer Agreement or the UK Addendum, plus a transfer risk assessment.

This is not a paperwork detail — it is the single largest unaddressed compliance item, and
it applies from the first customer.

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

### 7. Who contracts with whom

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
