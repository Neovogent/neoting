import { wrapUntrusted } from '../../../common/untrusted-content.js';
import { type Channel, type ImageNormaliser, mimeForFormat, sanitise, type SanitisationDeps, type VirusScanner } from '../lib/sanitisation/index.js';
import { type DocumentStore, InMemoryDocumentStore } from '../storage/document-store.js';
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
  /**
   * The practice this email arrived for — REQUIRED, and not derivable here.
   *
   * An unrouted document has no business, so the practice is the only tenancy
   * anchor it has: it is what the `documents_tenant_anchor` CHECK accepts, what
   * the RLS practice branch matches on, and what partitions the object key. A
   * document with neither is one nobody can read and nobody can erase.
   *
   * It comes from the RECIPIENT address, which must identify a practice
   * (`doc+<practice>@…`) rather than being a single shared `doc@` — issue #17.
   * Until the SES receipt rules encode that, the caller supplies it.
   */
  readonly practiceId: string;
  /** Sender→workspace map. None exists yet (no DB) — pass empty → everything Unrouted. */
  readonly senderMap?: ReadonlyMap<string, readonly string[]>;
  /** Injected for the sanitisation virus-scan step; defaults to the fixture. */
  readonly scanner?: VirusScanner;
  /**
   * The image normaliser (#23). Threaded through rather than selected inside
   * `sanitise`, because this lane must stay pure and offline-testable — and
   * because a sharp-backed normaliser that nothing injects is dead code that
   * looks live.
   */
  readonly imageNormaliser?: ImageNormaliser;
  /** Object storage for sanitised bytes (#16); defaults to the in-memory fixture. */
  readonly store?: DocumentStore;
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
/**
 * Reduce an attacker-controlled attachment filename to a bare basename — never a
 * path. `../../etc/passwd` → `passwd`, `C:\evil\x.pdf` → `x.pdf`. Kept for
 * display / metadata only; it is never trusted for the file's type.
 */
function safeBasename(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').trim();
  return base === '' || base === '.' || base === '..' ? 'attachment' : base;
}

export async function processEmail(email: ParsedEmail, deps: EmailIntakeDeps): Promise<EmailIntakeResult> {
  const routing = decideRouting(email.from, deps.senderMap ?? new Map<string, readonly string[]>());
  const store = deps.store ?? new InMemoryDocumentStore();
  // Every attachment of one email shares its routing, so one workspace for all.
  const workspaceId = routing.kind === 'matched' ? routing.businessId : null;
  const untrustedBody = wrapUntrusted(`${email.subject}\n\n${email.text}`);
  // NOTE: this is the sender's `Date:` header — their clock, and forgeable. It
  // is the best available today because nothing upstream hands us a real
  // receipt time, and it is harmless while `stale` is hardcoded false. When the
  // S3 trigger lands it knows when SES actually wrote the object; take the
  // receipt time from there and demote this to a fallback. Do not build any
  // freshness or triage decision on it before then.
  const receivedAtSeconds = email.date === null ? 0 : Math.floor(email.date.getTime() / 1000);

  const accepted: AcceptedEmailDocument[] = [];
  const rejected: EmailRejection[] = [];

  for (const [index, attachment] of email.attachments.entries()) {
    // The declared filename is attacker-controlled: reduce it to a basename (never
    // a path), and pass NO name to sanitise so the declared extension cannot sway
    // the type decision. Magic-byte sniffing is the sole authority on what the
    // file is (Shakib's condition) — a part labelled image/jpeg that carries a PDF
    // is accepted as a PDF, not rejected for the mismatch.
    const filename = safeBasename(attachment.filename);
    const sanitisationDeps: Partial<SanitisationDeps> = {
      ...(deps.scanner ? { scanner: deps.scanner } : {}),
      ...(deps.imageNormaliser ? { imageNormaliser: deps.imageNormaliser } : {}),
    };
    const result = await sanitise({ bytes: attachment.bytes, filename: '', channel: EMAIL_CHANNEL }, sanitisationDeps);

    if (!result.ok) {
      rejected.push({ filename, reason: result.rejection.message, code: result.rejection.code });
      continue;
    }

    accepted.push({ filename, detectedType: result.document.detectedType, sha256: result.document.sha256 });

    // Store the SANITISED bytes before enqueuing, so the job never describes a
    // document that exists nowhere. Content-type is the magic-byte-authoritative
    // one, not the sender's declared header.
    const stored = await store.put({
      bytes: result.document.bytes,
      sha256: result.document.sha256,
      contentType: mimeForFormat(result.document.detectedType),
      workspaceId,
      practiceId: deps.practiceId,
    });

    const job: IngestJob = {
      source: 'email',
      // The content hash is IN the key, not a fallback for a missing Message-ID.
      // `idempotencyKey` becomes the BullMQ `jobId`, and BullMQ discards a
      // duplicate jobId SILENTLY — so anything an attacker controls in this
      // string is a way to delete someone else's document. `Message-ID` is a
      // header the sender writes; forging one that collides with a legitimate
      // email's (same index) would drop that email's attachment with no
      // rejection, no log and no trace, which is exactly the silent loss this
      // module's first invariant forbids. Including the sha256 means a
      // collision now requires identical BYTES — which is the only case where
      // dropping is correct, i.e. SES redelivering the same message.
      idempotencyKey: `${email.messageId ?? 'no-message-id'}#${index}#${result.document.sha256}`,
      from: email.from,
      receivedAtSeconds,
      messageType: result.document.detectedType,
      caption: untrustedBody,
      routing,
      stale: false,
      filename,
      sha256: result.document.sha256,
      storageKey: stored.key,
    };
    await deps.queue.enqueue(job);
  }

  return { routing, accepted, rejected };
}
