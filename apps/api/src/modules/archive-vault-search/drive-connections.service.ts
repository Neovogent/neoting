import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { IntegrationKind } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import {
  authorizeUrl,
  exchangeCode,
  OAuthError,
  signState,
  type VendorCredentials,
  verifyState,
} from '../../common/oauth/oauth.js';
import { seal } from '../../common/oauth/token-vault.js';
import { AppException } from '../../common/problem/problem.js';
import { type PortalSessionFacts, systemScopeFor } from '../portal/index.js';
import { DriveAdapter } from './drive-adapter.js';
import { driveBySlug, driveFor, type DriveSlug, type DriveVendor } from './drive-vendors.js';

/**
 * Connecting a client's own Google Drive or OneDrive, from their portal (D51).
 *
 * ## ⚠ THE CALLBACK CANNOT CARRY A PORTAL SESSION, AND THAT CHANGES THE SHAPE
 *
 * The ledger's connect flow ends at an API route, and its safety rests on two
 * independent halves: the signed `state` proves the callback belongs to a
 * request this server started, and the PRACTICE SESSION COOKIE proves who is
 * holding it (`publishing/ledger/CLAUDE.md` — "The callback must live on the
 * host that holds the SESSION"). `common/oauth/oauth.ts` says it outright:
 * *the state is not a credential and is not treated as one.*
 *
 * A portal session is a **bearer token in a header**, not a cookie. A vendor's
 * 302 cannot send a header. So if the vendor redirected straight to an API
 * route here, the state would be the ONLY thing authorising the write — and
 * whoever held that URL could bind THEIR drive to this client's business, after
 * which the client's next copy would put every document into a stranger's
 * storage. That is a real exfiltration path, not a theoretical one.
 *
 * **So the redirect lands on the WEB APP, not on the API.** The browser arrives
 * at `/portal/vault/connected` carrying `code` and `state` in the query; the
 * portal, which holds the bearer, then POSTs both to `complete()` as an
 * ordinary authenticated request. Both halves are back: the signature proves
 * the flow is ours, the bearer proves who is finishing it, and `complete()`
 * refuses when they disagree about the business.
 */

export interface DriveConnectionConfig {
  /** Our app registration per drive. Null where this deployment carries none. */
  readonly credentials: (slug: DriveSlug) => VendorCredentials | null;
  /** The AES-256-GCM key the tokens are sealed with — `INTEGRATION_TOKEN_KEY`. */
  readonly vaultKey: Buffer;
}

@Injectable()
export class DriveConnectionsService {
  private readonly logger = new Logger(DriveConnectionsService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: DriveConnectionConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /** Where to send the client's browser to ask for consent. */
  start(facts: PortalSessionFacts, slug: string): { authorizeUrl: string } {
    const { vendor, credentials, businessId } = this.resolve(facts, slug);
    const state = signState(
      {
        b: businessId,
        v: vendor.slug,
        // The portal session's own id. `complete()` does not compare it — the
        // bearer is what authorises — but it ties a state to the sign-in that
        // minted it in the audit trail, and a state minted for one client
        // cannot be spent by another because `b` is checked.
        a: facts.otpSessionId,
      },
      this.config.vaultKey,
    );
    return { authorizeUrl: authorizeUrl(vendor, credentials, state) };
  }

  /**
   * Finish the connection: verify, exchange, seal, store.
   *
   * ⚠ **`state.b` must equal the bearer's own business.** This is the check
   * that makes the two halves independent — without it a state minted for one
   * client, completed by another client's session, would write a connection to
   * the wrong workspace.
   */
  async complete(facts: PortalSessionFacts, code: string, rawState: string): Promise<{ label: string | null }> {
    const businessId = this.businessOf(facts);

    let state;
    try {
      state = verifyState(rawState, this.config.vaultKey);
    } catch (error) {
      throw new AppException(
        'NT-INT-001',
        HttpStatus.CONFLICT,
        'Connection could not be completed',
        error instanceof OAuthError ? error.message : 'That connection link is not one this server issued.',
      );
    }

    if (state.b !== businessId) {
      // 409 with a flat sentence: naming the other business would confirm it
      // exists, which is the same reasoning the portal's 404s carry.
      throw new AppException(
        'NT-INT-001',
        HttpStatus.CONFLICT,
        'Connection could not be completed',
        'That connection was started from a different sign-in. Start it again from the Vault tab.',
      );
    }

    const { vendor, credentials } = this.resolve(facts, state.v);

    let tokens;
    try {
      // ⚠ THE VENDOR CALL, OUTSIDE EVERY TRANSACTION.
      tokens = await exchangeCode(vendor, credentials, code, this.fetchImpl);
    } catch (error) {
      throw new AppException(
        'NT-INT-001',
        HttpStatus.CONFLICT,
        'Connection could not be completed',
        error instanceof OAuthError ? error.message : `${vendor.label} refused the sign-in.`,
      );
    }

    // Whose account it is — cosmetic, and deliberately never fatal. A null
    // label is a working connection with an unnamed account; refusing the whole
    // connect over it would be the ledger's GUID bug wearing a different hat.
    const { label } = await new DriveAdapter(vendor, tokens.accessToken, this.fetchImpl).account();

    await scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.integration.upsert({
        // ⚠ Upsert, not create: `@@unique([businessId, kind])` means reconnecting
        // is an UPDATE, and a create would 500 on every second connect — the
        // exact bug the ledger shipped and fixed ("disconnecting a vendor made
        // it impossible to reconnect").
        where: { businessId_kind: { businessId, kind: vendor.kind } },
        create: {
          businessId,
          kind: vendor.kind,
          tokenRef: seal(tokens, this.config.vaultKey),
          tokenExpiresAt: new Date(tokens.accessExpiresAt),
          orgName: label,
          health: 'OK',
          isActive: true,
        },
        update: {
          tokenRef: seal(tokens, this.config.vaultKey),
          tokenExpiresAt: new Date(tokens.accessExpiresAt),
          orgName: label,
          health: 'OK',
          isActive: true,
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      }),
    );

    this.logger.log(`vault: ${vendor.label} connected for business ${businessId}`);
    return { label };
  }

  /**
   * Disconnect.
   *
   * ⚠ **`isActive: false` AND the token cleared.** Leaving the ciphertext
   * behind would mean a disconnected drive still holds a live refresh token
   * that our own scheduler would keep alive — a client who pressed Disconnect
   * has withdrawn consent, and the credential has to go with it.
   */
  async disconnect(facts: PortalSessionFacts, kind: string): Promise<void> {
    const businessId = this.businessOf(facts);
    // Accepts either spelling — the URL slug the Vault tab links with
    // (`google-drive`) or the enum the contract names (`GOOGLE_DRIVE`) — because
    // both reach this route from different screens and refusing one of them is
    // a 409 nobody can diagnose from the outside.
    const vendor = driveBySlug(kind) ?? driveFor(kind as IntegrationKind);
    if (vendor === null) {
      throw new AppException('NT-INT-001', HttpStatus.CONFLICT, 'Not a cloud drive', 'That is not a drive connection.');
    }
    await scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.integration.updateMany({
        where: { businessId, kind: vendor.kind },
        data: { isActive: false, tokenRef: null, tokenExpiresAt: null, health: 'DISCONNECTED' },
      }),
    );
  }

  private resolve(
    facts: PortalSessionFacts,
    slug: string,
  ): { vendor: DriveVendor; credentials: VendorCredentials; businessId: string } {
    const businessId = this.businessOf(facts);
    const vendor = driveBySlug(slug);
    if (vendor === null) {
      throw new AppException('NT-INT-001', HttpStatus.CONFLICT, 'Not a cloud drive', 'That is not a drive we connect.');
    }
    const credentials = this.config.credentials(vendor.slug);
    if (credentials === null) {
      throw new AppException(
        'NT-INT-001',
        HttpStatus.CONFLICT,
        'Drive not available',
        `${vendor.label} is not configured on this deployment.`,
      );
    }
    return { vendor, credentials, businessId };
  }

  /**
   * The session's own business.
   *
   * `PortalSessionFacts.businessId` is non-nullable — the resolver takes it
   * from the `otp_sessions` ROW rather than the token — so this is a named
   * read, not a guard. It exists so no method in this file ever takes a
   * business from anywhere else.
   */
  private businessOf(facts: PortalSessionFacts): string {
    return facts.businessId;
  }
}

