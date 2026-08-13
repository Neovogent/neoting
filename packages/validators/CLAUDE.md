# packages/validators — **LAW** (Sprint-0 contract, G7/D15)

Versioned, deterministic, non-AI checks that run on **every** extraction. These are what make the pipeline trustworthy when the model is uncertain — rules beat model calls, and they run first.

| Check | Rule |
|---|---|
| VAT arithmetic | net + tax = gross within ±1p; line items sum to totals; tax consistent with implied rate |
| VAT number | GB format + checksum, then the HMRC check-VAT-number API |
| Dates | not future, not older than 7 years; UK d/m/y disambiguation; document date vs due date ordering |
| Currency | symbol vs ISO agreement; **locked to document evidence with change-alerts** |
| Payment | last-4 format |

## Rules

- **Money is integer pence.** Property tests on every money path — VAT arithmetic, rounding boundaries, date-window edges (Governance §15.1).
- The config is **versioned**: a threshold change is a contract change, and the version is recorded against extractions so historical decisions stay reproducible.
- No AI in this package. Ever. That is the point of it.

## Current state

Skeleton. Lands in S0 before the contract freeze.
