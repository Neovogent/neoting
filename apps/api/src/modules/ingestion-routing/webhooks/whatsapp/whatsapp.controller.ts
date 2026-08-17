import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { buildProblem } from '../../../../common/problem/problem.js';
import { wrapUntrusted } from '../../../../common/untrusted-content.js';
import type { Env } from '../../../../config/env.js';
import { ENV } from '../../../../config/env.module.js';
import { safeBasename } from '../../lib/safe-basename.js';
import type { Clock } from './clock.js';
import { captionOf, mediaOf, parseEnvelope } from './envelope.js';
import type { IngestQueue } from './ingest-queue.js';
import type { ReplayStore } from './replay-store.js';
import { decideRouting } from './routing.js';
import { verifyTokenMatches } from './signature.js';
import { parseUnixSeconds, withinTolerance } from './timestamp.js';
import { CLOCK, INGEST_QUEUE, REPLAY_STORE } from './tokens.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';

// A wamid stays reserved a little longer than the freshness window, so an id
// cannot age out of the replay store while a retry is still inside tolerance.
const REPLAY_TTL_MS = 10 * 60 * 1000;

// Meta's challenge is short (tens of bytes). Cap what we echo defensively —
// well under Node's default 16 KB header limit — so the endpoint can never be
// coaxed into reflecting a large payload.
const MAX_CHALLENGE_LENGTH = 4096;

/**
 * Meta WhatsApp inbound webhook (Lane B / ingestion-routing, SoT §4 Stage 1).
 * Inbound-only (D16/D25). GET is Meta's unsigned verification handshake; POST is
 * signature-verified (guard) then handed to the async ingest queue.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(REPLAY_STORE) private readonly replay: ReplayStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Meta's one-time verification handshake. Unsigned by design. */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): void {
    if (
      mode === 'subscribe' &&
      verifyTokenMatches(token, this.env.META_VERIFY_TOKEN) &&
      challenge !== undefined &&
      challenge.length > 0 &&
      challenge.length <= MAX_CHALLENGE_LENGTH
    ) {
      // Echo the challenge verbatim as text/plain — never JSON-wrapped, never coerced.
      res.status(HttpStatus.OK).type('text/plain').send(challenge);
      return;
    }
    res
      .status(HttpStatus.FORBIDDEN)
      .type('application/problem+json')
      .send(
        buildProblem({
          status: HttpStatus.FORBIDDEN,
          code: 'NT-INT-002',
          title: 'Webhook verification failed',
          traceId: randomUUID(),
          detail: 'The hub.verify_token did not match.',
        }),
      );
  }

  /** Inbound message. The signature guard has already verified the raw body. */
  @Post()
  @UseGuards(WhatsAppSignatureGuard)
  @HttpCode(HttpStatus.OK)
  async receive(@Body() body: unknown): Promise<void> {
    const { messages } = parseEnvelope(body);
    if (messages.length === 0) return; // status callback / unhandled shape → ack, do nothing

    // A message outside the ±5-minute window is stale or replayed → 401 (contract).
    // Checked for all messages before enqueuing any, so a stale batch enqueues nothing.
    // One clock read for the whole batch, so staleness is evaluated atomically.
    const nowMs = this.clock.now();
    for (const message of messages) {
      const fresh = await this.replay.reserve(message.id, REPLAY_TTL_MS);
      if (!fresh) {
        // A genuine Meta retry of an id we already accepted — idempotent no-op.
        this.logger.debug(`Duplicate wamid ${message.id} ignored`);
        continue;
      }
      const seconds = parseUnixSeconds(message.timestamp);
      // Freshness is a TRIAGE FLAG, never a rejection. The HMAC already stops
      // forgery and the replay store already stops reprocessing, so age buys
      // nothing — and 401-ing an old-but-signed message would turn our own
      // downtime into permanent loss: Meta retries stale, we reject every retry,
      // Meta gives up. Enqueue regardless of age; mark stale for triage.
      const stale = seconds === null || !withinTolerance(seconds, nowMs);
      const caption = captionOf(message);
      const media = mediaOf(message);
      const phoneNumberId = message.receivedByPhoneNumberId;
      // The practice anchor an unrouted document has instead of a business (#79).
      // Derived from the number that RECEIVED the message, never from the sender.
      const practiceId = phoneNumberId === null ? undefined : this.env.WHATSAPP_PRACTICE_MAP[phoneNumberId];

      if (media !== null && practiceId === undefined) {
        // Enqueue ANYWAY. A 4xx here would make Meta retry, then give up, and the
        // document would be lost to our own misconfiguration — age and config are
        // never reasons to drop a signed document. The worker refuses to persist
        // without an anchor and dead-letters the job, so this surfaces as a page
        // rather than as silence. The wamid is safe to log; the caption is not.
        this.logger.warn(
          `no practice mapped for phone_number_id ${phoneNumberId ?? '(absent)'} — wamid ${message.id} will dead-letter (set WHATSAPP_PRACTICE_MAP)`,
        );
      }

      await this.queue.enqueue({
        source: 'whatsapp',
        idempotencyKey: message.id,
        from: message.from,
        receivedAtSeconds: seconds ?? 0,
        messageType: message.type,
        caption: caption === null ? null : wrapUntrusted(caption),
        // No sender→workspace map exists yet (no DB) → Unrouted, never dropped.
        routing: decideRouting(message.from, new Map()),
        stale,
        // Conditional spread, not `undefined` — exactOptionalPropertyTypes.
        ...(media === null ? {} : { mediaId: media.id }),
        ...(media?.declaredFilename ? { filename: safeBasename(media.declaredFilename) } : {}),
        ...(phoneNumberId === null ? {} : { phoneNumberId }),
        ...(practiceId === undefined ? {} : { practiceId }),
      });
    }
    // 200 with no body (contract): acknowledged.
  }
}
