/**
 * The public seam of validation-dedupe (Boundaries, ./CLAUDE.md).
 *
 * Created when the module's first cross-module consumer arrived — the Review →
 * Approve engine (`modules/approvals`, METH S3 / issue #122), exactly the
 * criterion apps/api/CLAUDE.md sets for growing a seam. What is exported here
 * is the whole of what other modules may depend on; the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 *
 * The surface is the #81 executor contract, deliberately nothing else:
 *
 * - the registry factory and the types the engine wires it with;
 * - the two error shapes the engine must map onto problem+json;
 * - the dedupe follow-up runner and its STRUCTURAL detector seam
 *   (`DedupeDetection` — the engine composes the real detector from
 *   ingestion-routing's own seam, so the two modules never touch internally).
 *
 * NOT exported: the individual executors (a controller reaching one directly
 * is the bypass the registry exists to prevent — executors.test.ts pins the
 * controller side), the state machine, readiness. Those stay internal.
 */
export { buildExecutorRegistry } from './proposals/registry.js';
export {
  type ExecutionInput,
  type ExecutionResult,
  type ExecutorRegistry,
  type FollowUp,
  type ProposalPayloadMap,
  ProposalExecutionRefused,
  ProposalNotImplementedError,
} from './proposals/proposal-executor.js';
export { type DedupeDetection, runDedupeFollowUp } from './proposals/dedupe-follow-up.js';
