import { Module } from '@nestjs/common';

import { type Clock, systemClock } from './clock.js';
import { FixtureIngestQueue } from './ingest-queue.js';
import { InMemoryReplayStore } from './replay-store.js';
import { CLOCK, INGEST_QUEUE, REPLAY_STORE } from './tokens.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';
import { WhatsAppWebhookController } from './whatsapp.controller.js';

/**
 * WhatsApp inbound webhook (Lane B / ingestion-routing). Fixture providers for
 * the queue and replay store (issue #9: no BullMQ, no Redis, no DB) — the real
 * BullMQ producer and Redis-backed store drop in behind these tokens later.
 */
@Module({
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppSignatureGuard,
    { provide: CLOCK, useValue: systemClock },
    { provide: INGEST_QUEUE, useClass: FixtureIngestQueue },
    {
      provide: REPLAY_STORE,
      useFactory: (clock: Clock) => new InMemoryReplayStore(clock),
      inject: [CLOCK],
    },
  ],
})
export class WhatsAppWebhookModule {}
