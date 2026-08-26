import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import type { CanonicalSourceLink } from '../canonical/canonical-row.js';

import { mintCapabilityCode, type RandomBytesSource } from './capability-code.js';
import { CAPABILITY_LINK_ORIGIN, assertCapabilityOrigin, toCanonicalSourceLink } from './capability-url.js';

/**
 * Minting the D43 source-document link — the write half of the capability-URL
 * lane, and the thing A9's export calls once per batch.
 *
 * **Every query here goes through `scopedDb`.** The unscoped bootstrap this
 * feature needs lives in `capability-link.service.ts` and is confined to it;
 * minting happens under the exporting accountant's own session, so RLS is the
 * boundary exactly as it is everywhere else. A document the caller cannot see
 * gets no link — not a 403, not an error: it is simply absent from the result,
 * and the emitter then raises A7's `source-link-missing` warning for that row.
 *
 * ## Reuse the live link; never mint a second one
 *
 * `prisma/schema.prisma` states the reason on the model itself and it is the
 * single most important behaviour in this file: *"the same document re-exported
 * next month must carry the SAME code, or the accountant's saved VT conversion
 * table stops matching and every import goes manual again"*. So the rule is
 * **reuse if there is a live link, mint only if there is not** — and
 * `document_links` deliberately has no `@@unique([documentId])`, because
 * revocation has to be able to leave a document with no live link at all.
 *
 * A revoked or expired link is **not** reused. That is the point of revoking
 * one: an old code that still resolved would not have been revoked.
 */

/**
 * The platform expiry, in days, for a practice that has not chosen one
 * (`practices.document_link_ttl_days IS NULL`).
 *
 * A year, and the number is a compromise between two real failures rather than
 * a round figure. Too short and the acceptance test breaks in the field: an
 * accountant opening January's export during the following year-end finds a
 * dead link inside a ledger file they cannot re-import. Too long and a document
 * link outlives the engagement it belonged to, which is precisely what D43's
 * "expiry configurable per practice" exists to stop. Twelve months covers a
 * full UK accounting cycle plus its year-end, and a practice that wants
 * something else sets it.
 *
 * ⚠ A practice cannot currently express "never expire" through
 * `document_link_ttl_days` — NULL already means "use this default". The column
 * is LAW (`prisma/`), so that is recorded rather than worked around; a
 * `DocumentLink.expiresAt` of NULL (which the schema does define as no expiry)
 * is reachable only by a future contract change.
 */
export const DEFAULT_DOCUMENT_LINK_TTL_DAYS = 365;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * How many documents one call will mint links for.
 *
 * Governance §5.1 forbids unbounded loads, and "one export's worth" is not a
 * bound — it is however many documents reached Published in a period. 500 is
 * the same ceiling the contract puts on every other batch (`RevokeLinkPayload`,
 * `publish.batch`), so an export that exceeds it fails against a number the
 * rest of the system already uses rather than a new one invented here.
 */
export const MAX_LINKS_PER_CALL = 500;

/**
 * How many times a code collision is retried before giving up.
 *
 * `document_links.code` is UNIQUE, so a collision is a `P2002` rather than a
 * silent overwrite — which is the correct failure and the reason this loop is
 * short. At 40 bits, the chance that a batch of 500 collides with anything in a
 * million existing codes is about 5 × 10⁻⁴, and the chance of three consecutive
 * collisions is not a number worth writing down.
 */
const MAX_CODE_COLLISION_RETRIES = 3;

export interface DocumentLinkServiceOptions {
  /** See {@link CAPABILITY_LINK_ORIGIN} — the composition root supplies it. */
  readonly origin?: string;
  /** Injected only so a test can force a collision or a letterless draw. */
  readonly random?: RandomBytesSource;
  readonly now?: () => Date;
}

export class DocumentLinkService {
  private readonly origin: string;
  private readonly random: RandomBytesSource | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    options: DocumentLinkServiceOptions = {},
  ) {
    // Validated at construction, so a malformed origin fails at boot rather
    // than after it has been baked into a file inside a customer's ledger.
    this.origin = assertCapabilityOrigin(options.origin ?? CAPABILITY_LINK_ORIGIN);
    this.random = options.random;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The live source-document link for each of `documentIds`.
   *
   * Returns a `Map`, not an array: a document the caller cannot see, or one
   * that does not exist, is simply absent. The caller decides what that means —
   * for A9's export it means A7's `source-link-missing` warning on that row,
   * which is the honest outcome rather than a half-linked file that looks
   * complete.
   */
  async linksFor(ctx: ScopeContext, documentIds: readonly string[]): Promise<Map<string, CanonicalSourceLink>> {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return new Map();
    if (unique.length > MAX_LINKS_PER_CALL) {
      throw new AppException(
        'NT-EXP-003',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Export too large',
        `An export carries at most ${MAX_LINKS_PER_CALL} documents at a time; this one has ${unique.length}. Narrow the period and export again.`,
      );
    }

    const now = this.now();
    const links = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await this.readLiveLinks(db, unique, now);
      const missing = unique.filter((id) => !existing.has(id));
      if (missing.length === 0) return existing;

      const minted = await this.mint(db, ctx, missing, now);
      for (const [documentId, code] of minted) existing.set(documentId, code);
      return existing;
    });

    return new Map([...links].map(([documentId, code]) => [documentId, toCanonicalSourceLink(this.origin, code)]));
  }

  /** The single-document convenience. Null when the document is invisible or absent. */
  async linkFor(ctx: ScopeContext, documentId: string): Promise<CanonicalSourceLink | null> {
    const links = await this.linksFor(ctx, [documentId]);
    return links.get(documentId) ?? null;
  }

  /**
   * documentId → code, for documents that already have a link that is neither
   * revoked nor expired.
   *
   * One query rather than one per document. `@@index([documentId, revokedAt])`
   * on `document_links` exists for exactly this shape, and the ordering makes
   * "the live link" deterministic when a document somehow has two — newest
   * wins, because the newer one is the one a recent export put in front of the
   * accountant.
   */
  private async readLiveLinks(
    db: ScopedClient,
    documentIds: readonly string[],
    now: Date,
  ): Promise<Map<string, string>> {
    const rows = await db.documentLink.findMany({
      where: {
        documentId: { in: [...documentIds] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { documentId: true, code: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const live = new Map<string, string>();
    for (const row of rows) if (!live.has(row.documentId)) live.set(row.documentId, row.code);
    return live;
  }

  /**
   * Mint one link per document that still needs one.
   *
   * The documents are re-read **through RLS** first, and that read is what
   * makes this safe: `document_links.business_id` is a column we would
   * otherwise be filling in from a caller-supplied document id, and the
   * policy's `WITH CHECK` only proves the business is one the caller can reach
   * — not that it is the document's own. Reading the anchor from the document
   * row removes the question. A document the caller cannot see returns no row
   * and therefore gets no link.
   */
  private async mint(
    db: ScopedClient,
    ctx: ScopeContext,
    documentIds: readonly string[],
    now: Date,
  ): Promise<Map<string, string>> {
    const documents = await db.document.findMany({
      where: { id: { in: [...documentIds] } },
      select: {
        id: true,
        businessId: true,
        // The practice's own expiry setting, reached through the document's
        // business so an invisible business yields no row at all.
        business: { select: { practice: { select: { documentLinkTtlDays: true } } } },
      },
    });

    const minted = new Map<string, string>();
    for (const document of documents) {
      // An UNROUTED document has `business_id = null` and `document_links`
      // requires one. That is not an oversight to route around: a document
      // nobody has assigned to a client cannot be on a client's export, so it
      // has nothing to link from. Skipped, and the emitter warns.
      if (document.businessId === null) continue;

      const expiresAt = this.expiryFor(document.business?.practice?.documentLinkTtlDays ?? null, now);
      const code = await this.insertWithCollisionRetry(db, {
        documentId: document.id,
        businessId: document.businessId,
        createdByUserId: ctx.actorId,
        expiresAt,
      });
      minted.set(document.id, code);
    }
    return minted;
  }

  private async insertWithCollisionRetry(
    db: ScopedClient,
    row: { documentId: string; businessId: string; createdByUserId: string; expiresAt: Date },
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRIES; attempt += 1) {
      const code = mintCapabilityCode(this.random);
      try {
        await db.documentLink.create({ data: { ...row, code } });
        return code;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error(
      `could not mint a unique capability code in ${MAX_CODE_COLLISION_RETRIES} attempts — at 40 bits that is not chance, so the entropy source is repeating itself`,
    );
  }

  /** Practice setting → an absolute instant, in UTC, which is how it is stored (rule 8). */
  private expiryFor(practiceTtlDays: number | null, now: Date): Date {
    // A non-positive setting would mint a link that is already dead. That is a
    // configuration mistake rather than a policy, and honouring it literally
    // would break every export for that practice with no error anywhere.
    const days = practiceTtlDays !== null && practiceTtlDays > 0 ? practiceTtlDays : DEFAULT_DOCUMENT_LINK_TTL_DAYS;
    return new Date(now.getTime() + days * MILLISECONDS_PER_DAY);
  }
}

/**
 * Prisma's unique-constraint violation, recognised without importing
 * `Prisma.PrismaClientKnownRequestError` as a value — the `@prisma/client`
 * value import is lint-restricted outside `common/db` (R6).
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}
