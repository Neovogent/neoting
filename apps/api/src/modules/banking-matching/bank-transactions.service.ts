import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { BankTransaction, DocumentBankMatch } from '@neoting/contracts/model';
import { listBankTransactionsQueryParams } from '@neoting/contracts/zod';
import type { BankTransaction as BankTransactionRow, Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { toBankTransaction } from './bank-transaction-response.js';

type ListQuery = z.infer<typeof listBankTransactionsQueryParams>;

/**
 * The one sort order this endpoint has.
 *
 * `listBankTransactions` declares no `sort` or `order` parameter — the contract
 * fixes the answer in prose instead ("The normalised feed, newest first" /
 * "A page of transactions, newest booked first"). So the sort is a constant
 * here rather than a lookup table: there is no caller-supplied column to
 * validate, and offering one would be inventing contract surface.
 *
 * `nullable: false` because `booked_at` is required in the schema — Prisma
 * throws at runtime on `orderBy: { col: { sort, nulls } }` for a required
 * column, which is the trap `common/pagination/cursor.ts` documents.
 */
const BOOKED_AT = dateField<BankTransactionRow>('bookedAt', (row) => row.bookedAt, false);

/**
 * The bank read surface (METH Stage 11, SoT §4 Stage 7).
 *
 * **One GET, and no write anywhere on this class** — structurally, the way the
 * documents service has no write. Confirming a match is a `bank.confirm-match`
 * proposal on the Review → Approve spine (Governance §10); there is no
 * `PATCH /bank-transactions/{id}` and none may exist, so the absence of a
 * mutating method here is the enforcement rather than a promise in prose. The
 * contract says the same thing: `x-nt-side-effect: none`.
 *
 * **Tenancy is RLS and nothing else.** Every query runs inside `scopedDb`;
 * nothing here adds a `businessId` clause to *enforce* scope. The optional
 * `businessId` filter below narrows a set RLS has already bounded — a
 * hand-written tenancy filter alongside a policy is two mechanisms that can
 * disagree, and the more permissive one wins exactly when it matters. Asking
 * for a business the caller cannot reach returns an empty page: the rows were
 * already invisible, so the filter matches none of them, and the answer never
 * confirms whether that business exists (404-never-403, applied to a list).
 *
 * **The unmatched set this returns is the set chase detection reads.** Both
 * read `match_state` and `chase_suppressed` off the same rows, so the Bank
 * screen and the chase list cannot disagree — which is why the confirm-match
 * executor flips `match_state` rather than writing a `matches` row alone.
 */
export class BankTransactionsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listBankTransactions(ctx: ScopeContext, query: ListQuery): Promise<Page<BankTransaction>> {
    const request: PageRequest<BankTransactionRow> = {
      sort: BOOKED_AT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor. `cursor` is a field OF the query, so
      // folding it into the fingerprint would make every page-2 request 400 —
      // the bug `modules/documents/CLAUDE.md` records in full. The fingerprint
      // identifies the LIST; the caller's position in it is not part of that.
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);
    const filters = buildFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.bankTransaction.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.BankTransactionOrderByWithRelationInput[],
        take: seek.take,
        // The CONFIRMED match's document — `matchedDocumentId` on the wire
        // (Phase 4). A live match per transaction is at most one by the
        // confirm executor's own rules; `take: 1` states it rather than
        // trusting it. SUGGESTED deliberately does not fill the field — a
        // suggestion is a question, and the document's bank-match read is
        // where the question lives.
        include: {
          matches: { where: { state: 'CONFIRMED', unmatchedAt: null }, select: { documentId: true }, take: 1 },
        },
      }),
    );

    const page = toPage(rows, request);
    return {
      data: page.data.map((row) => toBankTransaction(row, row.matches?.[0]?.documentId ?? null)),
      pageInfo: page.pageInfo,
    };
  }

  /**
   * `GET /documents/{documentId}/bank-match` (Phase 4) — the one live match
   * linking this document to a bank line: CONFIRMED when one exists, else the
   * newest SUGGESTED, else `match: null`. Read-only; confirming is a
   * `bank.confirm-match` proposal, and this surface exists precisely so the
   * DocumentPreview can stop inventing one (the PR #230 gap).
   *
   * The document is resolved through RLS FIRST: an unreachable document and an
   * absent one are the same 404, and neither confirms existence. A reachable
   * document with no match is the honest `{ match: null }` — an answer, not
   * an error.
   */
  async getDocumentBankMatch(ctx: ScopeContext, documentId: string): Promise<DocumentBankMatch> {
    return scopedDb(this.prisma, ctx, async (db) => {
      const document = await db.document.findUnique({ where: { id: documentId }, select: { id: true } });
      if (document === null) {
        throw new AppException(
          'NT-VAL-001',
          HttpStatus.NOT_FOUND,
          'Not found',
          'The requested record does not exist.',
        );
      }

      const row = await db.match.findFirst({
        where: { documentId, unmatchedAt: null },
        // CONFIRMED outranks SUGGESTED; among suggestions the newest wins.
        // Enum order in Prisma sorts by declaration (UNMATCHED < SUGGESTED <
        // CONFIRMED < EXCLUDED), so `state desc` would put EXCLUDED first —
        // order explicitly instead.
        orderBy: [{ createdAt: 'desc' }],
        include: { transaction: true },
      });
      const preferred =
        row === null || row.state === 'CONFIRMED'
          ? row
          : ((await db.match.findFirst({
              where: { documentId, unmatchedAt: null, state: 'CONFIRMED' },
              include: { transaction: true },
            })) ?? row);
      if (preferred === null || (preferred.state !== 'CONFIRMED' && preferred.state !== 'SUGGESTED')) {
        return { match: null };
      }

      return {
        match: {
          id: preferred.id,
          state: preferred.state,
          kind: preferred.kind,
          confidence: preferred.confidence,
          matchedBy: preferred.matchedBy,
          // The embedded transaction carries ITS confirmed document — this one
          // when the match is CONFIRMED, nothing otherwise (a SUGGESTED match
          // fills no matchedDocumentId, the contract's own rule).
          transaction: toBankTransaction(
            preferred.transaction,
            preferred.state === 'CONFIRMED' ? preferred.documentId : null,
          ),
        },
      };
    });
  }
}

/**
 * The caller's filters, and **not** a security boundary — RLS is. Every clause
 * here narrows what the policies already allow; none of them may widen it.
 *
 * All three are absent-means-everything, which is the contract's own wording:
 * `matchState` is "Repeat to widen. Omitted means every state." There is no
 * hidden default the way `GET /documents` excludes ARCHIVED — a bank feed has
 * no archive, and a transaction quietly missing from the Bank screen is a
 * reconciliation that silently never balances.
 */
function buildFilters(query: ListQuery): Prisma.BankTransactionWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
    ...(query.accountId !== undefined ? { accountId: query.accountId } : {}),
    // `length > 0` matters: an explicitly empty `matchState` array would
    // otherwise compile to `{ in: [] }`, which matches nothing and reads on
    // screen as "the feed is empty" rather than "you filtered everything out".
    ...(query.matchState !== undefined && query.matchState.length > 0
      ? { matchState: { in: query.matchState } }
      : {}),
  };
}
