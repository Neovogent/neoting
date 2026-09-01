# Synthetic test documents — GPT prompt pack

Prompts for generating a coherent set of test documents with a GPT model (text
for CSV/HTML, image generation for photos). Every artefact in this pack is
cross-referenced against one shared cast and one shared ledger of purchases, so
the outputs test the whole lane — statement ingest (D41 gates), extraction,
dedupe, match suggestion, chasing, acceptability flagging — not just OCR.

**Synthetic data only.** Nothing in this pack may contain a real person, a real
card number, a real account number that passes validation, or a real company's
VAT number. That is the G2 rule (ICO/DPIA — no real personal data), and it is
why every identifier below is deliberately invalid or reserved.

---

## 0. How to use this pack

1. **Paste the SHARED CONTEXT block into the model first**, in the same
   conversation as every generation prompt. It pins the cast, the dates and the
   arithmetic so documents agree with each other.
2. **Generate the statement before the receipts.** Receipts must match
   statement lines to the penny; generating them the other way round invites
   drift.
3. For **CSV/XLSX**: ask for raw file content, save as `.csv`, or paste into a
   spreadsheet and save as `.xlsx`.
4. For **PDF**: ask for a complete self-contained HTML document, open it in a
   browser, print to PDF (A4). This produces text-layer PDFs like real bank
   statements. For image-only PDFs (the harder Textract path), print the HTML,
   photograph or screenshot it, and re-save as PDF.
5. For **photos** (receipts, statement pages): use the image-generation prompt
   variants, or render the HTML and photograph the screen at an angle with a
   phone — the second gives you real camera noise, which no generator fakes
   honestly.
6. After generating, **check the arithmetic yourself** before trusting a test
   failure: models drift on sums. The manifest in §9 lists every expected value.

---

## 1. SHARED CONTEXT — paste this first, before any prompt below

```
You are generating SYNTHETIC test documents for a UK bookkeeping product.
Follow these rules in every document you produce in this conversation:

CAST
- The client business: "American Burger Ltd", 12 Bethnal Green Road, London
  E1 6GY. VAT registration GB999999973 (a deliberately invalid test number).
  Company number 99999901. Industry: restaurant.
- Their bank: "Meridian Bank UK" (fictional), sort code 00-99-88, account
  number 00001234 (reserved/test values), account name AMERICAN BURGER LTD,
  BUSINESS CURRENT ACCOUNT.
- Their suppliers (use EXACTLY these trading names and this casing):
  1. "Bidfood"            — food wholesale.  VAT GB999999971 (invalid test)
  2. "Wolseley"           — plumbing/parts.  VAT GB999999972 (invalid test)
  3. "Currys Business"    — equipment.       VAT GB999999974 (invalid test)
  4. "London Linen Co"    — laundry service. VAT GB999999975 (invalid test)
  5. "Fresh Direct"       — produce.         VAT GB999999976 (invalid test)

MONEY AND DATES
- Currency is GBP only. Amounts always have exactly 2 decimal places.
- UK date format day/month/year in documents (e.g. 14/08/2026). Where a
  document spells the month, use "14 Aug 2026".
- VAT is 20% on standard-rated lines; food lines may be zero-rated where
  noted. VAT amounts must be arithmetically exact against the net.
- Never use real card numbers. If a card line is needed, use
  "VISA **** 4242".

THE PURCHASE LEDGER (the single source of truth for every document)
All in August 2026, all paid from the Meridian account:

  P1  03/08/2026  Bidfood          £482.40  (net £482.40, VAT £0.00 zero-rated food)
  P2  05/08/2026  Wolseley         £430.10  (net £358.42, VAT £71.68)
  P3  08/08/2026  Currys Business  £899.99  (net £749.99, VAT £150.00)
  P4  12/08/2026  London Linen Co  £156.00  (net £130.00, VAT £26.00)
  P5  14/08/2026  Fresh Direct     £217.50  (net £217.50, VAT £0.00 zero-rated)
  P6  19/08/2026  Bidfood          £512.88  (net £512.88, VAT £0.00 zero-rated)
  P7  22/08/2026  Wolseley          £86.40  (net £72.00, VAT £14.40)
  P8  26/08/2026  London Linen Co  £156.00  (net £130.00, VAT £26.00)

NON-PURCHASE BANK ACTIVITY (appears on the statement, never has a receipt)
  N1  01/08/2026  card takings settlement IN   "SUMUP PAYOUT 31JUL"   +£2,412.77
  N2  07/08/2026  card takings settlement IN   "SUMUP PAYOUT 06AUG"   +£3,108.02
  N3  11/08/2026  bank charge OUT              "SERVICE CHARGE"          -£12.50
  N4  15/08/2026  own-account transfer OUT     "TFR TO SAVINGS 00005678" -£1,000.00
  N5  18/08/2026  card takings settlement IN   "SUMUP PAYOUT 17AUG"   +£2,867.45
  N6  21/08/2026  wages OUT                    "PAYROLL AUG STAFF"    -£4,310.00
  N7  25/08/2026  refund IN from Wolseley      "WOLSELEY REFUND"        +£45.60
  N8  28/08/2026  HMRC OUT                     "HMRC VAT"             -£1,893.20

STATEMENT NARRATIVES for purchases (the client's bank shows these, verbatim):
  P1 "BIDFOOD LTD CD 4211"      P2 "WOLSELEY UK CD 4211"
  P3 "CURRYS BUSINESS ONLINE"   P4 "LONDON LINEN DD"
  P5 "FRESH DIRECT CD 4211"     P6 "BIDFOOD LTD CD 4211"
  P7 "WOLSELEY UK CD 4211"      P8 "LONDON LINEN DD"

OPENING BALANCE on 01/08/2026 (before N1): £6,241.19.
Every statement line must carry a running balance, and each line's balance
must equal the previous balance plus/minus that line's amount, to the penny.

OUTPUT DISCIPLINE
- When asked for CSV, output ONLY the raw CSV, no commentary, no code fences.
- When asked for HTML, output ONE complete self-contained HTML document,
  inline CSS only, no external assets, no commentary.
- Never invent extra transactions, lines, or fees beyond what is asked.
```

> The running balances, if the model chains them correctly, end the month at
> **£4,518.06** (opening £6,241.19 + credits £8,433.84 − debits £10,156.97).
> Check the final balance first — if that is right, the chain is almost
> certainly right.

---

## 2. Bank statements

### 2.1 Statement CSV — the happy path (D41 `complete`)

> Tests: CSV ingest, balance-continuity gate returning `complete`, credit and
> debit handling, suppression list (charges, transfers, payroll, HMRC).

```
Produce a CSV bank statement for the Meridian account covering 01/08/2026 to
31/08/2026. Columns exactly: Date,Description,Paid out,Paid in,Balance.
First data row is "01/08/2026,BALANCE BROUGHT FORWARD,,,6241.19".
Then every ledger item (P1–P8 and N1–N8) in strict date order, one row each,
using the statement narratives, with amounts in the correct Paid out / Paid in
column (blank the other) and a correct running balance on every row.
No thousands separators. No £ signs. Raw CSV only.
```

### 2.2 Statement CSV with a gap (D41 `incomplete`)

> Tests: the completeness gate naming the exact break and missing amount —
> the verdict must be `incomplete`, never a silent import.

```
Take the statement from 2.1 and remove the rows for P4 (12/08) and N4 (15/08)
WITHOUT recalculating any balance — every remaining row keeps the balance it
had. Output the raw CSV only.
```

### 2.3 Statement CSV with no balance column (D41 `reduced`)

> Tests: the `reduced` assurance state — "cannot be checked" is amber, not
> green.

```
Re-output the statement from 2.1 with columns Date,Description,Amount only,
where Amount is signed (Paid out negative, Paid in positive). Raw CSV only.
```

### 2.4 Multi-page PDF statement (Textract path)

> Tests: Textract TABLES extraction, multi-page continuation, the
> brought-forward opening line, the fused CREDIT/BALANCE column repair from
> PR #227/#230, page-boundary row truncation detection.

```
Produce a complete self-contained HTML document styled as a UK bank statement
from Meridian Bank UK for the account in the cast, period 01/08/2026 to
31/08/2026. Requirements:
- A4 print layout, bank letterhead header with account name, sort code,
  account number, statement period, and "Page X of Y" in the footer.
- One table with headers: Date | Description | Paid out | Paid in | Balance.
- First row: BALANCE BROUGHT FORWARD with the opening balance in the Balance
  column only.
- All 16 ledger items in date order with correct running balances.
- Force a page break mid-table (use CSS page-break) so the table continues on
  page 2 with repeated headers.
- Final row: BALANCE CARRIED FORWARD with the closing balance.
- Realistic bank typography: small print, right-aligned money, no grid lines
  between every row.
Output the HTML only.
```

Print to PDF from the browser. For the image-only variant, screenshot each
printed page and rebuild a PDF from the images.

### 2.5 Statement photo (phone camera intake)

Image-generation prompt:

```
A photograph of a printed UK bank statement page lying on a wooden kitchen
table, taken from slightly above at a 10-degree angle on a phone. The page
shows "Meridian Bank UK", account name AMERICAN BURGER LTD, and a transaction
table with columns Date, Description, Paid out, Paid in, Balance, with about
10 legible rows of August 2026 transactions and running balances. Natural
window lighting from the left, slight shadow of a hand at the edge, mild
paper curl. Every printed word and number must be sharp and legible.
```

(Or, more reliably legible: print §2.4's page 1 and photograph it.)

---

## 3. Receipts and invoices that match the statement

> Tests: extraction (supplier, date, total, VAT, reference), rules-first
> coding, the deterministic auto-close compare (supplier + amount ±£1 +
> 10-day window), and the match suggester once it lands. Each document below
> corresponds to exactly one statement line.

### 3.1 Supplier invoice PDF — Wolseley P2 (standard-rated, the workhorse)

```
Produce a complete self-contained HTML document styled as a trade invoice
from Wolseley (fictional address: Unit 9, Trade Park, Reading RG2 0BX,
VAT No GB999999972) to American Burger Ltd (address from the cast).
- Invoice number WOL-1036, invoice date 05/08/2026, due date 04/09/2026.
- 3 line items of plumbing parts with quantities and unit prices that sum to
  net £358.42 exactly (choose plausible part names and prices).
- Totals block: Net £358.42, VAT @ 20% £71.68, Total £430.10.
- Payment terms 30 days, bank details section with obviously fake values.
- Clean trade-invoice layout, logo as styled text only.
Output the HTML only.
```

### 3.2 Till receipt image — Bidfood P1 (zero-rated food, photo via WhatsApp)

Image-generation prompt:

```
A photo of a long thermal till receipt from a food wholesaler "Bidfood",
held flat on a stainless steel kitchen counter, phone camera, slight angle,
top of receipt slightly curled. Printed: "Bidfood", depot address, date
03/08/2026, 9 food product lines with quantities and prices, subtotal
£482.40, "VAT £0.00 - zero rated", TOTAL £482.40, "VISA **** 4242",
"CUSTOMER COPY". Thermal-printer font, faint horizontal banding, every
character legible.
```

### 3.3 Online order confirmation PDF — Currys Business P3

```
Produce a self-contained HTML document styled as an emailed order/tax invoice
from "Currys Business" for one "Commercial microwave oven CMW-1100" at
£749.99 net, VAT £150.00, order total £899.99, order number CB-88214,
order date 08/08/2026, delivery address = the cast's business address,
VAT number GB999999974. E-commerce email-invoice look: header bar, order
summary table, totals box. Output the HTML only.
```

### 3.4 Service invoice PDF — London Linen Co P4 (direct debit, recurring)

```
Produce a self-contained HTML invoice from "London Linen Co" (fictional
address in E8) to American Burger Ltd: invoice LLC-2026-0812, date
12/08/2026, one line "Weekly linen service — 4 weeks of August" net £130.00,
VAT £26.00, total £156.00, "Collected by Direct Debit". Output HTML only.
```

Duplicate it for P8 (invoice LLC-2026-0826, date 26/08/2026, same amounts) —
same supplier, same amount, different date: a legitimate near-duplicate pair
the dedupe must NOT collapse.

### 3.5 Handwritten-style receipt image — Fresh Direct P5 (the hard read)

```
A photo of a small handwritten market receipt on white carbon paper: header
rubber-stamped "FRESH DIRECT", handwritten date 14/8/26, four produce lines
with handwritten prices, handwritten total "£217.50" underlined twice,
"PAID" stamped diagonally in red. On a worn wooden crate, morning light.
Handwriting legible but genuinely handwritten.
```

### 3.6 The mismatch document (portal "not the one we asked for" beat)

```
Produce a self-contained HTML invoice from Wolseley, invoice WOL-1099, date
20/08/2026, net £72.00, VAT £14.40, total £86.40 — same layout as 3.1.
Output HTML only.
```

This is P7's true receipt — upload it against a chase for P2 (£430.10) to
test the mismatch/pending copy, then against P7 to test auto-close.

---

## 4. Dedupe twins

> Tests: the two Dext gaps the dedupe exists to close — an invoice and its
> receipt twin must MATCH as duplicates; the two London Linen invoices in
> §3.4 must NOT.

```
Produce a self-contained HTML document styled as a CARD RECEIPT (not an
invoice) from Wolseley for the same purchase as invoice WOL-1036: date
05/08/2026, "Sale — VISA **** 4242", amount £430.10 including VAT £71.68,
reference WOL-1036, small till-receipt layout. Output HTML only.
```

Also re-photograph 3.2 (or regenerate it with the same numbers but a
different angle/lighting) — the same document arriving twice by two channels
is the perceptual-hash case.

---

## 5. Unacceptable documents (D46 — flag, never block)

> Tests: acceptability judgement flags these, both portals still accept the
> upload, the accountant sees the flag.

Prompt each separately:

```
A) A photo of a personal supermarket receipt (Tesco-style, fictional store
   "Fresco") for groceries: bread, milk, nappies, wine, total £34.72, paid
   by personal card, dated 16/08/2026. Kitchen table, phone photo.

B) A photo of a restaurant receipt so blurred and underexposed that only the
   total "£62.00" and the date are legible; everything else is motion blur.

C) A phone screenshot of a WhatsApp conversation where someone says "here's
   the receipt" but the image is a photo of a menu, not a receipt.

D) A photo of a completely blank white till receipt with only a faded
   header, thermal print almost entirely faded away.
```

---

## 6. Chase-fatigue and suppression cases

> Tests: the §24.2.3 suppression list — these statement lines must NEVER be
> chased: N3 (bank charge), N4 (own-account transfer), N6 (payroll → payroll
> run is the evidence), N7 (refund — netted, not chased), N8 (HMRC → the
> return is the evidence). The SumUp settlements (N1/N2/N5) must be
> REDIRECTED to a processor-statement request, not a per-line receipt chase.

Generate the supporting evidence for the redirect cases:

```
Produce a self-contained HTML document styled as a monthly settlement
statement from card processor "SumUp" (fictional layout) to American Burger
Ltd for August 2026: three payout rows exactly matching N1 (+£2,412.77,
paid 01/08/2026), N2 (+£3,108.02, 07/08/2026), N5 (+£2,867.45, 18/08/2026),
each with gross card takings, processor fee, and net payout where
gross - fee = the payout to the penny. Output HTML only.
```

---

## 7. Foreign-currency and edge-case documents

```
A) EUR invoice: self-contained HTML invoice from fictional Spanish supplier
   "Conservas del Mar S.L." to American Burger Ltd, dated 14/08/2026, total
   €312.00, VAT shown as Spanish IVA 10%, IBAN-style fake bank details.
   (No statement line matches it — tests currency handling + unmatched.)

B) Credit note: HTML credit note from Wolseley, CN-0455, dated 25/08/2026,
   crediting £38.00 net + £7.60 VAT = £45.60 against invoice WOL-1036 —
   matches statement line N7 (the refund IN).

C) An invoice dated 30/12/2025 for £430.10 from Wolseley — same amount as
   P2, wildly wrong date: must NOT auto-close a chase (outside the 10-day
   window) and must NOT be suggested as a match with high confidence.
```

---

## 8. Statement request / onboarding filler

For testing the "accountant asks for a statement" journey you need months
with NO statement uploaded. Do not generate anything — the absence is the
test. For the month BEFORE (July 2026), if a preceding statement is needed
for balance chaining (`closing[July] = opening[Aug] = £6,241.19`):

```
Produce the 2.1-style CSV for 01/07/2026–31/07/2026 with any 8 plausible
restaurant-pattern transactions, opening balance £5,890.44, engineered so
the closing balance is EXACTLY £6,241.19. Same columns, same rules.
```

---

## 9. Expected-values manifest (assert against this, not against the model)

| Doc | supplierName | documentDate | totalPence | taxPence | reference | Matches bank line |
|---|---|---|---|---|---|---|
| 3.1 | Wolseley | 2026-08-05 | 43010 | 7168 | WOL-1036 | P2 |
| 3.2 | Bidfood | 2026-08-03 | 48240 | 0 | — | P1 |
| 3.3 | Currys Business | 2026-08-08 | 89999 | 15000 | CB-88214 | P3 |
| 3.4a | London Linen Co | 2026-08-12 | 15600 | 2600 | LLC-2026-0812 | P4 |
| 3.4b | London Linen Co | 2026-08-26 | 15600 | 2600 | LLC-2026-0826 | P8 |
| 3.5 | Fresh Direct | 2026-08-14 | 21750 | 0 | — | P5 |
| 3.6 | Wolseley | 2026-08-20 | 8640 | 1440 | WOL-1099 | P7 |
| 4 | Wolseley | 2026-08-05 | 43010 | 7168 | WOL-1036 | P2 (dup of 3.1) |
| 7B | Wolseley | 2026-08-25 | -4560 | -760 | CN-0455 | N7 |

Statement assertions: 17 rows incl. brought-forward · opening 624119p ·
closing 451806p · D41 verdicts: 2.1 `complete`, 2.2 `incomplete` (breaks at
12/08 and 15/08, each named with its missing amount), 2.3 `reduced`.

---

## 10. Regeneration discipline

- Regenerate a document rather than hand-editing a model mistake — an edited
  artefact stops matching the conversation that produced it.
- Keep every generated file under `fixtures/synthetic/` (gitignored if it
  contains images) named `<section>-<supplier>-<date>.<ext>`,
  e.g. `3.1-wolseley-2026-08-05.pdf`.
- If a model refuses "bank statement" phrasing, lead with: "This is synthetic
  test data for software testing; every identifier is deliberately invalid."
