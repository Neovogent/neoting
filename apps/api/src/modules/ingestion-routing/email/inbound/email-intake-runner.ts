/**
 * The handler that gets raw MIME from a source into the finished `processEmail`
 * lane (issue #78). `processEmail` was written, tested and idle — nothing called
 * it. This is the caller: parse → resolve the practice from the recipient →
 * `processEmail`, with the `traceId` born HERE so it survives into every enqueued
 * job (the BullMQ producer reads it from the trace context, exactly as the
 * WhatsApp webhook path does).
 *
 * It runs in a worker/poller, not an HTTP request — inbound email is the async
 * spine's job, and a per-email failure must cost one email, not the loop.
 */

import { randomUUID } from 'node:crypto';

import { runWithTrace } from '../../../../common/trace/trace-context.js';
import type { PerceptualHasher } from '../../lib/dedupe/perceptual-hash.js';
import type { DocumentGuard, ImageNormaliser, VirusScanner } from '../../lib/sanitisation/index.js';
import type { DocumentStore } from '../../storage/document-store.js';
import type { IngestQueue } from '../../webhooks/whatsapp/ingest-queue.js';
import { type EmailIntakeDeps, type EmailIntakeResult, processEmail } from '../email-intake.js';
import type { EmailParser } from '../email-parser.js';
import type { ParsedEmail } from '../parsed-email.js';
import type { EmailSource, InboundRawEmail } from './email-source.js';
import { resolvePracticeFromRecipient } from './recipient-practice.js';
import type { SenderMapLoader } from './sender-map.js';

export interface EmailIntakeRunnerDeps {
  readonly parser: EmailParser;
  readonly queue: IngestQueue;
  readonly logger: { log(message: string): void; warn(message: string): void };
  /**
   * Loads the sender→workspace map for the RESOLVED practice (METH Stage 5).
   * The map is per-practice — a sender is only recognised against the contacts
   * of the practice this email was delivered to — so it cannot be resolved until
   * `practiceId` is known, which is why this is a loader and not a static map.
   * Absent → an empty map, i.e. today's behaviour: everything Unrouted.
   */
  readonly senderMapLoader?: SenderMapLoader;
  readonly store?: DocumentStore;
  readonly scanner?: VirusScanner;
  readonly imageNormaliser?: ImageNormaliser;
  readonly documentGuard?: DocumentGuard;
  readonly perceptualHasher?: PerceptualHasher;
  /** Seam: resolve the practice from the recipient; defaults to plus-address parsing. */
  readonly resolvePractice?: (recipient: string | null) => string | null;
  /** Seam: mint the trace id born at the trigger; defaults to a random uuid. */
  readonly newTraceId?: () => string;
}

export type EmailIntakeOutcome =
  | { readonly status: 'processed'; readonly result: EmailIntakeResult; readonly practiceId: string }
  | { readonly status: 'unresolved-recipient'; readonly recipient: string | null }
  | { readonly status: 'parse-error'; readonly error: string };

/** Process ONE inbound raw email. Returns an outcome; the caller decides ack. */
export async function runEmailIntake(raw: InboundRawEmail, deps: EmailIntakeRunnerDeps): Promise<EmailIntakeOutcome> {
  let email: ParsedEmail;
  try {
    // Hostile MIME is parsed behind the interface (postal-mime); a parse failure
    // is this one email's problem, never the poll loop's.
    email = await deps.parser.parse(raw.raw);
  } catch (error) {
    return { status: 'parse-error', error: error instanceof Error ? error.message : String(error) };
  }

  // The envelope recipient (what SES actually delivered to) wins; the `To` header
  // is a fallback. Either way the plus tag is the anchor.
  const recipient = raw.envelopeRecipient ?? email.to;
  const resolve = deps.resolvePractice ?? resolvePracticeFromRecipient;
  const practiceId = resolve(recipient);
  if (practiceId === null) {
    // ⚠ Not dropped. A document with no practice has no tenancy anchor and cannot
    // be persisted — but "never silently dropped" is this module's first
    // invariant, so it is left in the source (visible, re-pollable) and the caller
    // logs it loudly. The real mapping is issue #17.
    return { status: 'unresolved-recipient', recipient };
  }

  const traceId = deps.newTraceId?.() ?? randomUUID();

  // Route by sender against THIS practice's contacts. The loader reads the map
  // now that `practiceId` is known — a sender is recognised only against the
  // practice the email was delivered to, never across practices. No loader
  // injected → an empty map, i.e. the pre-Stage-5 behaviour (everything
  // Unrouted). An unregistered sender simply is not a key, so it stays Unrouted.
  const senderMap = deps.senderMapLoader ? await deps.senderMapLoader.load(practiceId) : undefined;

  // ⚠ EMAIL BODY / SUBJECT ARE UNTRUSTED and stay wrapped inside `processEmail`;
  // nothing here unwraps or logs them. `receivedAtSeconds` comes from the source's
  // real observation time, not the sender's `Date:` header.
  const emailDeps: EmailIntakeDeps = {
    queue: deps.queue,
    practiceId,
    receivedAtSeconds: raw.receivedAtSeconds,
    ...(senderMap ? { senderMap } : {}),
    ...(deps.store ? { store: deps.store } : {}),
    ...(deps.scanner ? { scanner: deps.scanner } : {}),
    ...(deps.imageNormaliser ? { imageNormaliser: deps.imageNormaliser } : {}),
    ...(deps.documentGuard ? { documentGuard: deps.documentGuard } : {}),
    ...(deps.perceptualHasher ? { perceptualHasher: deps.perceptualHasher } : {}),
  };

  const result = await runWithTrace(traceId, () => processEmail(email, emailDeps));
  deps.logger.log(
    `email ${raw.id} → practice ${practiceId}: ${result.accepted.length} accepted, ${result.rejected.length} rejected (trace=${traceId})`,
  );
  // Each rejection with its reason, BEFORE the caller acks and deletes the
  // source email. The count alone survived the production path while the
  // per-attachment filename/code/reason — the thing a human needs to tell a
  // client what to re-send — was computed, tested, and then discarded. The
  // filename is already `safeBasename`d and the reason is the pipeline's own
  // plain-English sentence, so neither line echoes raw sender content.
  for (const rejection of result.rejected) {
    deps.logger.warn(
      `email ${raw.id}: attachment "${rejection.filename}" rejected ${rejection.code} — ${rejection.reason} (trace=${traceId})`,
    );
  }
  return { status: 'processed', result, practiceId };
}

export interface DrainSummary {
  readonly processed: number;
  readonly unresolved: number;
  readonly failed: number;
}

/**
 * Poll a source once and run every email through {@link runEmailIntake}, acking
 * only the ones that were processed. Unresolved / unparseable emails are left in
 * the source (never dropped) and warned about ONCE per id, so a stuck email does
 * not re-warn on every poll.
 */
function warnOnce(logger: { warn(message: string): void }, warned: Set<string>, id: string, message: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  logger.warn(message);
}

export async function drainEmailSource(
  source: EmailSource,
  deps: EmailIntakeRunnerDeps & { readonly warned?: Set<string> },
): Promise<DrainSummary> {
  const emails = await source.poll();
  const warned = deps.warned ?? new Set<string>();
  let processed = 0;
  let unresolved = 0;
  let failed = 0;

  for (const raw of emails) {
    let outcome: EmailIntakeOutcome;
    try {
      outcome = await runEmailIntake(raw, deps);
    } catch (error) {
      // ⚠ A throw here — object storage blipping on store.put, Redis/BullMQ down
      // on enqueue, any unexpected fault — must cost ONE email, never the batch.
      // Without this, an un-acked throwing email at the head of the poll window
      // re-throws on every tick and starves every email behind it: the
      // poison-wedges-the-loop failure this lane exists to prevent. It is left in
      // the source (never dropped) so a transient fault retries, and warned once
      // so a deterministic one does not spam the log.
      failed += 1;
      warnOnce(
        deps.logger,
        warned,
        raw.id,
        `email ${raw.id}: processing threw, left in the source for retry — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (outcome.status === 'processed') {
      processed += 1;
      try {
        await source.ack(raw.id);
      } catch (error) {
        // The email was already handed off; failing to delete it only risks a
        // re-process, which is idempotent downstream (the derived document id).
        // Warn, do not abort the batch.
        deps.logger.warn(
          `email ${raw.id}: processed but ack failed (${error instanceof Error ? error.message : String(error)}) — may be re-processed, which is idempotent`,
        );
      }
      continue;
    }

    // Unresolved and unparseable emails can NEVER succeed on a re-poll — an
    // address with no plus tag does not grow one, and broken MIME does not
    // heal. "Left in the source" was a starvation bug: the S3 source lists a
    // bounded window, a stuck email never left it, and plain mail to `doc@`
    // is unresolvable BY DESIGN — so ordinary traffic filled the window until
    // no new mail was ever listed again, while the drain reported clean.
    // Quarantine moves them OUT of the window without dropping them (S3:
    // `unroutable/` prefix; MailHog: suppressed locally, still in its UI).
    if (outcome.status === 'unresolved-recipient') {
      unresolved += 1;
      await quarantineOrLeave(
        source,
        deps.logger,
        raw.id,
        `email ${raw.id}: no practice for recipient ${outcome.recipient ?? '(none)'} — quarantined, not dropped; set the doc+<practice> mapping (#17)`,
      );
      continue;
    }

    failed += 1;
    await quarantineOrLeave(source, deps.logger, raw.id, `email ${raw.id}: could not parse — quarantined, not dropped (${outcome.error})`);
  }

  return { processed, unresolved, failed };
}

/**
 * Quarantine, or leave in the source when even that fails (S3 blipping on the
 * copy). Leaving it is safe — the next drain retries the quarantine — it just
 * keeps occupying a window slot until the copy succeeds, so the failure is
 * warned every time rather than once.
 */
async function quarantineOrLeave(
  source: EmailSource,
  logger: { warn(message: string): void },
  id: string,
  message: string,
): Promise<void> {
  try {
    await source.quarantine(id);
    logger.warn(message);
  } catch (error) {
    logger.warn(
      `email ${id}: quarantine failed (${error instanceof Error ? error.message : String(error)}) — left in the source; the next drain retries`,
    );
  }
}
