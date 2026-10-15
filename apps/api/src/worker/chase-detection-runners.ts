import type { Logger } from '@nestjs/common';

import { getPrismaClient } from '../common/db/prisma.js';
import type { Env } from '../config/env.js';
import {
  type LedgerUnattachedReader,
  MISSING_EVIDENCE_SWEEP_INTERVAL_MS,
  runMissingEvidenceSweep,
  selectEmailChaseSender,
  SqsQueue,
  startSmsDeliveryConsumer,
} from '../modules/chase/index.js';
import { readUnattachedLedgerTransactions } from '../modules/publishing/index.js';

/**
 * Two background runners for the chase lane, started from `worker/main.ts`.
 * Plain intervals / a long-poll loop — the general scheduler will absorb them.
 *
 * 1. The missing-evidence sweep (engines a, b, d, e) every six hours. Safe to
 *    run any number of times: findings are keyed and never raised twice.
 * 2. The SMS delivery-receipt consumer, only when `SMS_EVENTS_QUEUE_URL` is set.
 */
export function startChaseDetectionRunners(env: Env, logger: Logger): void {
  const prisma = getPrismaClient();
  // Engine (d) is composed HERE, so `chase` never imports `publishing`.
  const ledger: LedgerUnattachedReader | undefined =
    env.LEDGER_ADAPTER === 'http'
      ? (ctx, businessId, since) => readUnattachedLedgerTransactions(prisma, ctx, env, businessId, since)
      : undefined;

  const sweep = (): void => {
    void runMissingEvidenceSweep(prisma, ledger === undefined ? {} : { ledger }).catch((error: unknown) =>
      logger.error(`missing-evidence sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  setInterval(sweep, MISSING_EVIDENCE_SWEEP_INTERVAL_MS).unref();
  setTimeout(sweep, 60_000).unref();
  logger.log('missing-evidence sweep armed (every 6h)');

  const queueUrl = env.SMS_EVENTS_QUEUE_URL ?? '';
  if (queueUrl !== '') {
    startSmsDeliveryConsumer(prisma, new SqsQueue(queueUrl), {
      fxGbpPerUsdMilli: env.SMS_COST_GBP_PER_USD_MILLI ?? 790,
      emailFallback: selectEmailChaseSender(env),
      logger: { log: (m) => logger.log(m), warn: (m) => logger.warn(m) },
    });
    logger.log('sms delivery-receipt consumer started');
  }
}
