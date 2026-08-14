import { Module } from '@nestjs/common';

import type { Env } from '../../../../config/env.js';
import { ENV } from '../../../../config/env.module.js';
import { selectIngestQueue } from '../../queue/select-ingest-queue.js';
import { type Clock, systemClock } from './clock.js';
import { InMemoryReplayStore } from './replay-store.js';
import { CLOCK, INGEST_QUEUE, REPLAY_STORE } from './tokens.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';
import { WhatsAppWebhookController } from './whatsapp.controller.js';

/**
 * WhatsApp inbound webhook (Lane B / ingestion-routing). The ingest queue is the
 * real BullMQ producer or the in-memory fixture, **chosen by config** (#12) —
 * the controller injects the same `INGEST_QUEUE` token either way, so it does
 * not change when the real queue lands. The replay store stays an in-memory
 * fixture for now (issue #9).
 */
@Module({
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppSignatureGuard,
    { provide: CLOCK, useValue: systemClock },
    { provide: INGEST_QUEUE, useFactory: (env: Env) => selectIngestQueue(env), inject: [ENV] },
    {
      provide: REPLAY_STORE,
      useFactory: (clock: Clock) => new InMemoryReplayStore(clock),
      inject: [CLOCK],
    },
  ],
})
export class WhatsAppWebhookModule {}
