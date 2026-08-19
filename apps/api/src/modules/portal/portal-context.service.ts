import { HttpStatus } from '@nestjs/common';

import type { PortalContext } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { chaseItemRefs, isChaseReceivedClose, toChaseItem } from '../chase/index.js';
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
    // A `DELEGATED_UPLOAD` row with no chase is not a portal session this
    // endpoint can answer — there is no item list to show. Same 401 as any
    // other unusable session; a session that cannot see anything is not one.
    const chaseId = facts.chaseId;
    if (chaseId === null) throw portalSessionRequired('missing or invalid portal session');

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

      // `PortalContext.items` is `minItems: 1` in the contract, so an empty list
      // is not a 200 — it is a row that should not exist (the `chase.send`
      // executor resolved every transaction at approve time). Same for a missing
      // business: `chases.business_id` is a NOT NULL foreign key. Both are
      // server-side inconsistencies, which is a 500, not a 4xx blamed on the
      // client; `NT-SRV-001` is the house code and `500` is declared on this
      // operation.
      if (business === null || items.length === 0) throw contextUnavailable();

      return { businessName: business.name, items, expiresAt: facts.expiresAt.toISOString() };
    });
  }
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
