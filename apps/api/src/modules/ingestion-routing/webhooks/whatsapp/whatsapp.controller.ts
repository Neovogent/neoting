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

import { AppException, buildProblem } from '../../../../common/problem/problem.js';
import { wrapUntrusted } from '../../../../common/untrusted-content.js';
import type { Env } from '../../../../config/env.js';
import { ENV } from '../../../../config/env.module.js';
import type { Clock } from './clock.js';
import { captionOf, parseEnvelope } from './envelope.js';
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
          code: 'NT-AUTH-001',
          title: 'Forbidden',
          traceId: randomUUID(),
          detail: 'Webhook verify token mismatch.',
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
    const nowMs = this.clock.now();
    for (const message of messages) {
      const seconds = parseUnixSeconds(message.timestamp);
      if (seconds === null || !withinTolerance(seconds, nowMs)) {
        throw new AppException(
          'NT-AUTH-001',
          HttpStatus.UNAUTHORIZED,
          'Unauthenticated',
          'Message timestamp is missing, malformed, or outside the accepted window.',
        );
      }
    }

    for (const message of messages) {
      const fresh = await this.replay.reserve(message.id, REPLAY_TTL_MS);
      if (!fresh) {
        // A genuine Meta retry of an id we already accepted — idempotent no-op.
        this.logger.debug(`Duplicate wamid ${message.id} ignored`);
        continue;
      }
      const caption = captionOf(message);
      await this.queue.enqueue({
        source: 'whatsapp',
        idempotencyKey: message.id,
        from: message.from,
        receivedAtSeconds: parseUnixSeconds(message.timestamp) ?? 0, // validated above
        messageType: message.type,
        caption: caption === null ? null : wrapUntrusted(caption),
        // No sender→workspace map exists yet (no DB) → Unrouted, never dropped.
        routing: decideRouting(message.from, new Map()),
      });
    }
    // 200 with no body (contract): acknowledged.
  }
}
