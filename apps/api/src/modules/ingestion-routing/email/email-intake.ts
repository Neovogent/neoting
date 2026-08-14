import { wrapUntrusted } from '../../../common/untrusted-content.js';
import { type Channel, sanitise, type VirusScanner } from '../lib/sanitisation/index.js';
import type { IngestJob, IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { decideRouting, type RoutingDecision } from '../webhooks/whatsapp/routing.js';
import type { ParsedEmail } from './parsed-email.js';

// Email to doc@ is a client channel — 25 MB cap (SoT §4 Stage 1). The issue
// writes it 'EMAIL'; the value is lower-case here to match the existing
// 'client' / 'vault' / … channel convention.
const EMAIL_CHANNEL: Channel = 'email';

/** A refused attachment, kept visible with its reason (never all-or-nothing). */
export interface EmailRejection {
  readonly filename: string;
  readonly reason: string; // plain English, safe to show the submitter
  readonly code: string; // the NT-ING-* wire code
}

export interface AcceptedEmailDocument {
  readonly filename: string;
  readonly detectedType: string;
  readonly sha256: string;
}

export interface EmailIntakeResult {
  readonly routing: RoutingDecision;
  readonly accepted: readonly AcceptedEmailDocument[];
  readonly rejected: readonly EmailRejection[];
}

export interface EmailIntakeDeps {
  readonly queue: IngestQueue;
  /** Sender→workspace map. None exists yet (no DB) — pass empty → everything Unrouted. */
  readonly senderMap?: ReadonlyMap<string, readonly string[]>;
  /** Injected for the sanitisation virus-scan step; defaults to the fixture. */
  readonly scanner?: VirusScanner;
}

/**
 * Process one parsed inbound email (SoT §4 Stage 1, email lane):
 *
 *  1 route by sender identity against the supplied map — empty today, so every
 *    email lands Unrouted (never silently dropped);
 *  2 wrap the subject + body as `<untrusted_content>` (§9.6) — an email body is
 *    data, never instructions;
 *  3 push EACH attachment through `sanitise()` independently on the email
 *    channel: a rejection is visible with its reason and does not discard the
 *    rest — three good attachments and one password-protected PDF is three
 *    accepted documents and one visible rejection;
 *  4 enqueue every accepted document through the existing `IngestQueue` (the
 *    producer attaches the traceId from the request context, as the webhook does).
 *
 * Pure library — no S3, no network, no database (persistence is blocked on
 * scopedDb). The S3-event trigger is Terraform (Shakib's).
 */
export async function processEmail(email: ParsedEmail, deps: EmailIntakeDeps): Promise<EmailIntakeResult> {
  const routing = decideRouting(email.from, deps.senderMap ?? new Map<string, readonly string[]>());
  const untrustedBody = wrapUntrusted(`${email.subject}\n\n${email.text}`);
  const receivedAtSeconds = email.date === null ? 0 : Math.floor(email.date.getTime() / 1000);

  const accepted: AcceptedEmailDocument[] = [];
  const rejected: EmailRejection[] = [];

  let index = 0;
  for (const attachment of email.attachments) {
    const result = await sanitise(
      { bytes: attachment.bytes, filename: attachment.filename, channel: EMAIL_CHANNEL },
      deps.scanner ? { scanner: deps.scanner } : {},
    );

    if (!result.ok) {
      rejected.push({ filename: attachment.filename, reason: result.rejection.message, code: result.rejection.code });
      index += 1;
      continue;
    }

    accepted.push({
      filename: attachment.filename,
      detectedType: result.document.detectedType,
      sha256: result.document.sha256,
    });

    const job: IngestJob = {
      source: 'email',
      idempotencyKey: `${email.messageId ?? result.document.sha256}#${index}`,
      from: email.from,
      receivedAtSeconds,
      messageType: result.document.detectedType,
      caption: untrustedBody,
      routing,
      stale: false,
      filename: attachment.filename,
      sha256: result.document.sha256,
    };
    await deps.queue.enqueue(job);
    index += 1;
  }

  return { routing, accepted, rejected };
}
