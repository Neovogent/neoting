import { HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import type { Business } from '@neoting/contracts/model';
import type { createBusinessBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import type { NotificationsService } from '../notifications/index.js';
import { type BusinessTypeProfile, readBusinessProfile, toStoredProfile } from './business-profile.js';
import { toBusiness } from './projections.js';
import { buildSetupLink, hashSetupToken, mintSetupToken, setupLinkExpiry } from './setup-link.js';

/** The parsed body — the schema that actually validated it, not the DTO interface (see web-upload/CLAUDE.md). */
type CreateClientRequest = z.infer<typeof createBusinessBody>;

/**
 * The integration a new client is born with (D42, D47, and A5's refusal).
 *
 * **Exactly one row, and it is `VT`.** `publish-batch.ts` refuses to publish a
 * client with no active integration, and D47 says intake asks for no
 * connections — so the row has to be created here or a document can never reach
 * Published. `IntegrationKind` admits both `VT` and `MANUAL`; creating both
 * would give the client two export destinations and A5 refuses that outright, so
 * this is a constant rather than an option. Nothing on `POST /businesses` can
 * choose it, which is the point: an intake form with an export-destination
 * picker is the connection step D47 deleted, wearing a different hat.
 *
 * `VT` rather than `MANUAL` because ID's export target is VT Transaction+
 * (§24.3, A7's emitter) and `MANUAL` would describe a client whose books are
 * kept somewhere this release cannot emit for.
 *
 * ⚠ It carries **no `orgRef`, no `tokenRef`, no `health`**. Those are the
 * columns an OAuth ledger connection fills in, and there is no connection: a
 * populated `token_ref` here would be a claim that something was authorised.
 */
const CLIENT_INTEGRATION_KIND = 'VT';

/**
 * The role the client's own first person gets. `BUSINESS_ADMIN` — it is their
 * workspace, and the invite is what makes them a permitted sender (D45).
 */
const PRIMARY_CONTACT_ROLE = 'BUSINESS_ADMIN';

/**
 * **Client intake** (`POST /v1/businesses`, SoT §24.5, D47).
 *
 * ## What this does NOT do, and must never grow
 *
 * It asks for **no bank connection and no accounting-software connection**.
 * Both steps are skipped entirely (D47) — not deferred to a later screen, not
 * hidden behind a flag. `BusinessCreateRequest` has no field for either, and if
 * one appears in a later revision the wrong product is being built.
 *
 * ## What it captures instead
 *
 * The **business-type profile** (`business-profile.ts`). D47 removed the
 * ledger-synced chart of accounts, so this is the only coding context the engine
 * gets (§24.4) and the only basis on which a document is judged acceptable
 * evidence for this business (D46). The contract makes it required; this refuses
 * a client without one rather than letting the gap surface six weeks later as
 * bad categorisation.
 *
 * ## Four rows, one transaction
 *
 * | Row | Why it exists |
 * |---|---|
 * | `businesses` | the workspace, carrying the profile in `context_questionnaire` |
 * | `contacts` (primary) | the client's identity. **D45**: `ingestion-routing`'s sender map keys on `contacts.email`, so this row is what makes an inbound email from that address routable to this client instead of Unrouted |
 * | `integrations` (VT, active) | so a document can reach Published without anyone connecting anything (A5) |
 * | `invites` | the setup link the registration email carries (§24.5 step 2) |
 *
 * All four are written inside **one** `scopedDb` transaction, so a client
 * cannot exist without the integration that lets its documents be exported, nor
 * without the contact that lets its email reach us.
 *
 * ## Tenancy
 *
 * `businesses_tenant`'s `WITH CHECK` is what admits the row: the caller must
 * hold a membership on the practice the business is being created under. The
 * practice comes from the caller's own `ScopeContext`, never from the request —
 * there is no `practiceId` field on `BusinessCreateRequest` and there must not
 * be one, or adding a client would be a way to write into another firm.
 *
 * ## This is `ingest`, not a proposal
 *
 * `x-nt-side-effect: ingest` in the contract. Adding a client creates new
 * records and changes the state of nothing that exists, so it needs no Approve
 * and opens no side-effect door outside Review → Approve (Governance §10.6). The
 * architectural route-table test reads that field, so the claim is mechanical.
 */
export class ClientIntakeService {
  private readonly logger = new Logger(ClientIntakeService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationsService,
    private readonly idempotency: IdempotencyStore,
    private readonly config: { readonly appOrigin: string },
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createClient(ctx: ScopeContext, request: CreateClientRequest, idempotencyKey?: string): Promise<Business> {
    const replay = await this.replayed<Business>(idempotencyKey, request);
    if (replay !== null) return replay;

    // A client belongs to a practice. A business-scoped actor has no practice in
    // context and cannot add one — 403 rather than 404 because no record is
    // being confirmed or denied here: the refusal is about the caller, not about
    // a row they may not see (`packages/contracts/CLAUDE.md`, "404, never 403",
    // which is a rule about resources).
    const practiceId = ctx.practiceId;
    if (practiceId === undefined) {
      throw new AppException(
        'NT-PRM-001',
        HttpStatus.FORBIDDEN,
        'Not permitted',
        'Only a member of an accounting practice can add a client.',
      );
    }

    // Minted BEFORE the transaction so the token never depends on transaction
    // retry semantics: the row stores only its hash, and the plaintext lives in
    // this function and in the email, exactly as the contract requires.
    const setupToken = mintSetupToken();
    const expiresAt = setupLinkExpiry(this.now());

    const { business, practiceName } = await scopedDb(this.prisma, ctx, async (db) => {
      // `practices` carries no RLS (see prisma/CLAUDE.md), so this is a plain
      // lookup by the id the caller's own verified context supplied — not a
      // widening. A missing row means the context names a practice that does not
      // exist, which the business insert's foreign key would refuse a moment
      // later with an opaque error; refusing here says what actually happened.
      const practice = await db.practice.findUnique({ where: { id: practiceId }, select: { name: true } });
      if (practice === null) {
        throw new AppException('NT-SRV-001', HttpStatus.INTERNAL_SERVER_ERROR, 'Practice not found for this session');
      }

      const business = await db.business.create({
        data: {
          practiceId,
          name: request.name,
          // `?? null` rather than a conditional spread: the columns are
          // nullable, `exactOptionalPropertyTypes` is on, and an explicit
          // `undefined` is not assignable to Prisma's optional input.
          tradingName: request.tradingName ?? null,
          companyNumber: request.companyNumber ?? null,
          industry: request.industry ?? null,
          vatRegistered: request.vatRegistered ?? false,
          vatNumber: request.vatNumber ?? null,
          // The profile. The whole reason this endpoint exists (§24.4).
          contextQuestionnaire: toStoredProfile(request.contextQuestionnaire),
        },
      });

      await db.contact.create({
        data: {
          businessId: business.id,
          firstName: request.primaryContact.firstName,
          lastName: request.primaryContact.lastName,
          // Lower-cased because this address is an IDENTITY, not a display
          // string: `ingestion-routing`'s sender map lower-cases what arrives
          // before it looks it up (D45), so a contact stored as `Sam@…` would
          // never match mail from `sam@…` and every document that client sent
          // would land Unrouted.
          email: request.primaryContact.email.toLowerCase(),
          mobileE164: request.primaryContact.mobileE164 ?? null,
          isPrimary: true,
          receivesChases: true,
        },
      });

      // Exactly one, always VT. See CLIENT_INTEGRATION_KIND.
      await db.integration.create({
        data: { businessId: business.id, kind: CLIENT_INTEGRATION_KIND, isActive: true },
      });

      await db.invite.create({
        data: {
          businessId: business.id,
          email: request.primaryContact.email.toLowerCase(),
          role: PRIMARY_CONTACT_ROLE,
          tokenHash: hashSetupToken(setupToken),
          expiresAt,
        },
      });

      return { business, practiceName: practice.name };
    });

    // OUTSIDE the transaction, on purpose: an external call inside an open
    // transaction holds a database connection for the duration of somebody
    // else's network, and a rollback cannot un-send an email anyway.
    await this.sendSetupEmail({
      to: request.primaryContact.email,
      practiceName,
      businessName: business.name,
      setupToken,
      expiresAt,
      businessId: business.id,
    });

    const response = toBusiness(business);
    await this.remember(idempotencyKey, request, response);
    return response;
  }

  /**
   * The business-type profile for one client, or `null` when none was captured
   * (or the stored value is not one this release understands —
   * `readBusinessProfile` documents why those collapse).
   *
   * **This is A6's read.** It is a provider rather than an endpoint: the S0
   * contract publishes no `GET /businesses/{id}`, and inventing public API is a
   * contract change, not a stage's decision.
   *
   * **404, never 403** — a business outside the caller's scope is invisible to
   * `businesses_tenant`, so `findUnique` returns null and this raises 404. There
   * is no ownership check that *could* raise 403, because a 403 confirms the
   * record exists.
   */
  async getClientProfile(ctx: ScopeContext, businessId: string): Promise<BusinessTypeProfile | null> {
    const row = await scopedDb(this.prisma, ctx, (db) =>
      db.business.findUnique({ where: { id: businessId }, select: { contextQuestionnaire: true } }),
    );
    if (row === null) {
      // NT-NOT-001 does not exist in the contract's ErrorCode enum; NT-VAL-001
      // is the house fallback for an otherwise-uncoded 4xx (see
      // modules/documents/CLAUDE.md). The detail never echoes the id back.
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id.');
    }
    return readBusinessProfile(row.contextQuestionnaire);
  }

  /**
   * The registration email (S2 message 1, §24.5 step 2).
   *
   * **Best effort, and the 201 stands either way.** The workspace, the contact,
   * the integration and the invite are already committed by the time this runs;
   * turning a refused email into a failed request would tell the accountant
   * their client was not created when it was, and their retry would create a
   * second one. A refusal is logged and the invite row remains — re-sending is
   * `POST /businesses/{businessId}/members`, which answers 429 honestly because
   * there the invite IS the response.
   *
   * The address is never logged; `NotificationsService` logs the domain only.
   */
  private async sendSetupEmail(input: {
    readonly to: string;
    readonly practiceName: string;
    readonly businessName: string;
    readonly setupToken: string;
    readonly expiresAt: Date;
    readonly businessId: string;
  }): Promise<void> {
    const outcome = await this.notifications.sendClientInvite({
      to: input.to,
      practiceName: input.practiceName,
      businessName: input.businessName,
      inviteLink: buildSetupLink(this.config.appOrigin, input.setupToken),
      expiresAt: input.expiresAt,
    });
    if (!outcome.sent) {
      this.logger.warn(
        `client created but the setup email was not sent · businessId=${input.businessId} reason=${outcome.reason} retryAfter=${outcome.retryAfterSeconds}s`,
      );
    }
  }

  /**
   * The replay namespace. `Idempotency-Key` is a client-generated UUID over a
   * store this module shares with `TeamService`, so each surface prefixes its
   * own — a key reused across two operations must miss, never be handed the
   * other one's response.
   */
  private storeKey(idempotencyKey: string): string {
    return `businesses:${idempotencyKey}`;
  }

  private async replayed<T>(idempotencyKey: string | undefined, request: unknown): Promise<T | null> {
    if (idempotencyKey === undefined) return null;
    const record = await this.idempotency.get(this.storeKey(idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(idempotencyKey: string | undefined, request: unknown, response: unknown): Promise<void> {
    if (idempotencyKey === undefined) return;
    await this.idempotency.put(this.storeKey(idempotencyKey), { requestHash: fingerprint(request), response });
  }
}
