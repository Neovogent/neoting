# packages/component-grammar — **LAW** (Sprint-0 contract, G7/D15)

A fixed set of schema-validated chat primitives with defined behaviour, accessibility and test coverage. **The model emits specs against these schemas — never free-form HTML or JSX.** A spec that fails validation is not rendered; the failure is logged with its trace.

## The primitive that matters most

**Review → Approve.** Every state-changing action in the product goes through it:

1. A review card names the action and its scope. **No Approve button exists yet.**
2. `[Read review]` expands the full detail — every field a rule will set, the verbatim text of every SMS, the itemised list behind a bulk publish — and *only then* does `[Approve]` appear.
3. `[Approve]` executes, and the audit log records who, when, and **what was shown**.

The Approve button can never render before Read-review has been opened, and this is **enforced server-side, not in the UI** (Governance §10). Do not work around the grammar to make a screen easier to build — that mechanism is the product.

## §13.3 obligations carried by every card

- Every displayed value wears its **provenance class**: human-confirmed · deterministic (rule/validator) · AI-suggested with confidence. Visible by default, not on hover.
- Any AI result expands to its working: inputs considered, the rule or guidance that applied, model and confidence, and record references.

## Rules

- If the grammar lacks a card you need, that is a G7 contract conversation — not a one-off `<div>`.
- Changes require `pnpm test:eval` to pass (Governance §14.7) and visual regression to be reviewed.

## Current state

Skeleton. Lands in S0 before the contract freeze.
