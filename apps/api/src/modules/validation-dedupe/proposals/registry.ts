import type { ProposalKind } from '@neoting/contracts/model';

import { DemoSmsSender, type SmsSender } from '../../chase/index.js';
import { archiveDocumentExecutor } from './archive-document.js';
import { chaseSendExecutor } from './chase-send.js';
import { confirmMatchExecutor } from './confirm-match.js';
import {
  type ExecutorRegistry,
  ProposalNotImplementedError,
  type ProposalExecutor,
  type ProposalPayloadMap,
} from './proposal-executor.js';
import { createPublishBatchExecutor, type PublishGateway } from './publish-batch.js';
import { rejectDocumentExecutor } from './reject-document.js';
import { reprocessDocumentExecutor } from './reprocess-document.js';
import { revokeLinkExecutor } from './revoke-link.js';
import { routeDocumentExecutor } from './route-document.js';
import { ruleCreateExecutor } from './rule-create.js';
import { updateCodingExecutor } from './update-coding.js';

/**
 * What the registry cannot build for itself — composed by the ENGINE module
 * (`modules/approvals`) from the owning modules' public seams, exactly as the
 * dedupe detector is.
 *
 * `publishing` is required, not optional-with-a-fallback: a registry that
 * quietly degraded `publish.batch` back to a hole because a call site forgot
 * an argument is the failure mode the mapped-type totality exists to prevent,
 * moved one level out. `smsSender` stays optional because a TRUE safe default
 * exists — `DemoSmsSender` is the only mode in this push (SMS_SENDER=demo);
 * the engine may pass the config-selected sender instead.
 */
export interface ExecutorRegistryDeps {
  /** The SMS sender the `chase.send` executor "sends" through (METH S8). */
  readonly smsSender?: SmsSender;
  /** What `publish.batch` executes through (METH S10) — no safe default exists. */
  readonly publishing: PublishGateway;
}

/**
 * The registry — issue #81. Total over the contract's `ProposalKind` by the
 * mapped type, so forgetting a kind fails `pnpm typecheck`; the engine's
 * runtime `NT-PRP-001` guard for a wire value outside the enum stays the
 * second line of defence, not the first.
 *
 * Ten real executors, two honest holes: a registry with named
 * unimplemented kinds beats half-executors, and it means the engine (METH S3,
 * #122) wires against the full enum on day one. Each hole throws
 * `ProposalNotImplementedError` carrying its kind — loudly, before any write.
 * All four METH Stage 2 kinds (issue #120) now have executors: `chase.send`
 * left the hole list in METH S8, `publish.batch` in METH S10,
 * `bank.confirm-match` in METH S11 and `rule.create` in METH S13 (#142);
 * `document.revoke-link` left it in launch stage A8, and `document.reprocess`
 * and `document.reject` in launch stage A12. The **two** still open are
 * `move-business` and `split`, each of which needs its own issue.
 *
 * A FACTORY, not a Nest provider: the engine module builds it inside its own
 * `useFactory` and keeps the token out of its public providers, so no executor
 * is reachable from a controller (registry.test.ts asserts the import side of
 * that; the provider side is S1's to keep).
 */
export function buildExecutorRegistry(deps: ExecutorRegistryDeps): ExecutorRegistry {
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
    // reprocess and reject landed with stage A12. Both were day-one needs the
    // read surface already advertised — `documents.retryable` offers a Retry
    // that had no executor, and the Rejected view had no way to put a document
    // in it. Neither is a release: both are internal and each undoes the other,
    // so any member of the practice may approve them (D44's compose half).
    'document.reprocess': reprocessDocumentExecutor,
    'document.reject': rejectDocumentExecutor,
    'document.split': notImplemented('document.split'),
    // chase.send landed with METH S8 (#129): the demo sender writes the outbox; no
    // Twilio. The engine may inject the config-selected sender.
    'chase.send': chaseSendExecutor(deps.smsSender ?? new DemoSmsSender()),
    'bank.confirm-match': confirmMatchExecutor,
    // rule.create landed with METH S13 (#142): the chat's rule beat, activated
    // only by the approved proposal it records as `actionProposalId`.
    'rule.create': ruleCreateExecutor,
    // document.revoke-link arrived with the ID LAW batch (S0) ahead of its
    // executor, the same way the METH Stage 2 kinds did, and this is the line
    // that comment named as where it attaches. It landed with stage A8: the
    // capability-URL lane is `modules/exports-public-api`, but the EXECUTOR
    // lives here like every other one — `revoke-link.ts`'s header records why
    // (it would otherwise close a runtime cycle between two public seams, the
    // hazard `publish-batch.ts` documents). Revoking is a real outward act — it
    // turns a working entry inside someone's ledger into a 410 — so it is on
    // the proposal spine rather than behind a DELETE, and no revoke endpoint
    // exists anywhere.
    'document.revoke-link': revokeLinkExecutor,
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
