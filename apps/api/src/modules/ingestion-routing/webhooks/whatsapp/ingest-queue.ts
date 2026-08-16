import type { RoutingDecision } from './routing.js';

/**
 * A document handed off from the webhook to the async ingest pipeline. The
 * caption is ALREADY wrapped in `<untrusted_content>` by the time it lands here
 * (Governance §9.6). `idempotencyKey` is the `wamid`, per the async-spine rule
 * in apps/api/CLAUDE.md.
 */
export interface IngestJob {
  readonly source: 'whatsapp' | 'email';
  readonly idempotencyKey: string;
  readonly from: string;
  readonly receivedAtSeconds: number;
  readonly messageType: string;
  readonly caption: string | null;
  readonly routing: RoutingDecision;
  /**
   * Triage flag, not a gate: the message was correctly signed but its timestamp
   * is outside the ±5-minute window (or unparseable). It is still enqueued —
   * age is never a reason to drop a signed document — and marked for review.
   * Email attachments are always fresh (`false`).
   */
  readonly stale: boolean;
  /** Attachment filename — present for email attachments, absent for WhatsApp. */
  readonly filename?: string;
  /** SHA-256 of the sanitised bytes — present when the document is already in hand (email). */
  readonly sha256?: string;
  /**
   * Object-storage key for the sanitised bytes (#16), present when the document
   * is already stored (email). The worker fetches the bytes from here; without
   * it the job would describe a document that exists nowhere.
   */
  readonly storageKey?: string;
  /**
   * The practice this document arrived for (#20) — the tenancy anchor an
   * unrouted document has instead of a business. Present for email; the worker
   * cannot persist without it, and cannot invent it.
   */
  readonly practiceId?: string;
  /** Magic-byte-authoritative MIME of the sanitised bytes (#20), for `documents.mime_type`. */
  readonly mimeType?: string;
  /** Byte length of the sanitised bytes (#20), for `documents.byte_size`. */
  readonly byteSize?: number;
  /**
   * dHash of the sanitised image bytes (#40) → `documents.perceptual_hash`, and
   * the near-duplicate net. Present only for image documents the hasher could
   * decode; absent for PDFs, so the column stays null and the byte-hash net covers
   * them.
   */
  readonly perceptualHash?: string;
  /**
   * Meta media id (#79) — present for WhatsApp media messages, absent for text
   * and for email (which already carries its bytes). The worker resolves it to
   * bytes through `MediaFetcher`; without it a WhatsApp job describes a document
   * that exists nowhere and can never be retrieved.
   */
  readonly mediaId?: string;
  /**
   * Which of OUR numbers took delivery (`value.metadata.phone_number_id`). Kept
   * on the job as the evidence behind `practiceId`: the anchor was derived from
   * this, and when a real `phone_number_id → practice` lookup lands it is the
   * field it reads.
   */
  readonly phoneNumberId?: string;
}

/**
 * The queue the webhook enqueues to. BullMQ is deliberately NOT wired yet
 * (issue #9: no Redis, no queue infra) — this interface with a fixture keeps the
 * webhook shippable and its tests offline. The real BullMQ producer drops in
 * behind this token later (the same DI pattern as the sanitisation scanner).
 */
export interface IngestQueue {
  enqueue(job: IngestJob): Promise<void>;
}

/** Fixture queue: records what would have been enqueued, for tests and local dev. */
export class FixtureIngestQueue implements IngestQueue {
  readonly enqueued: IngestJob[] = [];

  async enqueue(job: IngestJob): Promise<void> {
    this.enqueued.push(job);
  }
}
