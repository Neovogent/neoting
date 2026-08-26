import { createHash } from 'node:crypto';

import { HttpStatus, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { resolveSystemActor } from '../../../common/db/resolve-system-actor.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import type { DocumentStore } from '../../ingestion-routing/index.js';

import { CapabilityCodeSchema, normaliseCapabilityCode } from './capability-code.js';
import type { CapabilityLinkRateLimiter } from './link-rate-limit.js';

/**
 * ============================================================================
 *  `GET /d/{code}` — THE ONE ROUTE OUTSIDE THE SESSION WALL
 * ============================================================================
 *
 * **This endpoint is UNAUTHENTICATED BY DESIGN. The code IS the
 * authorisation.** There is no cookie, no bearer, no `ScopeContext` from a
 * request, and no RLS predicate keyed on a user — because there cannot be one.
 * An accountant reads the code out of a CSV column inside VT Transaction+,
 * where no session of ours can exist, and reaches the document that line came
 * from. That is SoT §24.7's acceptance test for the whole release, and D43 is
 * written on the *outcome* rather than the mechanism precisely because of it.
 *
 * It is also **an unauthenticated URL to a client's financial document**, which
 * is why five things below are load-bearing rather than decorative. SoT §24.3.2
 * calls them binding, and the privacy notice tells customers we have them:
 *
 * | | Where |
 * |---|---|
 * | Unguessable | `capability-code.ts` — 40 bits from `crypto.randomBytes` |
 * | View-only, one document | this file: the only read is that document's bytes |
 * | Individually revocable | `revoke-link.executor.ts`, on the Approve path |
 * | Access-logged | this file: a `document_events` row + the two counters |
 * | Expiring | `document-link.service.ts`, per practice |
 * | Rate-limited | `link-rate-limit.ts` — per code AND per IP |
 *
 * ## ⚠ THE ONE UNSCOPED QUERY IN THIS MODULE
 *
 * `app_resolve_document_link(code)` is called on the ROOT Prisma client, with
 * no `scopedDb` around it. That is deliberate, it is the only such call here,
 * and `prisma/sql/rls.sql` §4b spends fifty lines justifying it — read that
 * before changing anything in `resolveLinkRow` below.
 *
 * The short version: to resolve a code we need the row; to read the row under
 * RLS we need a practice-scoped actor; and the practice is precisely what the
 * row would have told us. Every policy branch begins `app_actor_id() IS NOT
 * NULL`, so this lookup cannot happen inside a scope context at all. The
 * `SECURITY DEFINER` function is the whole of the bypass: it takes a code and
 * returns **at most one row of four opaque ids plus two booleans**. It reads no
 * financial data, it cannot be made to return more than one row (`code` is
 * UNIQUE), and everything after it — the document read, the access log, the
 * counter — re-enters through `scopedDb(systemContext(...))` like any worker.
 *
 * ## 404, 410, and why they differ here when they differ nowhere else
 *
 * The house rule is 404-never-403: a status that confirms a record exists is a
 * leak (`packages/contracts/CLAUDE.md`). This route keeps the "never 403" half
 * absolutely — there is no ownership check that could produce one — and
 * **deliberately splits 404 from 410**, which is the contract's explicit
 * instruction on this path item and rls.sql's explicit instruction on the
 * function:
 *
 * - **404** — no such code, a malformed code, a code whose document has since
 *   gone. Indistinguishable from a code that never existed, because that is
 *   what it is.
 * - **410 `NT-EXP-002`** — revoked or expired.
 *
 * The usual reasoning does not apply: the code is CSPRNG-generated and rate
 * limited, so *"this code once existed"* is not a useful oracle to an attacker
 * who cannot generate a candidate that ever did — while an accountant holding a
 * dead link inside their ledger genuinely needs to be told it was revoked
 * rather than left believing they mistyped it. Both the contract and the
 * database function say this in their own comments; do not "fix" it back to a
 * uniform 404 without changing both.
 */

/** How long the presigned URL the redirect points at stays valid. */
const REDIRECT_URL_TTL_SECONDS = 120;

/**
 * The `SECURITY DEFINER` resolver's return shape, parsed rather than trusted.
 *
 * Rule 4 says Zod at every boundary including adapter responses, and a raw SQL
 * result is exactly that: `$queryRaw` types whatever the caller asserts, so
 * without this the compiler would happily believe a function that had been
 * changed underneath us. The two booleans decide 410 versus 200, so a `null`
 * arriving where a boolean was expected must be a loud parse failure and not a
 * falsy value that quietly serves a revoked link.
 */
const ResolvedLinkRowSchema = z.object({
  link_id: z.string().min(1),
  document_id: z.string().min(1),
  business_id: z.string().min(1),
  practice_id: z.string().min(1).nullable(),
  revoked: z.boolean(),
  expired: z.boolean(),
});

type ResolvedLinkRow = z.infer<typeof ResolvedLinkRowSchema>;

export interface CapabilityLinkRequest {
  /** Straight off the URL path, un-normalised and unvalidated. */
  readonly code: string;
  /** Express's `req.ip`. See the trust-proxy warning in `link-rate-limit.ts`. */
  readonly ip?: string | undefined;
  /** For the access log, so one document's whole history shares a trace. */
  readonly traceId?: string | undefined;
}

export interface CapabilityLinkRedirect {
  /** A short-lived, object-scoped URL. Never the bytes — this API is not a file server. */
  readonly url: string;
  readonly expiresAt: Date;
}

export class CapabilityLinkService {
  private readonly logger = new Logger(CapabilityLinkService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly rateLimiter: CapabilityLinkRateLimiter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(request: CapabilityLinkRequest): Promise<CapabilityLinkRedirect> {
    const code = normaliseCapabilityCode(request.code);

    // ── 1. The ceiling, BEFORE anything looks the code up ────────────────────
    // Consumed for malformed and unknown codes as well as real ones. That
    // ordering is the whole anti-guessing control: every request an attacker
    // makes is a miss, so if misses were free the ceiling would bound nothing.
    const verdict = await this.rateLimiter.consume({ code, ip: request.ip });
    if (!verdict.allowed) {
      // `limitedBy` stays in the log and out of the response. Telling a caller
      // *which* ceiling refused tells them how to stay under the other one.
      this.logger.warn(`capability link rate limited by ${verdict.limitedBy ?? 'unknown'}`);
      throw new AppException(
        'NT-RATE-001',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many requests',
        `Too many requests for document links. Try again in ${verdict.retryAfterSeconds} seconds.`,
      );
    }

    // ── 2. Shape ─────────────────────────────────────────────────────────────
    // A code outside the alphabet can never have been minted, so it is a miss
    // and not a 400. The contract declares no 400 on this path item for exactly
    // that reason: a validation error would tell a scanner which shapes are
    // worth trying.
    const parsed = CapabilityCodeSchema.safeParse(code);
    if (!parsed.success) throw notFound();

    // ── 3. The one unscoped read (see the file header, and rls.sql §4b) ───────
    const row = await this.resolveLinkRow(parsed.data);
    if (row === null) throw notFound();
    if (row.revoked || row.expired) throw gone(row.revoked);

    if (row.practice_id === null) {
      // A standalone business (no practice) has no SYSTEM actor to re-enter
      // under, so there is no scoped context in which to read the document.
      // ID cannot create one — a practice signs up and invites its clients
      // (D39/D47) — so reaching this is our bug, not the caller's, and it
      // leaves as a logged 500 rather than a 404 that hides it forever.
      throw new Error(`document link ${row.link_id} belongs to a business with no practice — no SYSTEM actor exists to resolve it`);
    }

    // ── 4. Back inside the scope, as the practice's SYSTEM actor ──────────────
    const systemUserId = await resolveSystemActor(this.prisma, row.practice_id);
    const ctx = systemContext(row.practice_id, systemUserId);
    const at = this.now();

    const document = await scopedDb(this.prisma, ctx, async (db) => {
      // `findUnique` on the id the LINK named, and nothing else. The token
      // authorises exactly one document; there is no filter here a caller could
      // influence, and RLS is still the boundary underneath.
      const found = await db.document.findUnique({
        where: { id: row.document_id },
        select: { id: true, s3Key: true, mimeType: true, byteSize: true, originalFilename: true },
      });
      if (found === null) return null;

      // ── The access log ───────────────────────────────────────────────────
      // Two records, and they are not redundant. The counters on
      // `document_links` are the cheap projection the revoke screen renders —
      // "12 views, last one on Tuesday" is the whole question an accountant
      // asks before revoking, and it should not cost a log scan. The
      // `document_events` row is the narrative one, and it lands in the same
      // per-document processing log every other stage writes to, so a
      // document's whole life reads in one place.
      //
      // ⚠ It is NOT an `audit_events` row, and that is a deliberate, recorded
      // shortfall rather than an oversight. The hash-chained writer lives in
      // `modules/approvals/audit-writer.ts` with no public seam, and a second
      // implementation of a hash chain is a chain that fails verification the
      // first time the two canonicalisations disagree. Promoting this to the
      // audit stream means moving that writer to `common/audit/` — a shared
      // path outside this stage. See the module's CLAUDE.md.
      await db.documentLink.update({
        where: { id: row.link_id },
        data: { accessCount: { increment: 1 }, lastAccessedAt: at },
      });
      await db.documentEvent.create({
        data: {
          documentId: found.id,
          stage: 'source-link',
          outcome: 'accessed',
          traceId: request.traceId ?? null,
          detail: {
            linkId: row.link_id,
            // A PSEUDONYM, not an anonymisation, and it is worth being precise
            // about which: an IPv4 space is small enough to brute-force back
            // out of a digest. It is here so "was this one accountant or a
            // thousand hosts" has an answer, and it is hashed so the raw
            // address never lands in a log or a JSON column (Governance §11.6).
            callerPseudonym: pseudonymise(request.ip),
          },
        },
      });

      return found;
    });

    if (document === null) throw notFound();

    // Presign OUTSIDE the transaction: signing is a pure local computation over
    // the key, and holding a database transaction across it pins a connection
    // for no reason (Governance §5.1).
    const signed = await this.store.presignGet({
      key: document.s3Key,
      expiresInSeconds: REDIRECT_URL_TTL_SECONDS,
      // The STORED mime type, magic-byte-authoritative after sanitisation —
      // never the uploader's declared one. Pinning it stops a browser sniffing
      // the bytes and deciding an uploaded file is something executable, which
      // matters more here than anywhere: this URL is opened by a stranger to
      // our session, from inside someone else's software.
      contentType: document.mimeType,
      filename: document.originalFilename,
    });

    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * ⚠ **THE UNSCOPED QUERY. The only one in this module.**
   *
   * Isolated into its own method so it is greppable, reviewable and impossible
   * to widen by accident: it takes an already-validated code, it names one
   * function, and it returns a parsed row of ids and booleans. It cannot be
   * made to return document content, and it cannot return more than one row.
   *
   * `$queryRaw` with a tagged template, so `code` is a bind parameter and never
   * interpolated — the same rule `scopedDb`'s `set_config` follows, and for the
   * same reason: this value comes off a public URL a stranger controls.
   */
  private async resolveLinkRow(code: string): Promise<ResolvedLinkRow | null> {
    const rows = await this.prisma.$queryRaw<
      unknown[]
    >`SELECT link_id, document_id, business_id, practice_id, revoked, expired FROM app_resolve_document_link(${code})`;

    const first = rows[0];
    if (first === undefined) return null;
    if (rows.length > 1) {
      // `document_links.code` is UNIQUE, so this is unreachable through the
      // schema. If it ever happens the function has been redefined, and serving
      // an arbitrary one of two rows would be serving an arbitrary client's
      // document.
      throw new Error(`app_resolve_document_link returned ${rows.length} rows for one code — the UNIQUE constraint on document_links.code is gone`);
    }
    return ResolvedLinkRowSchema.parse(first);
  }
}

/**
 * The 404, worded so it says nothing.
 *
 * `NT-VAL-001` because the contract's `ErrorCode` enum has **no** dedicated
 * not-found code — the same choice `modules/documents` and web-upload made, and
 * checked against the enum rather than assumed. The detail never echoes the
 * code back: a reflected value is a small XSS surface on a route people paste
 * URLs into, and it tells the caller their input was received, which is one bit
 * more than "no".
 */
function notFound(): AppException {
  return new AppException(
    'NT-VAL-001',
    HttpStatus.NOT_FOUND,
    'Not found',
    'No document link with that code.',
  );
}

/** 410 `NT-EXP-002` — the contract's own code and, near enough, its own words. */
function gone(revoked: boolean): AppException {
  return new AppException(
    'NT-EXP-002',
    HttpStatus.GONE,
    'Link no longer available',
    revoked
      ? 'This document link has been revoked. Ask the practice for a fresh export.'
      : 'This document link has expired. Ask the practice for a fresh export.',
  );
}

/** SHA-256, truncated. See the comment at the call site for what this is and is not. */
function pseudonymise(ip: string | undefined): string | null {
  if (ip === undefined || ip === '') return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}
