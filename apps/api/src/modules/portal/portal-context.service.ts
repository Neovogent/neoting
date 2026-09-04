import { HttpStatus } from '@nestjs/common';

import type { SubscriptionStatus } from '@prisma/client';

import type { BusinessSubscription, PortalContext } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import { AppException } from '../../common/problem/problem.js';
import {
  chaseItemRefs,
  isChaseReceivedClose,
  statementCoversPeriod,
  statementPeriodOf,
  toChaseItem,
} from '../chase/index.js';
import { type PortalSessionFacts, portalSessionRequired, systemScopeFor } from './portal-session-context.js';

/**
 * `GET /v1/portal/context` — what this portal session may see, and the whole of
 * it (METH Stage 9, SoT §4 Stage 8.3).
 *
 * The client tapped a link in a text, typed six digits, and is now holding a
 * phone in a car park. This is the screen that tells them *which* receipts we
 * are missing: the business whose books they belong to, the chased items
 * (supplier, signed integer pence, booked date, whether it has arrived), and
 * when the session dies.
 *
 * ## Why this reads under the practice SYSTEM context, and what still bounds it
 *
 * `prisma/sql/rls.sql` gives `chases` and `bank_transactions` **no delegated
 * branch** — their policies go through `app_can_access_business()`, which begins
 * `app_session_scope() = 'user'`. A `delegated_upload` context reading either
 * gets an EMPTY set, silently. So this read cannot run under the context the
 * portal's *uploads* run under; it runs under `systemScopeFor(facts)`, the
 * practice SYSTEM context the workers use.
 *
 * That context can see the whole practice, so the boundary here is **not** SQL,
 * and this file does not pretend otherwise (`portal-session-context.ts` states
 * the division in full):
 *
 * - The delegated policies enforce the **document** boundary — a database
 *   guarantee, on the upload path.
 * - The `otp_sessions` row enforces the **chase** boundary — an application
 *   guarantee, here, and it is exactly these three lines: the chase is fetched
 *   `where id = facts.chaseId` (a value the server wrote, never a parameter),
 *   its business must be the session's business, and the transactions are
 *   fetched by the chase's own refs **and** the session's business. Nothing on
 *   this path is derived from anything the caller sent except the bearer.
 *
 * ## The projection is the chase module's, not a second one
 *
 * `toChaseItem` / `chaseItemRefs` / `isChaseReceivedClose` come from
 * `modules/chase`'s public seam. The accountant's chase detail and the client's
 * portal list are *the same facts shown at two trust levels* (the contract says
 * so — one `ChaseItem` schema serves both), and two projections is how they
 * start disagreeing about what is being chased. Money is the integer pence the
 * feed recorded, straight through: no arithmetic, no coercion, no float (R5).
 */
export class PortalContextService {
  constructor(private readonly prisma: PrismaClient) {}

  async getContext(facts: PortalSessionFacts): Promise<PortalContext> {
    // No chase means this is a client signed into their OWN workspace — an
    // ONBOARDING session (D47, §24.5) — not a chase being answered. It used to
    // be a flat 401: the endpoint could only describe a chase, so an invited
    // client who had just paid and signed in had nothing to read and no portal
    // to land on. They get their own workspace instead.
    const chaseId = facts.chaseId;
    if (chaseId === null) return this.getBusinessContext(facts);

    return scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const chase = await db.chase.findUnique({
        where: { id: chaseId },
        select: { businessId: true, itemRefs: true, state: true, transactionId: true },
      });
      // Gone (the chase was deleted under a live session), or — defence in depth
      // — pointing at a business this session is not scoped to. The session row
      // is written with the chase's own business, so a disagreement means one of
      // the two is not what we wrote. Refuse; never pick a winner.
      if (chase === null || chase.businessId !== facts.businessId) {
        throw portalSessionRequired('missing or invalid portal session');
      }

      const business = await db.business.findUnique({ where: { id: facts.businessId }, select: { name: true } });
      const refs = chaseItemRefs(chase);
      const transactions =
        refs.length === 0
          ? []
          : await db.bankTransaction.findMany({ where: { id: { in: refs }, businessId: facts.businessId } });

      // A statement-request chase (engine (c), Phase 5) carries its month as
      // the chase seam's tag instead of transactions. Its `received` is the
      // SAME predicate the close runs — a statement covering the period exists
      // — so the portal and the close cannot disagree.
      const statementPeriod = statementPeriodOf(refs);
      const statementRequests =
        statementPeriod === null
          ? []
          : [{ period: statementPeriod, received: await statementCoversPeriod(db, facts.businessId, statementPeriod) }];

      const byId = new Map(transactions.map((txn) => [txn.id, txn]));
      // ⚠ A CLOSED_RECEIVED chase says ONE line arrived, not all of them.
      //
      // Stage 8's auto-close matches a document against `chase.transaction` and
      // closes the whole chase; for a GROUPED chase ("one text, many receipts",
      // SoT §8.2) the other refs are still outstanding. Deriving `received` from
      // the chase state alone therefore told a client who sent the Currys
      // receipt that the Google one was collected too — the list rendered
      // "nothing is outstanding" and disabled the row, so the second receipt was
      // never sent and the client was told in plain English it was not needed.
      //
      // So the chase-level close credits only the ref it actually matched; every
      // other ref falls back to its own `matchState`, which is per-transaction
      // and true regardless of which channel satisfied it.
      const closedRef = isChaseReceivedClose(chase.state) ? chase.transactionId : null;
      // In the order the chase recorded them — the same order the SMS listed. A
      // ref whose transaction is not there is dropped rather than faked; the
      // client is never shown a placeholder for a receipt we cannot describe.
      const items = refs.flatMap((ref) => {
        const txn = byId.get(ref);
        return txn === undefined ? [] : [toChaseItem(txn, ref === closedRef)];
      });

      // A chase that asks for NOTHING — no transaction items AND no statement
      // request — is a row that should not exist (the executor resolved every
      // item at approve time). Same for a missing business:
      // `chases.business_id` is a NOT NULL foreign key. Both are server-side
      // inconsistencies, which is a 500, not a 4xx blamed on the client;
      // `NT-SRV-001` is the house code and `500` is declared on this operation.
      if (business === null || (items.length === 0 && statementRequests.length === 0)) throw contextUnavailable();

      return {
        businessName: business.name,
        // ⚠ NULL for a chase session, deliberately. Its holder may upload
        // against granted documents and nothing else, so they are given no id
        // they could put in a request body — the same rule
        // `PortalSession.businessId` follows, for the same reason.
        businessId: null,
        items,
        statementRequests,
        summary: null,
        expiresAt: facts.expiresAt.toISOString(),
      };
    });
  }

  /**
   * The client's own portal: who they are, and what is waiting.
   *
   * ## What this is NOT
   *
   * It is not the accountant's `BusinessSummary`. A client has no business
   * knowing how many of their documents sit in the practice's review queue or
   * what its approval backlog looks like — that is the firm's working state.
   * What they get is their own side of the pipeline: what they have sent, what
   * is still being asked of them, and whether their subscription lets them send
   * more.
   *
   * ## Same trust argument as the chase branch
   *
   * The read runs under the practice SYSTEM context for the reason the header
   * gives — the delegated scope cannot see `chases` at all. The boundary is
   * therefore the `otp_sessions` row, and it is this: every query below is
   * filtered by `facts.businessId`, which the server wrote when it opened the
   * session and which no caller can influence. Nothing here is derived from
   * anything the holder sent except the bearer.
   */
  private async getBusinessContext(facts: PortalSessionFacts): Promise<PortalContext> {
    return scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const business = await db.business.findUnique({
        where: { id: facts.businessId },
        // `plan` and `subscriptionCurrentPeriodEnd` join `subscriptionStatus`
        // for `PortalSummary.subscription` — see `toClientSubscription`.
        select: {
          name: true,
          subscriptionStatus: true,
          plan: true,
          subscriptionCurrentPeriodEnd: true,
        },
      });
      if (business === null) throw contextUnavailable();

      // ⚠ `notDeleted()` on BOTH document reads, and they have to move
      // together. `documentsSent` and `lastDocumentAt` are two facts about one
      // set — the client's own file — and `GET /portal/documents` now lists
      // that set without Trash. A count that still included it would say "41
      // sent" over a list of 40, and a `lastDocumentAt` that still included it
      // would date the client's last upload to a document they cannot find.
      // Both are the client's own words for their own file, and neither is a
      // number the practice's housekeeping should be visible in.
      //
      // ⚠ These two still count ARCHIVED, which the list excludes, so the two
      // surfaces are not yet identical sets. That divergence PREDATES soft
      // delete and is left alone here on purpose: an archived document really
      // was sent, and "how many have I sent you" is a fair reading of it. A
      // deleted one is different in kind — the practice has withdrawn it from
      // the file — so it is the half that had to close.
      const [documentsSent, latest, openChases] = await Promise.all([
        db.document.count({ where: { businessId: facts.businessId, ...notDeleted() } }),
        db.document.findFirst({
          where: { businessId: facts.businessId, ...notDeleted() },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        // Every chase still asking for something. CLOSED_* is settled and asks
        // nothing, and a chase composed but not yet sent has not reached this
        // client — counting it would tell them they are late for a request
        // nobody made (D44 splits composition from release).
        db.chase.findMany({
          where: { businessId: facts.businessId, state: { in: ['SENT', 'REMINDED', 'ESCALATED'] } },
          // `transactionId` is selected only because `chaseItemRefs` takes the
          // chase module's own shape — using its projection rather than
          // re-deriving refs here is what keeps the client's count and the
          // accountant's chase list describing the same thing.
          select: { itemRefs: true, transactionId: true },
        }),
      ]);

      // One chase may ask for several receipts (SoT §8.2's grouped chase), so
      // the number that means anything to a client is ITEMS, not chases.
      const awaitingYou = openChases.reduce((total, chase) => total + chaseItemRefs(chase).length, 0);

      // Phase 5: the ITEMISED list — "your accountant is waiting for N
      // documents" now names them. Every open chase's outstanding lines, plus
      // every open statement request, so the client's own portal shows the
      // same asks a chase link would, without the link. Transaction refs are
      // fetched by the chases' own refs AND the session's business (the
      // chase-branch discipline); a ref whose transaction is invisible is
      // dropped, never faked. `received` for a transaction is its own
      // matchState (`toChaseItem`); for a statement, the coverage predicate
      // the close runs.
      const transactionRefs = [
        ...new Set(openChases.flatMap((chase) => chaseItemRefs(chase)).filter((ref) => statementPeriodOf([ref]) === null)),
      ];
      const openTransactions =
        transactionRefs.length === 0
          ? []
          : await db.bankTransaction.findMany({ where: { id: { in: transactionRefs }, businessId: facts.businessId } });
      const items = openTransactions.map((txn) => toChaseItem(txn, false));

      const periods = [
        ...new Set(openChases.flatMap((chase) => statementPeriodOf(chaseItemRefs(chase)) ?? [])),
      ];
      const statementRequests = await Promise.all(
        periods.map(async (period) => ({
          period,
          received: await statementCoversPeriod(db, facts.businessId, period),
        })),
      );

      return {
        businessName: business.name,
        businessId: facts.businessId,
        items,
        statementRequests,
        summary: {
          documentsSent,
          awaitingYou,
          // D48: an upload is refused without a live subscription, so the portal
          // says so before the client photographs a receipt rather than after.
          subscriptionActive: business.subscriptionStatus === 'ACTIVE' || business.subscriptionStatus === 'TRIALING',
          lastDocumentAt: latest?.createdAt.toISOString() ?? null,
          subscription: toClientSubscription(business),
        },
        expiresAt: facts.expiresAt.toISOString(),
      };
    });
  }
}

/**
 * The client's own plan, for the portal's Settings tab (D48/D49, 2 Sep 2026).
 *
 * ## Why this is here and not derived in the browser
 *
 * `subscriptionActive` answers exactly one question — *may I send a document
 * right now* — and a plan panel needs two more: what state the subscription is
 * in, and when it renews. Without them the only honest Settings tab was one
 * with no plan section at all, so the person who PAYS for this product could
 * not see what they pay for, and the client who wanted to cancel had nothing to
 * cancel from.
 *
 * ## What a client may see of it, and what they may not
 *
 * The **same `BusinessSubscription` projection the accountant reads** — the
 * local projection of what Stripe knows — rather than a second, client-only
 * opinion that would drift from it. Nothing is added and nothing is redacted,
 * because there is nothing in that shape a client is not entitled to: it is
 * their own subscription, and it deliberately carries no price (the amount, the
 * VAT and the gross are Stripe's hosted checkout's and Stripe's invoice's, which
 * is where they are correct).
 *
 * `stripeCustomerId` is emphatically NOT in it and must not be added. It is the
 * key `POST /webhooks/stripe` resolves a tenant by, and it is not a fact about
 * a plan.
 *
 * **Null until the client has been through checkout.** `subscriptionStatus` is
 * written ONLY by the Stripe webhook (`modules/billing`), so a null status is a
 * signup that has not finished — a true statement, and not the same as a lapsed
 * one. `status` is the required member of the shape, so there is no honest way
 * to emit an object without it.
 */
function toClientSubscription(business: {
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly plan: string | null;
  readonly subscriptionCurrentPeriodEnd: Date | null;
}): BusinessSubscription | null {
  if (business.subscriptionStatus === null) return null;
  return {
    status: business.subscriptionStatus,
    plan: business.plan,
    currentPeriodEnd: business.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
  };
}

/**
 * The one 500 this read can raise. The detail is written for the person holding
 * the phone — it says what to do next and names no id, no business and no
 * internal state.
 */
function contextUnavailable(): AppException {
  return new AppException(
    'NT-SRV-001',
    HttpStatus.INTERNAL_SERVER_ERROR,
    'Portal context unavailable',
    'We could not load what we are missing from you. Ask your accountant to send the link again.',
  );
}
