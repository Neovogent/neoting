import {
  ConflictException,
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';

/**
 * The AWS End User Messaging SMS transport (Phase 3, owner decision 1 Sep
 * 2026: AWS EUM supersedes the Twilio rail SoT D32 named).
 *
 * A THIN wire wrapper, deliberately: one method, one command, no composition —
 * the reviewed bytes go on the wire verbatim, exactly as `SesEmailSender`
 * carries an email body. It is its own file (not inside `aws-sms-sender.ts`)
 * because TWO callers need the same wire: the chase sender, and the portal's
 * OTP-by-SMS delivery — one client, one origination identity, one place the
 * region is pinned.
 *
 * `MessageType: 'TRANSACTIONAL'` — every message this product sends is a
 * document request, a reminder or a sign-in code (the three samples on the UK
 * carrier registration); nothing promotional exists to send.
 */
export interface AwsSmsTransport {
  /** Returns the provider's message id. Throws `OptedOutRecipientError` for a STOP'd number. */
  sendText(toE164: string, body: string): Promise<{ messageId: string }>;
}

/**
 * The recipient replied STOP. A DISTINCT error because the caller's right
 * answer is a refusal that rolls the approval back (§24.2.3: an opt-out is a
 * fact about the client, not a transient fault) — never a retry, which would
 * be the product arguing with a STOP.
 */
export class OptedOutRecipientError extends Error {
  constructor() {
    super('the recipient has opted out of SMS (STOP)');
    this.name = 'OptedOutRecipientError';
  }
}

export interface AwsSmsTransportConfig {
  readonly region: string;
  /** The dedicated number, pool id or ARN sends originate from. */
  readonly originationIdentity: string;
}

export function createAwsSmsTransport(config: AwsSmsTransportConfig): AwsSmsTransport {
  // Constructed once, lazily on first use by the selector's own factory — a
  // process that never sends builds no client.
  const client = new PinpointSMSVoiceV2Client({ region: config.region });

  return {
    async sendText(toE164: string, body: string): Promise<{ messageId: string }> {
      try {
        const response = await client.send(
          new SendTextMessageCommand({
            DestinationPhoneNumber: toE164,
            OriginationIdentity: config.originationIdentity,
            MessageBody: body,
            MessageType: 'TRANSACTIONAL',
          }),
        );
        if (response.MessageId === undefined) {
          // A 200 with no id is a send we cannot audit — refuse it rather than
          // record a delivery nothing can ever be asked about.
          throw new Error('AWS accepted the message but returned no MessageId');
        }
        return { messageId: response.MessageId };
      } catch (error) {
        // The AWS-managed opt-out list attached to the number refuses a STOP'd
        // destination as a conflict naming the reason.
        if (error instanceof ConflictException && error.Reason === 'DESTINATION_PHONE_NUMBER_OPTED_OUT') {
          throw new OptedOutRecipientError();
        }
        throw error;
      }
    },
  };
}
