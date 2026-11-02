# modules/tax-estimate — the VAT/GST & company tax estimate (D52, SoT §25)

A paid add-on (£15/month + VAT, or A$30/month for an Australian business) that
shows, for one client and one period, what their VAT return / BAS GST and their
company tax are likely to come to — computed from what is already in the
product. **Reads only. Nothing here writes, and nothing is ever submitted.**

| File | What it is |
|---|---|
| `estimate.ts` | **Pure.** Documents + bank evidence + the country's rules → figures, a range, a completeness score, notes and assumptions. All the tax arithmetic lives here and only here |
| `tax-estimate.service.ts` | Gathers one client's documents, bank lines and statement coverage for the period (inside `scopedDb`) and calls `estimate()`. `bankFacts` / `coveredDays` are pure and exported for tests |
| `tax-estimate.controller.ts` | `GET /v1/tax-estimates` (accountant) and `GET /v1/portal/tax-estimate` (client portal) |
| `estimate.test.ts`, `tax-estimate.service.test.ts` | Offline: the rules, the CT bands (with a monotonic/19–25% property check), the range, the score, coverage |
| `tax-estimate.integration.test.ts` | Real Postgres RLS, namespace `te_`: the document predicate, bank evidence, the add-on gate, cross-practice invisibility |

## Five decisions worth knowing before changing anything

1. **⚠ Never submittable, and every surface says so.** No HMRC or ATO connection
   exists or is planned for this add-on; HMRC MTD filing stays deferred (SoT §2).
   The web panel and its printout both carry the statement. Do not add a
   "submit" or "export to HMRC" affordance without a new decision.
2. **⚠ Accuracy is a RANGE plus a COMPLETENESS SCORE, never a promised
   percentage** (Mubashir, 2 Nov 2026). The central figure comes only from
   documents. The range widens by the tax that could sit behind bank money with
   no document (debits → unclaimed input tax / expenses; credits → undeclared
   sales / income) and behind documents whose tax was not read. The score is
   statement coverage × evidenced share; the reviewed share is shown beside it,
   not multiplied in (multiplying it put nearly every real client near zero). No accuracy % may be
   claimed until estimates are compared with real filed returns — none exist yet.
3. **`active: false` is an answer, not an error.** Without the add-on (or with a
   lapsed subscription — `mayUseTaxEstimate` needs both) the view returns
   `{ active: false, estimate: null }` so the tab can draw the offer. Same as the
   vault's `GET /portal/vault`.
4. **The portal path runs in the practice SYSTEM scope**, which sees every
   business in the practice — so it ALWAYS uses `facts.businessId`, never
   anything from the request.
5. **The chart decides treatment.** Category → `accountCatalogue()` gives the
   ledger, VAT treatment and tax consequence. `BLOCKED` VAT is left out of box
   4 / 1B; `DISALLOWABLE` is added back; `Fixed assets` is capital (UK: AIA, cars
   18% WDA; AU: write-off under A$20,000 in the central figure, the range covers
   the rules). An uncategorised or off-chart code is assumed standard-rated and
   deductible centrally and flagged; the CT range allows for it not being.

## The rules, as implemented

| | UK | Australia |
|---|---|---|
| Indirect tax | VAT return boxes 1–9; standard or flat-rate (box 1 = flat % of VAT-inclusive turnover; input VAT only on capital ≥ £2,000 incl VAT). Boxes 2/8/9 zero (stated) | G1, G10, G11, 1A, 1B; net = 1A − 1B. G2/G3 not split out (stated) |
| Company tax | 19% ≤ £50k, 25% ≥ £250k, marginal relief 3/200 × (upper − profit) between; limits pro-rated by days/365 for a short period; no associated companies (stated) | 25% base-rate entity (30% otherwise — stated) |
| Bank exclusions | EXCLUDED lines, payments to/from HMRC/ATO, and chase-suppressed PAYMENTS OUT (bank charges, interest, wages — no VAT). ⚠ Not suppressed credits: every credit is suppressed automatically, and card takings are the likeliest sales with no invoice | same |
| Evidenced | `SUGGESTED` or `CONFIRMED` match | same |

Accruals basis throughout (documents by their own date); cash accounting is
stated as an assumption, not modelled. Documents counted: `TO_REVIEW`, `READY`,
`PUBLISHED`, in SALES/COSTS, not a bank statement (NULL docType included — the
Prisma `not` trap), not deleted or archived, dated in the period, in the home
currency (others counted and named in the notes).

## Billing (owned by `modules/billing`)

The add-on is a second subscription ITEM (D51's shape): `STRIPE_TAX_ESTIMATE_PRICE_ID`
(GBP) / `STRIPE_TAX_ESTIMATE_PRICE_ID_AUD`; the webhook writes
`businesses.tax_estimate_addon`. Only the client's portal session can add it
(`POST /v1/billing/add-ons`). Australian clients are billed in A$ (D53,
`STRIPE_PRICE_ID_AUD`), because one subscription cannot mix currencies. All
three empty = not sold, which is a valid deployment.

## TODO

- [ ] Measure accuracy against real filed returns before any % claim.
- [ ] Mixed-rate invoices: one category per document (the `DocumentLine`
      blocker in `rules-suggestions/CLAUDE.md`) means a mixed-rate invoice is
      treated by its one category.
- [ ] Australian chart of accounts with real GST codes (G2/G3, input-taxed).
- [ ] The client's own VAT stagger / company year end as defaults for the
      period (the columns exist on `businesses`; the web uses calendar periods).
