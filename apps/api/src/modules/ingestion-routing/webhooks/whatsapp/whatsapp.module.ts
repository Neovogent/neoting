import { Module } from '@nestjs/common';

import { IngestQueueModule } from '../../queue/ingest-queue.module.js';
import { type Clock, systemClock } from './clock.js';
import { InMemoryReplayStore } from './replay-store.js';
import { CLOCK, REPLAY_STORE } from './tokens.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';
import { WhatsAppWebhookController } from './whatsapp.controller.js';

/**
 * WhatsApp inbound webhook (Lane B / ingestion-routing). The ingest queue is the
 * real BullMQ producer or the in-memory fixture, **chosen by config** (#12) —
 * the controller injects the same `INGEST_QUEUE` token either way, so it does
 * not change when the real queue lands. It now comes from the shared
 * `IngestQueueModule` (#76), so this lane and web upload share one producer
 * rather than one Redis connection each. The replay store stays an in-memory
 * fixture for now (issue #9).
 */
@Module({
  imports: [IngestQueueModule],
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppSignatureGuard,
    { provide: CLOCK, useValue: systemClock },
    {
      provide: REPLAY_STORE,
      useFactory: (clock: Clock) => new InMemoryReplayStore(clock),
      inject: [CLOCK],
    },
  ],
})
export class WhatsAppWebhookModule {}
