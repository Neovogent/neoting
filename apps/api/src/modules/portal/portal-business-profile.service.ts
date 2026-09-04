import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { updatePortalBusinessProfileBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { appendAuditEvent, assertCan, canonicalHash } from '../approvals/index.js';
import { portalActorFor, type PortalPersonRow } from './portal-people-authority.js';
import { type PortalSessionFacts, systemScopeFor } from './portal-session-context.js';

type ProfileUpdate = z.infer<typeof updatePortalBusinessProfileBody>;

/**
 * **The business fills in its own record** — `PUT /portal/business-profile`,
 * the setup journey's details step (5 Sep 2026 review finding: the emailed
 * link told the client they would fill in their account information, and the
 * journey asked them nothing between the code and the payment).
 *
 * The shape is `portal-people.service.ts`'s, deliberately, because the two
 * answer the same three questions the same way:
 *
 * - **Who is asking** — the `contacts` row `facts.contactId` names, found IN
 *   THIS BUSINESS (an id naming somebody on another business resolves to
 *   nothing and fails closed), turned into an `Actor` by `portalActorFor`.
 *   `assertCan(actor, 'business.profile.manage')` is the gate — the owner
 *   authority only, narrower than people management on purpose.
 * - **Tenancy** — the QUERY, not SQL: `businesses` has no RLS branch meaning
 *   "this client's own row", so the write runs under `systemScopeFor(facts)`
 *   and `where: { id: facts.businessId }` is the whole boundary. The id comes
 *   off the `otp_sessions` row the server wrote; the operation takes no
 *   `businessId` argument, so there is nothing for a caller to supply.
 * - **The record of it** — an audit row in the practice's own chain,
 *   `proposalId: null` (a portal caller structurally cannot have a proposal),
 *   so the accountant can see what their client stated even though no human
 *   gate stood in front of a business naming its own company number.
 *
 * **An omitted field is UNCHANGED; a null is an explicit clearing.** The Zod
 * boundary already made the distinction (optional vs nullable); this class
 * only has to not flatten it — which is what the key-presence spreads below
 * are. `vatRegistered: false` is likewise an explicit answer, never a default
 * this service invents.
 *
 * Everything here is untrusted content on its way into a workspace record:
 * stored as data, rendered as data, never handed to a model outside
 * `<untrusted_content>`.
 */
export class PortalBusinessProfileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async updateProfile(facts: PortalSessionFacts, request: ProfileUpdate, idempotencyKey?: string): Promise<void> {
    if (await this.#replayed(facts, idempotencyKey, request)) return;

    await scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      // The acting person, found in this business — the people service's rule.
      const acting = (await db.contact.findFirst({
        where: { id: facts.contactId ?? '', businessId: facts.businessId, deactivatedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true, role: true, portalRole: true, isPrimary: true, canSendDocuments: true, canSeeTotals: true, deactivatedAt: true, createdAt: true },
      })) as PortalPersonRow | null;
      assertCan(portalActorFor(acting), 'business.profile.manage');

      const data = {
        ...('tradingName' in request ? { tradingName: request.tradingName ?? null } : {}),
        ...('companyNumber' in request ? { companyNumber: request.companyNumber ?? null } : {}),
        ...('legalStructure' in request ? { legalStructure: request.legalStructure ?? null } : {}),
        ...('industry' in request ? { industry: request.industry ?? null } : {}),
        ...('website' in request ? { website: request.website ?? null } : {}),
        ...('vatRegistered' in request && request.vatRegistered !== undefined ? { vatRegistered: request.vatRegistered } : {}),
        ...('vatNumber' in request ? { vatNumber: request.vatNumber ?? null } : {}),
      };
      // A body of no answers writes nothing and audits nothing — the skippable
      // step skipped, not an empty UPDATE that still bumps updated_at.
      if (Object.keys(data).length === 0) return;

      await db.business.update({ where: { id: facts.businessId }, data });

      const outcome = { updatedFields: Object.keys(data), actingContactId: acting?.id ?? null };
      await appendAuditEvent(db, {
        businessId: facts.businessId,
        event: 'business.profile.updated',
        proposalId: null,
        payloadHash: canonicalHash(outcome),
        renderedSummaryHash: null,
        traceId: null,
        outcome,
      });
    });

    await this.#remember(facts, idempotencyKey, request);
  }

  /**
   * The replay half of `Idempotency-Key` — namespaced by SESSION, the people
   * service's argument: two sessions reusing one client-minted UUID must miss,
   * never observe each other. The same key with a DIFFERENT payload is the
   * store's documented client bug and answers `409 NT-IDM-001` — silently
   * re-running the write would make the key a no-op exactly when it matters.
   */
  async #replayed(facts: PortalSessionFacts, key: string | undefined, request: unknown): Promise<boolean> {
    if (key === undefined) return false;
    const record = await this.idempotency.get(this.#storeKey(facts, key));
    if (record === null) return false;
    if (record.requestHash !== fingerprint({ otpSessionId: facts.otpSessionId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
      );
    }
    return true;
  }

  async #remember(facts: PortalSessionFacts, key: string | undefined, request: unknown): Promise<void> {
    if (key === undefined) return;
    await this.idempotency.put(this.#storeKey(facts, key), {
      requestHash: fingerprint({ otpSessionId: facts.otpSessionId, request }),
      response: null,
    });
  }

  #storeKey(facts: PortalSessionFacts, key: string): string {
    return `portal-business-profile:${facts.otpSessionId}:${key}`;
  }
}
