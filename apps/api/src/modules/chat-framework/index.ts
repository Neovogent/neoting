/**
 * `chat-framework`'s public seam.
 *
 * The module had no `index.ts` because nothing outside it needed anything: the
 * chat runtime is self-contained and `no-cross-module-internals` (see
 * `apps/api/eslint.config.js`) makes reaching past a seam a lint error, so the
 * absence was never felt.
 *
 * `modules/extraction` now needs it, and for the one reason a seam should be
 * opened: **the model pin is a single source of truth and must stay one**
 * (Governance §9.1 — "model IDs are pinned here and imported everywhere, never
 * hardcoded in a prompt, a service or a doc"). The alternative was a second
 * model constant living in `extraction`, which is exactly the silent-swap
 * hazard §9.1 exists to prevent — two files that can disagree about which model
 * generation Neoting runs.
 *
 * ⚠ THIS SEAM CARRIES CONFIGURATION, NOT BEHAVIOUR. It deliberately exports the
 * model/task maps and their types and nothing else — no provider, no service,
 * no client. A caller that wants to INVOKE a model does not belong here; it
 * belongs behind its own adapter, the way `BedrockExtractor` has its own. Adding
 * a runtime export to this file would turn a config lookup into a dependency on
 * the chat runtime, and the two have no reason to be coupled.
 */

export { MODELS, TASKS, DEGRADE_CHAIN, costPence } from './models.js';
export type { Tier, Effort, TaskConfig, TaskName } from './models.js';

/**
 * ⚠ `costPence` IS CONFIGURATION, and it is on this seam for the same reason
 * the model pin is (S5, 27 Aug 2026). It is a pure function over
 * `TIER_RATES_PENCE_PER_MTOK` — no client, no connection, no I/O — and
 * `models.ts` calls that table "the one place the rates live". Extraction now
 * meters its own spend against the same per-firm ceiling as chat, and the
 * alternative was a second copy of Bedrock's price list inside `extraction`:
 * two files that can disagree about what a token costs, which is the same class
 * of drift §9.1 forbids for the model id itself.
 *
 * The ledger those pence are written to is NOT here — it is
 * `common/ai-budget.ts`, precisely because it is behaviour rather than
 * configuration. See the note at the top of that file.
 */
