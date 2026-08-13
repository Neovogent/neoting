# apps/web — Next.js (App Router)

Two route groups: `(workspace)` the practice app, `(portal)` the public OTP portal and onboarding.

## The frontend ten (Guideline §7.4)

1. Server Components by default; `"use client"` on leaf components only, and only for interactivity.
2. **Tokens only** — no hex, no arbitrary px.
3. Chat renders **component-grammar primitives only**. If the grammar lacks a card, that is a G7 conversation, not a one-off `<div>`.
4. Every user-facing string through next-intl (en-GB). The lint rule blocks literals.
5. All four states per screen: empty (teaches the next action), loading (skeletons, no spinners on primary surfaces), error (plain English + `NT-` code), success.
6. Accessibility on every PR: full keyboard path, visible focus, `aria-live="polite"` on chat updates, contrast from tokens, error text never colour-only. Run axe locally before requesting review.
7. Motion by the numbers (tokens `CLAUDE.md`).
8. **< 250 KB gzipped JS per route.** The `(portal)` group is the lightest surface in the product and takes no heavy dependencies, ever — it must load fast on a bad connection in a car park.
9. Optimistic UI with rollback toasts. The Approve button literally cannot render before Read-review opens — the grammar enforces it; don't work around it.
10. Component tests for anything with logic.

## Data

`packages/contracts` generates the typed client and the MSW handlers. **Never hand-write an API type; never `fetch` raw in a component.** Data flows through the generated client and TanStack Query.

`NEXT_PUBLIC_API_MODE`: `mock` (MSW, the default and what previews use) or `local` (the NestJS API on localhost).

## Previews

Vercel previews are a **viewing tool, not hosting** (G6). Synthetic data only. **Deployment Protection must be on before the first preview ships** — an unprotected preview URL is a leaked credential and an instant reject (G10/R16).
