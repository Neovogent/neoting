import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import type { FollowUp } from './proposal-executor.js';

/**
 * Dedupe-on-route, the deferred half — the design decided on issue #81.
 *
 * The route executor writes a `DocumentEvent{stage:'dedupe',
 * outcome:'deferred'}` INSIDE the effect transaction (durable intent,
 * committed atomically with the route — the outbox principle from Governance
 * §4.2, on the table that exists; the outbox table itself is its own future
 * G7 issue) and returns a `dedupe` follow-up. The ENGINE calls
 * {@link runDedupeFollowUp} after commit. A crash between commit and enqueue
 * loses nothing: {@link findStaleDedupeFollowUps} finds deferred events with
 * no completion, and whatever periodic process the engine runs re-drives them.
 *
 * The detector is a STRUCTURAL seam, not an import: `PrismaDuplicateDetector`
 * lives in ingestion-routing, and a module may not reach into another's
 * internals — so the engine composes the two through their public providers
 * and this module only names the shape it needs. (The integration test wires
 * the real detector, because tests are allowed to compose what the engine
 * will.)
 */
export interface DedupeDetection {
  detect(input: {
    readonly documentId: string;
    readonly practiceId: string;
    readonly businessId: string;
    readonly byteHash: string;
    readonly perceptualHash: string | null;
  }): Promise<{ readonly findings: readonly unknown[]; readonly candidatesTruncated: boolean }>;
}

/**
 * Complete one deferred dedupe. Reads the document's hashes, runs the
 * detector (which manages its own scoped work — that is WHY this cannot run
 * inside the effect transaction), then records the completion event so the
 * sweep stops seeing the deferral. Idempotent: a second run re-scans and
 * re-records, and the detector's own `skipDuplicates` write makes the pairs
 * collapse rather than double.
 */
export async function runDedupeFollowUp(
  prisma: PrismaClient,
  ctx: ScopeContext,
  followUp: Extract<FollowUp, { kind: 'dedupe' }>,
  detector: DedupeDetection,
  traceId: string,
): Promise<void> {
  const document = await scopedDb(prisma, ctx, (db) =>
    db.document.findUnique({
      where: { id: followUp.documentId },
      select: { byteHash: true, perceptualHash: true },
    }),
  );
  if (document === null) {
    // The route committed, so an invisible document here is a context problem,
    // not a data one. Loud, never swallowed: the deferral stays open for the
    // sweep, and the caller decides retry.
    throw new Error(`dedupe follow-up: document ${followUp.documentId} is not reachable in this context`);
  }

  const result = await detector.detect({
    documentId: followUp.documentId,
    practiceId: followUp.practiceId,
    businessId: followUp.businessId,
    byteHash: document.byteHash,
    perceptualHash: document.perceptualHash,
  });

  await scopedDb(prisma, ctx, (db) =>
    db.documentEvent.create({
      data: {
        documentId: followUp.documentId,
        stage: 'dedupe',
        outcome: 'completed',
        traceId,
        detail: {
          findings: result.findings.length,
          // A cap on a search can cost a miss, and a missed duplicate must not
          // look like a clean run (the detector's own contract).
          candidatesTruncated: result.candidatesTruncated,
        },
      },
    }),
  );
}

/**
 * Deferred dedups whose completion never landed — the sweep's work list.
 * Bounded and oldest-first so a long outage drains in arrival order.
 */
export async function findStaleDedupeFollowUps(
  db: ScopedClient,
  options: { readonly limit?: number } = {},
): Promise<readonly { documentId: string; deferredAt: Date }[]> {
  const deferred = await db.documentEvent.findMany({
    where: { stage: 'dedupe', outcome: 'deferred' },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 100,
    select: { documentId: true, createdAt: true },
  });
  if (deferred.length === 0) return [];

  const completed = await db.documentEvent.findMany({
    where: { stage: 'dedupe', outcome: 'completed', documentId: { in: deferred.map((d) => d.documentId) } },
    select: { documentId: true, createdAt: true },
  });

  // A deferral is stale when no completion FOLLOWS it — a re-route after an
  // earlier completed scan defers again and must be swept again.
  return deferred
    .filter((d) => !completed.some((c) => c.documentId === d.documentId && c.createdAt >= d.createdAt))
    .map((d) => ({ documentId: d.documentId, deferredAt: d.createdAt }));
}
