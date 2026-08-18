/**
 * The public seam of validation-dedupe (Boundaries, ./CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional. Growing
 * this list is a boundary decision — a name here is a name every other module is
 * allowed to build against.
 *
 * TWO cross-module consumers now, each taking exactly what it needs:
 *
 *  - The **Review → Approve engine** (`modules/approvals`, METH S3 / issue #122)
 *    — the #81 executor contract: the registry factory and the types the engine
 *    wires it with; the two error shapes it maps onto problem+json; and the
 *    dedupe follow-up runner with its STRUCTURAL detector seam (`DedupeDetection`
 *    — the engine composes the real detector from ingestion-routing's own seam,
 *    so the two modules never touch internally). The individual executors are
 *    NOT exported: a controller reaching one directly is the bypass the registry
 *    exists to prevent (executors.test.ts pins the controller side).
 *    METH S10 added the second follow-up of the same shape: `PublishGateway`
 *    (publishing's adapter + preview, handed in rather than imported, because
 *    publishing imports THIS module and a runtime import back would close a
 *    cycle), `ExecutorDependencies` and `runPublishFollowUp` — the engine calls
 *    it post-commit, because an external HTTP call must never hold a tenant
 *    transaction open.
 *
 *  - The **extraction lane** (`modules/extraction`, METH Stage 4) — the state
 *    machine and the readiness rule that extraction completion drives
 *    (`transitionDocument`, `resolveProcessedState`), the pipeline step this
 *    module's own TODO named. The composition roots (`worker/`, `app.module.ts`)
 *    and integration tests wire internals directly and are exempt by location.
 *
 *  - The **publishing lane** (`modules/publishing`, METH Stage 10) — grew the
 *    readiness export from `resolveProcessedState` to `evaluateReadiness` +
 *    `ReadinessField`. The publish minimum (Total + Supplier + Category) is
 *    the SAME rule as readiness, and `NT-PUB-001` has to name the fields that
 *    are missing, which only `evaluateReadiness` returns. Publishing asking
 *    the question its own way is how a document ends up Ready on the inbox and
 *    unpublishable in the batch.
 */
export { buildExecutorRegistry, type ExecutorDependencies } from './proposals/registry.js';
export { type PublishGateway } from './proposals/publish-batch.js';
export { runPublishFollowUp } from './proposals/publish-follow-up.js';
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
export {
  type DocumentTransition,
  IllegalDocumentTransition,
  StaleDocumentState,
  transitionDocument,
} from './document-state.js';
export {
  evaluateReadiness,
  type Readiness,
  type ReadinessField,
  type ReadinessInput,
  resolveProcessedState,
} from './readiness.js';
