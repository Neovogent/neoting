/**
 * `DemoXeroAdapter` (METH Stage 10): a deterministic fixture ledger behind the
 * real `LedgerAdapter` interface. Same document, same external ref; one
 * flagged supplier fails its first attempt and succeeds on retry. The demo is
 * a real system with a fake vendor, not a fake system.
 *
 * // DEMO-MOCK: Xero OAuth + SDK adapter. Nothing here opens a socket.
 */

import { createHash } from 'node:crypto';

import {
  LEDGER_REJECTED,
  type LedgerAdapter,
  type LedgerPublishResult,
  type PublishBillRequest,
} from './ledger-adapter.js';

/** Stamped nowhere yet — named so the real adapter has something to differ from. */
export const DEMO_LEDGER_KIND = 'demo-xero';

/**
 * Simulated per-item latency, so a publish batch feels like a batch and the
 * QUEUED → SUCCEEDED beat renders truthfully (the mocking doctrine's
 * latency-honesty). METH's sketch said 1–2 s per item; this is deliberately
 * lower.
 *
 * ⚠ THE NUMBER IS A LOAD-BEARING DECISION, not a taste call. A batch is up to
 * 500 items (the contract), so 1 s per item is over eight minutes of adapter
 * time for one approval. That is survivable ONLY because this runs
 * post-commit, outside the effect transaction — at 800 ms it is 6m40s of held
 * row locks if anyone ever moves it back inside. Small default, injectable
 * clock, and the reasoning in this module's CLAUDE.md.
 */
export const DEMO_PER_ITEM_DELAY_MS = 800;

/**
 * The scripted failure (METH Stage 10: "deterministic failure for one flagged
 * seed document" AND "retry succeeds second time"). Those two only reconcile
 * if the flag is on the ATTEMPT, not just the document — hence
 * {@link PublishBillRequest.attempt}.
 *
 * Keyed on the supplier name rather than a seed column, because `prisma/` is
 * LAW and `prisma/seed.ts` is being edited on another branch — a marker
 * derived from data the executor already reads collides with neither. The
 * seeded document it hits is **`doc_007` — British Gas, £412.66 gross, READY,
 * Utilities, American Burger (`biz_burger`)**, one of that business's three
 * publishable Ready documents, so a demo batch of three shows two succeed and
 * one fail.
 *
 * Compared after {@link normaliseSupplier}, so casing and punctuation drift in
 * an extraction cannot silently un-flag the demo.
 */
export const DEMO_FAILING_SUPPLIERS: readonly string[] = ['british gas'];

export interface DemoXeroAdapterOptions {
  /** Zero disables the delay entirely — what the unit suite uses. */
  readonly perItemDelayMs?: number;
  /** Injected clock, same shape as `PrismaExtractionStep`'s, so tests never wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class DemoXeroAdapter implements LedgerAdapter {
  private readonly perItemDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DemoXeroAdapterOptions = {}) {
    this.perItemDelayMs = options.perItemDelayMs ?? DEMO_PER_ITEM_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async publishBill(request: PublishBillRequest): Promise<LedgerPublishResult> {
    if (this.perItemDelayMs > 0) await this.sleep(this.perItemDelayMs);

    if (isScriptedFailure(request)) {
      // Transient BY DESIGN: the demo retries this exact document and it must
      // then succeed, so the reason a human reads has to be one a retry could
      // plausibly clear. A coding-shaped rejection ("no valid VAT treatment")
      // would be a lie — nothing about the document changed between attempts.
      return {
        ok: false,
        failure: {
          code: LEDGER_REJECTED,
          message: `Xero rejected the bill: the supplier contact for ${request.supplierName} was locked by another update in progress. Nothing was posted — publish it again.`,
          retryable: true,
        },
      };
    }

    return {
      ok: true,
      externalRef: demoExternalRef(request.documentId),
      // No attachment reference means nothing was sent, and the row says so
      // rather than claiming a source image that never travelled.
      attachmentSent: request.attachment !== null,
    };
  }
}

/**
 * `XERO-INV-####`, derived from the document id — same document, same ref, on
 * every attempt and every seeded database (the mocking doctrine's determinism).
 * It deliberately does NOT vary with the attempt: a republish that minted a
 * second reference is precisely the double-post `publishes.idempotency_key`
 * exists to prevent.
 *
 * Four digits is 10,000 refs, which will collide long before a real ledger
 * would. That is fine for a demo estate of forty documents and is not a claim
 * about the real adapter, which returns Xero's own identifier.
 */
export function demoExternalRef(documentId: string): string {
  const digest = createHash('sha256').update(documentId).digest();
  return `XERO-INV-${String(digest.readUInt32BE(0) % 10_000).padStart(4, '0')}`;
}

/** Flagged supplier + first attempt. Anything else — including its retry — succeeds. */
export function isScriptedFailure(request: Pick<PublishBillRequest, 'attempt' | 'supplierName'>): boolean {
  // `<= 1` rather than `=== 1`: a caller that has not counted prior attempts
  // yet passes 0 or 1, and both mean "this is the first go". Attempt 2+ is a
  // retry and always lands.
  if (request.attempt > 1) return false;
  return DEMO_FAILING_SUPPLIERS.includes(normaliseSupplier(request.supplierName));
}

/** Lowercase, punctuation collapsed to single spaces, trimmed. `British Gas` → `british gas`. */
function normaliseSupplier(supplierName: string): string {
  return supplierName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
