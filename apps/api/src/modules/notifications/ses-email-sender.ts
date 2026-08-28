import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

import { type EmailSender, type OutboundEmail, type SentEmail } from './email-sender.js';

/**
 * The real sender: Amazon SES v2, eu-west-2.
 *
 * The infrastructure it depends on already exists and is production-approved —
 * `infra/envs/staging/email.tf`: a verified domain identity, Easy DKIM, a
 * custom MAIL FROM (`mail.<domain>`) so SPF ALIGNS for DMARC, a `_dmarc` record,
 * and a configuration set carrying TLS-required delivery, reputation metrics and
 * BOUNCE/COMPLAINT suppression. Production access was granted on 17 Aug 2026
 * (case 178662887400793): 50,000 messages/day, 14/second, sandbox exited. No
 * support case is needed and none should be opened.
 *
 * That file's own status note lists what still gated real sending, and item one
 * was *"No sending client exists in the app — nothing calls ses:SendEmail yet."*
 * This is that client.
 *
 * ## The three envelope decisions
 *
 * **`no-reply@`, never `doc@`.** `doc@` is the INBOUND document intake address
 * (`email.tf`, the `doc-to-s3` receipt rule): mail arriving there is written to
 * the receipts bucket and filed as a client document. Sending transactional mail
 * from it would mean every "thanks, got it" reply a client types lands in the
 * ingestion pipeline and is extracted as paperwork. The IAM condition in
 * `compute.tf` used to pin `ses:FromAddress` to `doc@` — S2 widens it to the
 * outbound address for exactly this reason.
 *
 * **A `Reply-To` that a human reads.** `no-reply@` correctly signals that the
 * From box is not monitored, and a client who replies anyway must still reach
 * someone. `EMAIL_REPLY_TO_ADDRESS` is `support@neovogent.com`, which is a
 * different domain on purpose: the MX for the sending domain points at SES
 * inbound, whose rule set accepts `doc@` and `dmarc@` and nothing else, so a
 * reply to any other address on it would bounce.
 *
 * **The configuration set is named on every send.** Left off, the message still
 * sends — and silently opts out of suppression, reputation metrics and the SNS
 * event feed, i.e. every mechanism that would tell us the address has already
 * bounced. It is passed as config rather than defaulted so an environment
 * without one is visibly an environment without one.
 *
 * ## What this deliberately does not do
 *
 * No retry, no queue, no batching. SES's own SDK retries throttles and 5xx
 * (`maxAttempts`, default 3); anything it gives up on is a real failure and the
 * caller — which knows whether this was a sign-in code someone is waiting on or
 * a chase that can go out tomorrow — decides what that means. A retry loop here
 * would double-send credentials on an ambiguous timeout.
 */

export interface SesEmailSenderConfig {
  readonly region: string;
  /** The envelope From. A bare address — the display name is composition's (`email-copy.ts`). */
  readonly fromAddress: string;
  /** Where a replying human lands. Empty omits the header rather than sending a blank one. */
  readonly replyToAddress: string;
  /** `nt-<env>-default` (`email.tf`). Empty means no suppression and no metrics — see above. */
  readonly configurationSetName: string;
}

/** The narrow slice of the SDK client this uses — so a unit test needs no AWS credentials. */
export type SesSendClient = Pick<SESv2Client, 'send'>;

export class SesEmailSender implements EmailSender {
  readonly #client: SesSendClient;

  constructor(
    private readonly config: SesEmailSenderConfig,
    client?: SesSendClient,
  ) {
    // Credentials come from the default provider chain — the ECS task role in
    // staging, never an access key in an environment variable (Governance
    // §11.5). Constructed here rather than injected so nothing outside this
    // file needs to know SES exists.
    this.#client = client ?? new SESv2Client({ region: config.region });
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    const response = await this.#client.send(
      new SendEmailCommand({
        FromEmailAddress: this.config.fromAddress,
        Destination: { ToAddresses: [email.to] },
        ...(this.config.replyToAddress === '' ? {} : { ReplyToAddresses: [this.config.replyToAddress] }),
        ...(this.config.configurationSetName === '' ? {} : { ConfigurationSetName: this.config.configurationSetName }),
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            // Text always; Html only when the composition rendered one. The
            // HTML part is DERIVED from the same text (`email-html.ts`), so a
            // client that prefers either part reads the same message — see the
            // reversal note on `EmailSender`.
            Body: {
              Text: { Data: email.body, Charset: 'UTF-8' },
              ...(email.html === undefined ? {} : { Html: { Data: email.html, Charset: 'UTF-8' } }),
            },
          },
        },
        // Dimensions on the configuration set's CloudWatch metrics: it makes
        // "are sign-in codes bouncing" answerable separately from "are invites
        // bouncing", which is the question a reputation alarm raises. SES tag
        // values admit only alphanumerics, `-` and `_`, which every EmailKind is.
        EmailTags: [{ Name: 'nt-kind', Value: email.kind }],
      }),
    );

    const providerMessageId = response.MessageId;
    if (providerMessageId === undefined) {
      // SES types MessageId as optional; a 200 without one has never been
      // observed. If it happens, the send may well have succeeded — so this
      // throws rather than returning a blank id that would be recorded as a
      // successful delivery nobody can ever trace.
      throw new Error('SES accepted the message but returned no MessageId — delivery cannot be traced');
    }
    return { kind: email.kind, providerMessageId };
  }
}
