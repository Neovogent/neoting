# packages/ui

Shared components built on `packages/tokens` and `packages/component-grammar`. Owned by Shamim.

Not LAW itself — but it consumes two things that are, and it must never work around either.

## Rules

- **Tokens only.** No hex, no arbitrary px, no ad-hoc colour to make contrast pass.
- Anything that renders in chat comes from the **component grammar**. If the grammar lacks a card, that is a G7 contract conversation — not a bespoke component here.
- All four states designed: empty (teaches the next action), loading (skeletons mirroring final layout), error (plain English + `NT-` code), success.
- Full keyboard path, visible focus, focus traps in modals with restore-on-close, `aria-live="polite"` on streaming updates. Error text never colour-only.
- Every user-facing string through next-intl. The lint rule blocks literals.
- Component tests for anything with logic. Visual regression guards the token system and every grammar primitive.

## Density

Two modes: comfortable (default) and compact (accountant power screens). Tables are the product's furniture — sticky headers, keyboard navigation, column pick, and **every table exports**.

## Current state

Skeleton. Populated as `apps/web` needs components; extraction to this package happens on the second use, not the first.
