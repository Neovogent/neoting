/**
 * The chase, delivered by EMAIL — launch stage A13.
 *
 * Chasing was SMS-only and Initial Delivery cut SMS (D40's sibling), which left
 * the chase lane with no transport at all: `SMS_SENDER=demo` writes an outbox
 * row and sends nothing. This is the delivery, and it lands **behind the same
 * `SmsSender` seam** the `chase.send` executor already calls — config, not
 * import (`select-sms-sender.ts`). The executor is unchanged, and deliberately
 * so: an executor performs one effect and decides nothing, least of all which
 * wire its effect leaves by.
 *
 * ## The reviewed bytes are the sent bytes
 *
 * ⚠ **The body is `message.body`, verbatim, and nothing here composes.** That
 * string was produced by `composeChaseSms` at proposal time, stored on the
 * proposal, rendered byte-for-byte by `approvals/render-summary.ts` under
 * *"SMS, exactly as it will send"*, hashed into `rendered_summary_hash`, and
 * written to `chase_messages.body` by the executor. This sender copies it into
 * the email body and stamps the send onto the same row. There is no second
 * composition, no re-render, no template — so the guarantee cannot drift here,
 * because there is nothing here that could drift.
 *
 * `notifications`' own `composeDocumentRequest` is a genuinely nicer *email*:
 * a tick-off list rather than a run-on sentence. It is **deliberately not
 * used**. It re-renders from the items, and a re-rendering is by definition not
 * the thing the human approved. Adopting it means putting its output in the
 * payload at proposal time so review shows it — a change to the chase template
 * and the Review → Approve path, which is Shakib's call, not a stage's.
 *
 * ## The subject is a constant, and that is the point
 *
 * {@link CHASE_EMAIL_SUBJECT} interpolates nothing. A subject is the one part of
 * the message the review never showed — the payload has no subject field and
 * `packages/contracts` is LAW — so anything variable in it would be unreviewed
 * text sent to a client. Keeping it a compile-time constant also keeps the
 * blast radius of untrusted content where it belongs: a supplier name and a
 * bank descriptor are client-controlled strings, they already sit inside the
 * reviewed body, and they never reach the envelope.
 *
 * ## Who it is addressed to
 *
 * The address is resolved from the chase's **named recipient contact**, and a
 * chase that names none refuses. It is not looked up "the primary contact for
 * this client", because that would be the transport choosing a recipient the
 * reviewer never saw. D45 says the same thing from the inbound side: known
 * senders only, and a registered address is what makes one known.
 *
 * ⚠ **Flagged, not hidden:** review renders `recipientE164`, a phone number,
 * because that is the field the contract's `ChaseSendPayload` requires. Under
 * this transport the reviewer therefore approves a send to a *contact* whose
 * email address they were not shown. Closing that fully needs either a subject
 * and address on the payload (LAW) or a render that names the contact
 * (`modules/approvals`) — both outside stage A13's fence, both reported.
 *
 * ## No `sms_log` row, on purpose
 *
 * `sms_log.to_e164` is a required column and `SmsOutboxMessage.toE164` is a
 * required contract field. Writing an email send there means inventing a phone
 * number for a message that never went to one, and the SMS-outbox screen would
 * then show an SMS nobody sent. The durable record of a chase email is the
 * `chase_messages` row — the same row that carries the exact text — stamped
 * with `channel: 'email'`, the provider's message id and `sentAt`.
 */

import { HttpStatus, Logger } from '@nestjs/common';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
// ⚠ TYPE-ONLY, all of it. `notifications/email-copy.ts` imports `chase/index.ts`
// for `formatGbp`/`formatDay`, so a VALUE import of the notifications seam from
// anything `chase/index.ts` re-exports would close a runtime cycle between two
// public seams — the hazard `validation-dedupe/proposals/publish-batch.ts` and
// `revoke-link.ts` each record refusing to create. Type imports are erased, so
// they close nothing; the concrete transport is handed in by the caller
// (`select-sms-sender.ts`, which resolves it lazily for the same reason).
import type {
  EmailAddress,
  EmailRateLimiter,
  EmailSender,
  OutboundEmail,
} from '../notifications/index.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

/**
 * The subject line, for every chase email ever sent. No interpolation — see the
 * header. It states what the message is and who it is from in the only terms
 * that are true for every client: their accountant asked them for a document.
 *
 * D42: nothing here may imply a ledger. It does not.
 */
export const CHASE_EMAIL_SUBJECT = 'A document request from your accountant';

/**
 * The `chase_messages.channel` value an email send stamps. The executor writes
 * the row as `'sms'` (it cannot know the transport, and must not); the sender
 * corrects it to what actually carried the message, in the same transaction.
 * `ChaseMessage.channel` is a free string in the contract, so `'email'` is a
 * legal value and the chase detail reads honestly.
 */
export const CHASE_EMAIL_CHANNEL = 'email';

/** The delivery state a completed send records — the `DemoSmsSender` vocabulary. */
const DELIVERY_STATE_SENT = 'sent';

/**
 * How the sender obtains its transport and its limiter.
 *
 * A factory rather than the objects themselves, and async, because the only
 * static path to them closes the seam cycle described in the header. Resolved
 * once, on the first send, and memoised — so a process configured for email
 * that never sends a chase opens no Redis connection and constructs no SES
 * client. Tests hand in a fixture directly and the factory never runs.
 */
export interface ChaseEmailTransport {
  readonly sender: EmailSender;
  readonly limiter: EmailRateLimiter;
  /**
   * The notifications module's address boundary (`parseEmailAddress`), passed
   * in rather than imported for the same reason as the other two. It throws on
   * anything undeliverable, including CR/LF — header injection everywhere a
   * raw-MIME transport is ever added. The shape it enforces is NOT restated
   * here: one implementation, one opinion about what an address is.
   */
  readonly parseAddress: (raw: string) => EmailAddress;
}

export type ChaseEmailTransportFactory = () => Promise<ChaseEmailTransport>;

export class EmailChaseSender implements SmsSender {
  private readonly logger = new Logger(EmailChaseSender.name);
  #transport: ChaseEmailTransport | undefined;

  constructor(
    private readonly resolveTransport: ChaseEmailTransportFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Send every message in the batch, then stamp each one's `chase_messages`
   * row, inside the caller's transaction and under the caller's RLS context.
   *
   * **Three phases, in this order, and the order is the whole design.** Every
   * recipient is resolved and validated first, then every rate limit is
   * consumed, and only then does anything leave the building:
   *
   *  1. a batch that was going to refuse refuses **before** the first
   *     irreversible act, rather than halfway through it;
   *  2. the engine rolls the approval back on any throw, so a refusal after a
   *     send would leave a client holding a request the workspace has no record
   *     of — the one outcome worse than not sending.
   *
   * ⚠ **What remains, honestly:** a transport failure on message N > 1 (an SES
   * throttle, say) still rolls back an approval whose earlier emails are gone.
   * It is bounded — chases are grouped one message per client (SoT §8.2) — and
   * visible, because the throw is the accountant's answer. Making it impossible
   * means moving the send to a post-commit follow-up, the shape
   * `publish.batch`'s ledger call used and for exactly this reason. That is a
   * change to the executor and the engine, so it is not this stage's to make.
   */
  async send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> {
    if (messages.length === 0) return [];

    const transport = await this.#resolve();

    // Phase 1 — resolve every recipient. Reads only; a refusal here costs nothing.
    const addressed: { message: OutboundSms; to: EmailAddress }[] = [];
    for (const message of messages) {
      addressed.push({ message, to: await this.#resolveRecipient(db, transport, message) });
    }

    // Phase 2 — consume every ceiling. Still no send. `ip` is deliberately
    // omitted: an approved chase is a system-initiated send with no request IP
    // behind it, and inventing one consumes a real caller's budget
    // (`email-rate-limit.ts`, `RateLimitRequest.ip`).
    for (const { to } of addressed) {
      const verdict = await transport.limiter.consume({ kind: 'document-request', address: to });
      if (!verdict.allowed) {
        this.logger.warn(
          `chase email refused by rate limit · domain=${domainOf(to)} limitedBy=${verdict.limitedBy ?? 'unknown'} retryAfter=${verdict.retryAfterSeconds}s`,
        );
        // The last-resort over-ask guard. Suppression at detection is the first
        // one and the one that matters; this catches what it missed. Refusing
        // rolls the approval back, so nothing is recorded as sent that was not.
        throw new AppException(
          'NT-RATE-001',
          HttpStatus.TOO_MANY_REQUESTS,
          'Too many document requests',
          'This client has already been asked for documents several times in the last hour. Try again shortly.',
        );
      }
    }

    // Phase 3 — send, and record the send on the row that carries the text.
    const sent: SentSms[] = [];
    for (const { message, to } of addressed) {
      const outbound: OutboundEmail = {
        kind: 'document-request',
        to,
        subject: CHASE_EMAIL_SUBJECT,
        // ⚠ VERBATIM. The reviewed bytes, unmodified. See the file header.
        body: message.body,
      };
      const result = await transport.sender.send(outbound);

      await db.chaseMessage.update({
        where: { id: message.chaseMessageId },
        data: {
          // The executor wrote 'sms' because it cannot know the transport.
          channel: CHASE_EMAIL_CHANNEL,
          providerMessageId: result.providerMessageId,
          deliveryState: DELIVERY_STATE_SENT,
          sentAt: this.now(),
        },
      });

      // The kind, the provider's id and the recipient's DOMAIN. Never the
      // address (personal data, Governance §11.6) and never the body — which
      // names a supplier and an amount from a client's bank feed.
      this.logger.log(
        `chase email sent · domain=${domainOf(to)} messageId=${result.providerMessageId}`,
      );

      sent.push({
        chaseMessageId: message.chaseMessageId,
        providerMessageId: result.providerMessageId,
        deliveryState: DELIVERY_STATE_SENT,
      });
    }
    return sent;
  }

  /** Resolve and memoise the transport. See {@link ChaseEmailTransportFactory}. */
  async #resolve(): Promise<ChaseEmailTransport> {
    this.#transport ??= await this.resolveTransport();
    return this.#transport;
  }

  /**
   * The address, from the contact the chase names — through the caller's
   * `ScopedClient`, so RLS decides whether the row is even visible.
   *
   * Every refusal is `NT-PRP-006`, the engine's own "this proposal is not
   * executable", raised as an {@link AppException} rather than
   * `ProposalExecutionRefused` because importing that class would close the
   * seam cycle the header describes. The wire response is identical: a 409
   * problem+json carrying the code, and a rolled-back transaction.
   *
   * No detail names an id or an address. An accountant needs to know what to
   * fix; nobody needs an oracle for which contacts exist.
   */
  async #resolveRecipient(
    db: ScopedClient,
    transport: ChaseEmailTransport,
    message: OutboundSms,
  ): Promise<EmailAddress> {
    const chase = await db.chase.findUnique({
      where: { id: message.chaseId },
      select: {
        recipientContactId: true,
        recipient: { select: { email: true, receivesChases: true } },
      },
    });

    // A chase the caller cannot see is the same refusal as one that names no
    // contact — neither confirms existence (the chases-surface stance).
    if (chase === null || chase.recipientContactId === null || chase.recipient === null) {
      throw refusal(
        'A chase sent by email must name the client contact it is addressed to. Add a contact to this client and propose the chase again.',
      );
    }

    if (chase.recipient.receivesChases === false) {
      throw refusal('That client contact does not receive document requests.');
    }

    const raw = chase.recipient.email;
    if (raw === null || raw.trim() === '') {
      throw refusal('That client contact has no email address on file, so the request cannot be delivered.');
    }

    // Parse, don't trust (R4). The column is a bare string and
    // `transport.parseAddress` throws on anything undeliverable. That throw is
    // a caller-facing condition here — a typo in a contact record — not a bug,
    // so it is translated rather than allowed to become a 500.
    try {
      return transport.parseAddress(raw);
    } catch {
      throw refusal("That client contact's email address is not a deliverable address.");
    }
  }
}

function refusal(detail: string): AppException {
  return new AppException('NT-PRP-006', HttpStatus.CONFLICT, 'Proposal is not executable', detail);
}

/** The domain half, for logs. The full address is personal data (Governance §11.6). */
function domainOf(address: EmailAddress): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
