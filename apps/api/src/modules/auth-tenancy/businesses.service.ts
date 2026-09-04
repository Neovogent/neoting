import type { z } from 'zod';

import type { BusinessSummary } from '@neoting/contracts/model';
import type { listBusinessesQueryParams } from '@neoting/contracts/zod';
import { Prisma } from '@prisma/client';
import type { Business as BusinessRow, ChaseState, DocumentState, DocumentType } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import { type Page, type PageRequest, pageQuery, scalarField, toPage } from '../../common/pagination/cursor.js';
import { toBusinessSubscription } from '../billing/index.js';

type ListQuery = z.infer<typeof listBusinessesQueryParams>;

/**
 * The one sort order this endpoint has. The contract fixes it in prose
 * ("A page of workspaces, alphabetical") and declares no `sort` parameter, so
 * it is a constant, not a lookup table. `name` is required in the schema, so
 * `nullable: false` — Prisma throws on the `{ sort, nulls }` shape for a
 * required column (the trap `common/pagination/cursor.ts` documents).
 */
const NAME = scalarField<BusinessRow>('name', (row) => row.name, false);

/**
 * The document states the header badges count, and where each lands. The
 * contract's `BusinessSummary.counts` groups exactly three ways: `toReview`,
 * `ready`, and `failed` — "REJECTED and FAILED together", its own words —
 * so the fold is a table, not arithmetic scattered over branches.
 */
const COUNTED: Partial<Record<DocumentState, keyof BusinessSummary['counts']>> = {
  TO_REVIEW: 'toReview',
  READY: 'ready',
  REJECTED: 'failed',
  FAILED: 'failed',
  // Approved and released for export (D42). An INTERNAL state: it is what the
  // Export screen builds a VT import file from, and nothing here may be worded
  // as having reached a ledger.
  PUBLISHED: 'published',
};

/**
 * Where a chase's state lands on the Clients board.
 *
 * The board asks three different questions of the same queue — what is missing,
 * what have we already asked for, and what is late — so one `groupBy` over
 * `ChaseState` answers all three rather than three counts over three filters.
 *
 * `DETECTED` is the honest reading of "missing": the gap is known and no text
 * has gone out. `PROPOSED` and `APPROVED` are deliberately NOT counted as
 * requested — a chase composed but not sent has not reached the client, and
 * counting it would tell an accountant they had chased when they had not
 * (D44 splits composition from release precisely because those differ).
 * Everything `CLOSED_*` is settled and belongs in no column.
 */
const CHASE_COUNTED: Partial<Record<ChaseState, keyof BusinessSummary['counts']>> = {
  DETECTED: 'missing',
  SENT: 'requested',
  REMINDED: 'requested',
  ESCALATED: 'overdue',
};

/** The default list serves live workspaces only — see the where clause below. */
const ACTIVE_ONLY: Prisma.BusinessWhereInput = { isActive: true };

/** Every count at zero — a client with nothing waiting, which is a real state. */
const ZERO_COUNTS: BusinessSummary['counts'] = {
  toReview: 0,
  ready: 0,
  failed: 0,
  published: 0,
  missing: 0,
  requested: 0,
  overdue: 0,
  unmatched: 0,
  statementGaps: 0,
  approvals: 0,
};

/**
 * The businesses read surface (METH Stage 6; contracted in Stage 2 #120).
 *
 * `GET /me` answers "who am I"; this answers "what is waiting where" — the
 * context header, the client switcher and the Clients list all render from it.
 *
 * **One GET, no write anywhere on this class.** Businesses are created by
 * onboarding (post-demo surface), never here — `x-nt-side-effect: none`.
 *
 * **Tenancy is RLS and nothing else.** Both queries run inside one `scopedDb`
 * transaction: the page of businesses is whatever the policies make visible
 * (exactly the same set `/me` reports, because it is the same context), and
 * the counts aggregate can only ever count documents the caller could list
 * anyway. No hand-written practice/business clause narrows or widens it.
 *
 * **One cheap aggregate, not N queries.** The counts come from a single
 * `groupBy (businessId, state)` over the page's ids — the "one cheap
 * aggregate" the contract description promises. Unrouted documents have no
 * `businessId` and are excluded by the `in` filter, which is also the
 * contract's wording: "counted nowhere here".
 */
export class BusinessesService {
  constructor(private readonly prisma: PrismaClient) {}

  async listBusinesses(ctx: ScopeContext, query: ListQuery): Promise<Page<BusinessSummary>> {
    const request: PageRequest<BusinessRow> = {
      sort: NAME,
      order: 'asc',
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor — the fingerprint identifies the
      // LIST, not the caller's position in it (see modules/documents/CLAUDE.md).
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);

    const { rows, grouped, chases, unmatched, approvals, statementGaps, primaryContacts, inviteTimes } = await scopedDb(this.prisma, ctx, async (db) => {
      const rows = await db.business.findMany({
        // NOT a tenancy clause (RLS alone decides reach) — a STATE filter:
        // an offboarded workspace (`business.offboard` flipped `isActive`
        // off) has left the working surfaces, and the Clients list, switcher
        // and context header all render from this page. Its books, documents
        // and audit trail are retained (D12) and stay reachable by id; only
        // the default list stops offering it. `@@index([practiceId, isActive])`
        // carries the filter.
        where: seek.where === undefined ? ACTIVE_ONLY : { AND: [ACTIVE_ONLY, seek.where as Prisma.BusinessWhereInput] },
        orderBy: seek.orderBy as Prisma.BusinessOrderByWithRelationInput[],
        take: seek.take,
      });
      // Grouped over the fetched ids (at most limit + 1 — the extra row's
      // counts are computed and discarded, which is cheaper than a second
      // round-trip after the trim).
      const ids = rows.map((row) => row.id);
      // Four aggregates, not four-per-business: each is one `groupBy` over the
      // whole page, so the query count is fixed no matter how many clients the
      // practice has. They are issued together — inside the one `scopedDb`
      // transaction, so every one of them sees the same RLS-visible set the
      // page itself came from, and none can widen it.
      const [grouped, chases, unmatched, approvals, statementGaps, primaryContacts, inviteTimes] = await Promise.all([
        db.document.groupBy({
          // `docType` rides in the grouping so the fold can exclude STATEMENT
          // documents from toReview/ready — the review tabs exclude them too
          // (`onStatusTab`, apps/web), and a badge that counts rows the tab
          // will never show is a to-do list nobody can clear (4 Sep 2026).
          by: ['businessId', 'state', 'docType'],
          where: {
            businessId: { in: ids },
            state: { in: Object.keys(COUNTED) as DocumentState[] },
            // Trash is excluded from every count, through the one helper that
            // spells the predicate (`common/documents/deleted-documents.ts`).
            // A document a person deleted must not keep a client's "3 to
            // review" badge lit on the Clients board — that badge is a
            // to-do list, and an item on it that no screen will ever show is
            // work nobody can do.
            ...notDeleted(),
          },
          _count: { _all: true },
        }),
        db.chase.groupBy({
          by: ['businessId', 'state'],
          where: { businessId: { in: ids }, state: { in: Object.keys(CHASE_COUNTED) as ChaseState[] } },
          _count: { _all: true },
        }),
        // `chaseSuppressed` lines are excluded on purpose: they are bank-
        // originated entries with no paperwork to find (bank interest, card
        // fees), so counting them would put a number on screen that no amount
        // of chasing can ever bring down.
        db.bankTransaction.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids }, matchState: 'UNMATCHED', chaseSuppressed: false },
          _count: { _all: true },
        }),
        // The same definition of "pending" the chat suggestions use
        // (`suggestions.service.ts`): CREATED is proposed, REVIEWED is read but
        // not yet approved. Both are waiting on a human, which is what the
        // column means.
        db.actionProposal.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids }, state: { in: ['CREATED', 'REVIEWED'] } },
          _count: { _all: true },
        }),
        // D41: a statement whose completeness could not be PROVED. Both
        // `incomplete` (a break in the balance chain, or a dropped line) and
        // `reduced` (no balance column, so nothing could be checked) count —
        // the column asks "how many statements am I not sure about", and a
        // reduced-assurance file is exactly that. A statement predating this
        // lane has no `gapAnalysis` at all and is counted nowhere, which is
        // right: it was never assessed, so there is no finding to report.
        db.statement.groupBy({
          by: ['businessId'],
          where: {
            businessId: { in: ids },
            NOT: { gapAnalysis: { path: ['assurance'], equals: 'complete' } },
            gapAnalysis: { not: Prisma.DbNull },
          },
          _count: { _all: true },
        }),
        // The primary contact's address, for `primaryContactEmail`. A fifth
        // read over the same page of ids rather than a nested `include` on the
        // findMany above — same reason the four aggregates are shaped this way:
        // the query count stays fixed no matter how many clients a practice
        // has, and it runs inside the same `scopedDb` transaction, so
        // `contacts_tenant` decides what it can see. `contacts` DOES carry RLS
        // (unlike `memberships`), so there is no hand-written tenancy clause
        // here and there must not be one.
        //
        // ⚠ `isPrimary: true` with NO fallback to any other contact, matching
        // `billing.service.ts` and `compose-chase-send.ts` — the two places
        // that already resolve this person. D45 lets a client add their own
        // team members and `team.service.ts` writes them `isPrimary: false`;
        // promoting one of those would put a warehouse assistant's address
        // where the accountant expects the business owner's, on the panel the
        // accountant reads to know who they are dealing with. A client with no
        // primary contact reports null, which the contract says is a real
        // answer and the UI renders as an em dash.
        db.contact.findMany({
          where: { businessId: { in: ids }, isPrimary: true },
          // Name and mobile joined the select on 5 Sep 2026: the client's
          // Settings tab rendered PRIMARY CONTACT and MOBILE rows this
          // response had no fields for, so intake-captured facts drew as
          // permanent em dashes and the setup-link panel gated its send button
          // on a mobile it could never see.
          select: { businessId: true, email: true, firstName: true, lastName: true, mobileE164: true },
          // Earliest first, so `foldPrimaryContacts`' first-wins is
          // "the primary contact this client has had longest" rather than
          // whichever row the planner happened to return first. Intake writes
          // exactly one primary, so this only decides a case that should not
          // arise — but "should not arise" is not an ordering guarantee.
          orderBy: { createdAt: 'asc' },
        }),
        // The send FACT for `setupLinkSentAt` (5 Sep 2026): the latest invite's
        // own timestamp, per business — never the token, which lives hashed.
        // The panel used to read a synthetic array and therefore claimed "no
        // setup link has been sent" straight after intake emailed one.
        db.invite.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids } },
          _max: { createdAt: true },
        }),
      ]);
      return { rows, grouped, chases, unmatched, approvals, statementGaps, primaryContacts, inviteTimes };
    });

    const counts = foldCounts(grouped, chases, unmatched, approvals, statementGaps);
    const contactsByBusiness = foldPrimaryContacts(primaryContacts);
    const setupLinkTimes = new Map(inviteTimes.map((row) => [row.businessId, row._max.createdAt]));
    const page = toPage(rows, request);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        name: row.name,
        tradingName: row.tradingName,
        // Both already on the row — the Clients list prints the sector under
        // the name and the deadline in its last column, and neither needed a
        // schema change to reach it. Null where the client has not said: an
        // invite-path record has no sector until they register, and not every
        // client is working towards a filing date.
        industry: row.industry,
        nextDeadline: row.nextDeadline === null ? null : toIsoDate(row.nextDeadline),
        // Null for a client with no primary contact, and null for a primary
        // contact with no address on file (`contacts.email` is nullable — a
        // §3.3 phone-only contact is a real record). Both are the same honest
        // answer: we do not hold an email for this client. Nothing derives one
        // from the practice, the trading name or a team member.
        primaryContactEmail: contactsByBusiness.get(row.id)?.email ?? null,
        // Name and mobile from the SAME first-wins row as the email — three
        // facts about one person, never three lookups that could disagree.
        primaryContactName: contactsByBusiness.get(row.id)?.name ?? null,
        primaryContactMobile: contactsByBusiness.get(row.id)?.mobile ?? null,
        // The latest invite's own timestamp, or null when none was ever sent.
        setupLinkSentAt: setupLinkTimes.get(row.id)?.toISOString() ?? null,
        counts: counts.get(row.id) ?? ZERO_COUNTS,
        // The D48 projection, from the four columns already on the row — no
        // second query and no second round-trip. `error-codes.md` asks for it
        // by name under NT-BIL-002: the subscribe call-to-action must not
        // render for a business that already has a subscription, and a lapsed
        // client should show in the switcher rather than being discovered at
        // the next upload. Null for a business that has never been to
        // checkout, which is what the contract says the field means.
        subscription: toBusinessSubscription(row),
      })),
      pageInfo: page.pageInfo,
    };
  }
}

/**
 * `YYYY-MM-DD`, which is what the contract declares `nextDeadline` to be.
 *
 * `toISOString().slice(0, 10)` and not a local-time format: storage is UTC
 * (Governance), the column is a bare filing date rather than an instant, and
 * rendering it through a London offset would move a 1 January deadline to
 * 31 December for anyone reading from a negative-offset timezone.
 */
function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The primary contact's address per business, from the page's contacts read.
 *
 * **First row wins**, and the caller orders by `created_at` ascending, so that
 * is the longest-standing primary contact. Intake writes exactly one primary
 * per business (`client-intake.service.ts`), so a second is a state no path in
 * this repo creates — which is precisely why the tie is broken by a rule rather
 * than left to the planner: a field that silently changed which person it named
 * between two page loads would be worse than one that never populated.
 *
 * A contact whose `email` is null still WINS its business and contributes null.
 * That is deliberate. This field names one person's address, and skipping past
 * a primary contact with no address on file to report the next contact's would
 * put a different person's email under the words "primary contact" — the
 * misattribution the contract description forbids.
 *
 * Exported for its test.
 */
export interface PrimaryContactFacts {
  readonly email: string | null;
  readonly name: string | null;
  readonly mobile: string | null;
}

export function foldPrimaryContacts(
  contacts: ReadonlyArray<{
    businessId: string;
    email: string | null;
    firstName?: string | null;
    lastName?: string | null;
    mobileE164?: string | null;
  }>,
): Map<string, PrimaryContactFacts> {
  const byBusiness = new Map<string, PrimaryContactFacts>();
  for (const contact of contacts) {
    if (byBusiness.has(contact.businessId)) continue;
    // "Ana Rossi", "Ana", "Rossi" — whatever the row holds, joined; null when
    // it holds neither half. A contact with no name is a real §3.3 record and
    // the panel renders an em dash rather than the email retyped as a name.
    const name = [contact.firstName, contact.lastName].filter((part) => part != null && part !== '').join(' ');
    byBusiness.set(contact.businessId, {
      email: contact.email,
      name: name === '' ? null : name,
      mobile: contact.mobileE164 ?? null,
    });
  }
  return byBusiness;
}

/**
 * The four aggregates folded into one set of per-business counts.
 *
 * Every business that appears in ANY of the four gets a full, zero-filled
 * record: the contract makes all ten counts required, and a client with three
 * unmatched bank lines and no documents must still report `toReview: 0` rather
 * than arriving without the key.
 *
 * Exported for its test.
 */
export function foldCounts(
  grouped: ReadonlyArray<{ businessId: string | null; state: DocumentState; docType?: DocumentType | null; _count: { _all: number } }>,
  chases: ReadonlyArray<{ businessId: string; state: ChaseState; _count: { _all: number } }> = [],
  unmatched: ReadonlyArray<{ businessId: string | null; _count: { _all: number } }> = [],
  approvals: ReadonlyArray<{ businessId: string | null; _count: { _all: number } }> = [],
  /**
   * Statements whose D41 assurance is NOT `complete` — one row per business.
   *
   * This count was hardcoded to zero until 28 Aug 2026, honestly, because
   * nothing in the repo wrote `Statement.gapAnalysis`. `statement-ingest.ts` is
   * now its first writer, so the number has a real source and the column on the
   * Clients board finally means what it says.
   */
  statementGaps: ReadonlyArray<{ businessId: string | null; _count: { _all: number } }> = [],
): Map<string, BusinessSummary['counts']> {
  const byBusiness = new Map<string, BusinessSummary['counts']>();
  /** The zero-filled record for this business, created on first sight of it. */
  const bucketFor = (businessId: string): BusinessSummary['counts'] => {
    const existing = byBusiness.get(businessId);
    if (existing !== undefined) return existing;
    const fresh = { ...ZERO_COUNTS };
    byBusiness.set(businessId, fresh);
    return fresh;
  };

  for (const row of grouped) {
    const bucket = COUNTED[row.state];
    if (row.businessId === null || bucket === undefined) continue;
    // A STATEMENT document is not on the To Review or Ready tabs (its home is
    // the Statements panel and the D41 verdict), so it must not light their
    // badges either. It STAYS counted in failed/published — a statement whose
    // READ failed is real work, and hiding it would be the worse direction.
    if (row.docType === 'STATEMENT' && (bucket === 'toReview' || bucket === 'ready')) continue;
    bucketFor(row.businessId)[bucket] += row._count._all;
  }
  for (const row of chases) {
    const bucket = CHASE_COUNTED[row.state];
    if (bucket === undefined) continue;
    bucketFor(row.businessId)[bucket] += row._count._all;
  }
  for (const row of unmatched) {
    if (row.businessId === null) continue;
    bucketFor(row.businessId).unmatched += row._count._all;
  }
  for (const row of approvals) {
    if (row.businessId === null) continue;
    bucketFor(row.businessId).approvals += row._count._all;
  }
  for (const row of statementGaps) {
    if (row.businessId === null) continue;
    bucketFor(row.businessId).statementGaps += row._count._all;
  }

  // `statementGaps` is folded by the caller, from the statements aggregate.
  return byBusiness;
}
