# packages/tokens — **LAW** (Sprint-0 contract, G7/D15)

Design tokens are the contract between design and code: colour, type scale, spacing (4px grid), radii, elevation, motion. One published package consumed by every surface, so design and code cannot drift.

**No hex codes anywhere else in the repository.** The lint rule is not a suggestion (R8).

## The identity (SoT §14)

Deep forest ground `#041310` · panel green `#0a241d` · mint accent `#7eefd6` · warm off-white ink `#f5efe8`. **Poppins** display, **Inter** UI. Dark and light from v1, system-follow default.

## Colour is semantics

- **amber** = needs you
- **teal** = data in motion
- **red is reserved exclusively for irreversibility** — not for errors, not for emphasis

## Motion, in numbers not adjectives

| Interaction | Duration / easing |
|---|---|
| Micro feedback | 120–150 ms ease-out |
| Card transitions | 200–250 ms gentle spring |
| Screen transitions | 250–300 ms ease-in-out |
| Skeletons | 0 ms in, 1.2 s shimmer |
| Numbers / charts | 400 ms, first paint only |
| Portal capture | < 100 ms |

60 fps on a mid-range Android browser. `prefers-reduced-motion` respected everywhere. Animation never delays data entry. One mover at a time.

## Accessibility

Contrast from tokens ≥ 4.5:1. Never an ad-hoc colour to make something pass.

## Current state

Skeleton. Lands in S0 before the contract freeze, carrying the §13.3 provenance-class language.
