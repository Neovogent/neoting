import type { ProposalKind } from '@neoting/contracts/model';

import { archiveDocumentExecutor } from './archive-document.js';
import {
  type ExecutorRegistry,
  ProposalNotImplementedError,
  type ProposalExecutor,
  type ProposalPayloadMap,
} from './proposal-executor.js';
import { routeDocumentExecutor } from './route-document.js';

/**
 * The registry — issue #81. Total over the contract's `ProposalKind` by the
 * mapped type, so forgetting a kind fails `pnpm typecheck`; the engine's
 * runtime `NT-PRP-001` guard for a wire value outside the enum stays the
 * second line of defence, not the first.
 *
 * Two real executors, five honest holes: a registry with named unimplemented
 * kinds beats five half-executors, and it means the engine (S1) wires against
 * the full enum on day one. Each hole throws `ProposalNotImplementedError`
 * carrying its kind — loudly, before any write.
 *
 * A FACTORY, not a Nest provider: the engine module builds it inside its own
 * `useFactory` and keeps the token out of its public providers, so no executor
 * is reachable from a controller (registry.test.ts asserts the import side of
 * that; the provider side is S1's to keep).
 */
export function buildExecutorRegistry(): ExecutorRegistry {
  return {
    'document.route': routeDocumentExecutor,
    'document.archive': archiveDocumentExecutor,
    'document.update-coding': notImplemented('document.update-coding'),
    'document.move-business': notImplemented('document.move-business'),
    'document.reprocess': notImplemented('document.reprocess'),
    'document.reject': notImplemented('document.reject'),
    'document.split': notImplemented('document.split'),
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
