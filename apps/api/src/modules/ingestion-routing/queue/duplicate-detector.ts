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
  /**
   * True when the perceptual candidate scan hit {@link PERCEPTUAL_CANDIDATE_LIMIT}
   * and older images were therefore NOT compared. The caller must surface this —
   * a duplicate we declined to look for is still a duplicate we missed, and this
   * module's first invariant is that nothing is ever silently dropped.
   */
  readonly candidatesTruncated: boolean;
}

/**
 * How many of a business's past images the perceptual net compares against.
 *
 * ⚠ THIS IS A BOUND ON A SCAN, NOT A PAGE SIZE, AND IT CAN COST A MISS.
 *
 * Governance §5.1: "never load unbounded relations". A Hamming distance cannot
 * be answered by a B-tree, so there is no index that narrows this — the query is
 * a scan of every image the business has ever sent, and it grows forever. At 50
 * documents per client per month that is fine this year and not fine in three.
 *
 * Ordering by `receivedAt desc` is what makes the cap defensible rather than
 * arbitrary: it is index-backed (`@@index([businessId, receivedAt])`) and
 * duplicates cluster in time — the same receipt photographed twice arrives
 * minutes apart, not years. Beyond the cap the result is reported truncated, so
 * the gap is visible instead of silent.
 *
 * The real fix is an index-supported search (hash banding, or a BK-tree) and
 * that is a `prisma/` change — LAW under G7, so it needs a contract-change issue
 * before a PR, not a quiet migration here.
 */
export const PERCEPTUAL_CANDIDATE_LIMIT = 500;

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
    return { findings: [], candidatesTruncated: false };
  }
}

/**
 * The real detector. Under the practice's system context (RLS enforces the
 * business anchor — verified against the live database in the integration test),
 * look within the SAME business for:
 *   - exact  — another document with the same `byteHash` (indexed lookup)
 *   - near   — an image document whose `perceptualHash` is within the measured
 *              threshold (Hamming distance computed in memory; no index can
 *              answer it, so the candidate set is capped and ordered newest-first
 *              — see PERCEPTUAL_CANDIDATE_LIMIT, and note the cap can cost a miss)
 * and record one `Duplicate` row per matched pair, verdict PENDING (the Review
 * mode of SoT Stage 6).
 *
 * Writes go through `createMany({ skipDuplicates })` — a single `ON CONFLICT DO
 * NOTHING`, so two workers detecting the same pair at once is a clean no-op, not a
 * transaction abort and not a double-row.
 */
export class PrismaDuplicateDetector implements DuplicateDetector {
  /**
   * `candidateLimit` is injectable for one reason: so a test can prove the cap
   * REPORTS itself without seeding 500 rows to reach the real one. Production
   * always takes the default — an override at a call site would be a silent
   * narrowing of how far back we look for duplicates.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly candidateLimit: number = PERCEPTUAL_CANDIDATE_LIMIT,
  ) {}

  async detect(input: DetectDuplicatesInput): Promise<DuplicateDetectionResult> {
    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);

    return scopedDb(this.prisma, systemContext(input.practiceId, systemUserId), async (db) => {
      const exactRows = await db.document.findMany({
        where: { businessId: input.businessId, byteHash: input.byteHash, id: { not: input.documentId } },
        select: { id: true },
      });
      const exactIds = new Set(exactRows.map((r) => r.id));

      const nearDistance = new Map<string, number>();
      let candidatesTruncated = false;
      if (input.perceptualHash !== null) {
        const candidates = await db.document.findMany({
          where: { businessId: input.businessId, perceptualHash: { not: null }, id: { not: input.documentId } },
          select: { id: true, perceptualHash: true },
          // Newest first, and capped — see PERCEPTUAL_CANDIDATE_LIMIT. The order
          // is index-backed; the cap is what keeps this off the unbounded-query
          // list, at the price of not comparing against the oldest images.
          orderBy: { receivedAt: 'desc' },
          take: this.candidateLimit,
        });
        candidatesTruncated = candidates.length === this.candidateLimit;
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

      return { findings, candidatesTruncated };
    });
  }
}
