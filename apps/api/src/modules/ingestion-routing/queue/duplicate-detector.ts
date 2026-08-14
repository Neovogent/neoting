import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { resolveSystemActor } from '../../../common/db/resolve-system-actor.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { hammingDistance, PERCEPTUAL_HASH_MAX_DISTANCE } from '../lib/dedupe/perceptual-hash.js';

/** The nets that can fire on a pair. Extraction-based nets (SoT Stage 6) come later. */
export type DuplicateSignal = 'byteHash' | 'pHash';

export interface DetectDuplicatesInput {
  readonly documentId: string;
  readonly practiceId: string;
  /**
   * Detection runs PER BUSINESS, and only for routed documents. `Duplicate`'s
   * `business_id` is NOT NULL, and the only indexed lookup is `@@index([businessId,
   * byteHash])` — a practice-wide scan is neither writable (an unrouted document
   * has no business to anchor the row on) nor indexed. An unrouted document is not
   * passed here; see the module CLAUDE.md for the reasoning.
   */
  readonly businessId: string;
  readonly byteHash: string;
  /** Present only for image documents; null for PDFs and undecodable rasters. */
  readonly perceptualHash: string | null;
}

export interface DuplicateFinding {
  readonly otherDocumentId: string;
  readonly signals: readonly DuplicateSignal[];
  readonly score: number;
}

export interface DuplicateDetectionResult {
  readonly findings: readonly DuplicateFinding[];
}

export interface DuplicateDetector {
  detect(input: DetectDuplicatesInput): Promise<DuplicateDetectionResult>;
}

/**
 * Order a pair deterministically so two workers that detect the same pair from
 * opposite ends produce the SAME (documentAId, documentBId) — which the
 * `@@unique([documentAId, documentBId])` constraint then collapses to one row.
 * The ordering is what makes the unique index a real guarantee rather than a
 * coincidence, exactly as the derived id was in #20.
 */
function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** score: an exact byte match is certain (1); a near match scales with similarity. */
function scoreFor(exact: boolean, distance: number): number {
  return exact ? 1 : 1 - distance / 64;
}

/** Offline fixture — records the input it saw and reports no findings. */
export class InMemoryDuplicateDetector implements DuplicateDetector {
  readonly seen: DetectDuplicatesInput[] = [];

  async detect(input: DetectDuplicatesInput): Promise<DuplicateDetectionResult> {
    this.seen.push(input);
    return { findings: [] };
  }
}

/**
 * The real detector. Under the practice's system context (RLS enforces the
 * business anchor — verified against the live database in the integration test),
 * look within the SAME business for:
 *   - exact  — another document with the same `byteHash` (indexed lookup)
 *   - near   — an image document whose `perceptualHash` is within the measured
 *              threshold (Hamming distance computed in memory; there is no index
 *              for it, and per-business the candidate set is bounded)
 * and record one `Duplicate` row per matched pair, verdict PENDING (the Review
 * mode of SoT Stage 6).
 *
 * Writes go through `createMany({ skipDuplicates })` — a single `ON CONFLICT DO
 * NOTHING`, so two workers detecting the same pair at once is a clean no-op, not a
 * transaction abort and not a double-row.
 */
export class PrismaDuplicateDetector implements DuplicateDetector {
  constructor(private readonly prisma: PrismaClient) {}

  async detect(input: DetectDuplicatesInput): Promise<DuplicateDetectionResult> {
    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);

    return scopedDb(this.prisma, systemContext(input.practiceId, systemUserId), async (db) => {
      const exactRows = await db.document.findMany({
        where: { businessId: input.businessId, byteHash: input.byteHash, id: { not: input.documentId } },
        select: { id: true },
      });
      const exactIds = new Set(exactRows.map((r) => r.id));

      const nearDistance = new Map<string, number>();
      if (input.perceptualHash !== null) {
        const candidates = await db.document.findMany({
          where: { businessId: input.businessId, perceptualHash: { not: null }, id: { not: input.documentId } },
          select: { id: true, perceptualHash: true },
        });
        for (const c of candidates) {
          if (c.perceptualHash === null) continue;
          const distance = hammingDistance(input.perceptualHash, c.perceptualHash);
          if (distance <= PERCEPTUAL_HASH_MAX_DISTANCE) nearDistance.set(c.id, distance);
        }
      }

      const findings: DuplicateFinding[] = [];
      for (const otherId of new Set<string>([...exactIds, ...nearDistance.keys()])) {
        const exact = exactIds.has(otherId);
        const signals: DuplicateSignal[] = [];
        if (exact) signals.push('byteHash');
        if (nearDistance.has(otherId)) signals.push('pHash');
        findings.push({ otherDocumentId: otherId, signals, score: scoreFor(exact, nearDistance.get(otherId) ?? 0) });
      }

      if (findings.length > 0) {
        await db.duplicate.createMany({
          data: findings.map((f) => {
            const [documentAId, documentBId] = orderedPair(input.documentId, f.otherDocumentId);
            return {
              businessId: input.businessId,
              documentAId,
              documentBId,
              signals: f.signals as unknown as Prisma.InputJsonValue,
              score: f.score,
              verdict: 'PENDING' as const,
            };
          }),
          skipDuplicates: true,
        });
      }

      return { findings };
    });
  }
}
