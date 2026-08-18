/**
 * The public seam of validation-dedupe (Boundaries, ./CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional. Growing
 * this list is a boundary decision — a name here is a name every other module is
 * allowed to build against.
 *
 * First consumer: the extraction lane (METH Stage 4). Extraction completion is
 * the pipeline step this module's own TODO named ("wire the pipeline onto
 * `resolveProcessedState` when extraction lands"), so it needs the state machine
 * and the readiness rule — and nothing else. The composition roots
 * (`worker/`, `app.module.ts`) and integration tests wire internals directly and
 * are exempt by location.
 */
export {
  type DocumentTransition,
  IllegalDocumentTransition,
  StaleDocumentState,
  transitionDocument,
} from './document-state.js';
export { type Readiness, type ReadinessInput, resolveProcessedState } from './readiness.js';
