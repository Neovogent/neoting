import type { ProposalKind } from '@neoting/contracts/model';

import { archiveDocumentExecutor } from './archive-document.js';
import {
  type ExecutorRegistry,
  ProposalNotImplementedError,
  type ProposalExecutor,
  type ProposalPayloadMap,
} from './proposal-executor.js';
import { createPublishBatchExecutor, type PublishGateway } from './publish-batch.js';
import { routeDocumentExecutor } from './route-document.js';
import { updateCodingExecutor } from './update-coding.js';

/**
 * What the registry cannot build for itself — composed by the ENGINE module
 * (`modules/approvals`) from the owning modules' public seams, exactly as the
 * dedupe detector is.
 *
 * Required, not optional-with-a-fallback: a registry that quietly degraded
 * `publish.batch` back to a hole because a call site forgot an argument is the
 * failure mode the mapped-type totality exists to prevent, moved one level out.
 */
export interface ExecutorDependencies {
  readonly publishing: PublishGateway;
}

/**
 * The registry — issue #81. Total over the contract's `ProposalKind` by the
 * mapped type, so forgetting a kind fails `pnpm typecheck`; the engine's
 * runtime `NT-PRP-001` guard for a wire value outside the enum stays the
 * second line of defence, not the first.
 *
 * Four real executors, seven honest holes: a registry with named
 * unimplemented kinds beats half-executors, and it means the engine (METH S3,
 * #122) wires against the full enum on day one. Each hole throws
 * `ProposalNotImplementedError` carrying its kind — loudly, before any write.
 * The remaining METH Stage 2 kinds (issue #120) are holes until their stages
 * land executors: chase.send (S8), bank.confirm-match (S11), rule.create (S13).
 * `publish.batch` was one of them until METH S10.
 *
 * A FACTORY, not a Nest provider: the engine module builds it inside its own
 * `useFactory` and keeps the token out of its public providers, so no executor
 * is reachable from a controller (registry.test.ts asserts the import side of
 * that; the provider side is S1's to keep).
 */
export function buildExecutorRegistry(deps: ExecutorDependencies): ExecutorRegistry {
  return {
    'document.route': routeDocumentExecutor,
    'document.archive': archiveDocumentExecutor,
    'document.update-coding': updateCodingExecutor,
    // The one executor built as a FACTORY, because it is the one with a
    // dependency it must not import: publishing imports this module, so
    // importing publishing back would close a cycle between two public seams
    // (publish-batch.ts's header has the full reasoning).
    'publish.batch': createPublishBatchExecutor(deps.publishing),
    'document.move-business': notImplemented('document.move-business'),
    'document.reprocess': notImplemented('document.reprocess'),
    'document.reject': notImplemented('document.reject'),
    'document.split': notImplemented('document.split'),
    'chase.send': notImplemented('chase.send'),
    'bank.confirm-match': notImplemented('bank.confirm-match'),
    'rule.create': notImplemented('rule.create'),
  };
}

function notImplemented<K extends ProposalKind>(kind: K): ProposalExecutor<K, ProposalPayloadMap[K]> {
  return {
    kind,
    execute: async () => {
      throw new ProposalNotImplementedError(kind);
    },
  };
}
