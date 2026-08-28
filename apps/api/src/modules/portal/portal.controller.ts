import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';

import type { DocumentUpload, PortalContext, PortalSession } from '@neoting/contracts/model';
import {
  createPortalOnboardingSessionBody,
  createPortalOnboardingSessionHeader,
  createPortalSessionBody,
  createPortalSessionHeader,
  createPortalSignInCodeBody,
  createPortalSignInCodeHeader,
  createPortalUploadBody,
  createPortalUploadHeader,
} from '@neoting/contracts/zod';

import { AppException } from '../../common/problem/problem.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { PortalContextService } from './portal-context.service.js';
import type { PortalOnboardingService } from './portal-onboarding.service.js';
import type { PortalSessionContextResolver } from './portal-session-context.js';
import type { PortalSessionService } from './portal-session.service.js';
import type { PortalUploadService } from './portal-upload.port.js';
import {
  PORTAL_CONTEXT_SERVICE,
  PORTAL_ONBOARDING_SERVICE,
  PORTAL_SESSION_CONTEXT,
  PORTAL_SESSION_SERVICE,
  PORTAL_UPLOAD_SERVICE,
} from './tokens.js';

/**
 * The three contracted portal operations (METH Stage 9, SoT §4 Stage 8.3): open
 * a session from an SMS link plus six digits, see what is being chased, start an
 * upload against it. Nothing else lives here — the portal is the smallest
 * surface in the product and stays that way.
 *
 * **The credential is a BEARER, not a cookie.** `METH_MODE.md` Stage 9 says
 * "issue portal cookie"; `openapi.yaml` declares `portalSession: {type: http,
 * scheme: bearer}` and puts both authenticated operations under it. The contract
 * wins (G7) — see this module's `CLAUDE.md` for the recorded divergence.
 *
 * **These endpoints do NOT use `common/context`'s `RequestContext`.** That
 * resolver reads the `nt_session` cookie into a practice-staff scope; a portal
 * caller has no cookie, no membership and no workspace. They read their own
 * `Authorization` header through `PortalSessionContextResolver`, which produces
 * session FACTS rather than a scope — the two contexts derived from those facts
 * differ per operation, and the resolver hands out both.
 *
 * **Both writes are legitimately outside Review → Approve.** The contract marks
 * them `x-nt-side-effect: ingest` — the same standing as web upload: submitting
 * evidence creates a new record and changes no existing one. No chase moves
 * state from here; that is the auto-close path (Stage 8) when a matching
 * document actually arrives.
 *
 * Thin by design (apps/api/CLAUDE.md, 200-line cap): resolve the session, parse
 * with the generated schemas, call ONE service method, map dates to ISO.
 */
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(PORTAL_SESSION_SERVICE) private readonly sessions: PortalSessionService,
    @Inject(PORTAL_SESSION_CONTEXT) private readonly resolver: PortalSessionContextResolver,
    @Inject(PORTAL_CONTEXT_SERVICE) private readonly context: PortalContextService,
    @Inject(PORTAL_UPLOAD_SERVICE) private readonly uploads: PortalUploadService,
    @Inject(PORTAL_ONBOARDING_SERVICE) private readonly onboarding: PortalOnboardingService,
  ) {}

  /**
   * `POST /portal/sessions` — public (`security: []`). Link token + OTP → a
   * bearer. Every verification failure is one `401 NT-OTP-001`, raised by the
   * service; distinguishing them would tell a guesser which links exist.
   *
   * ⚠ **The `Idempotency-Key` is required and parsed, and deliberately NOT
   * replay-cached.** The contract requires the header on every mutation, so a
   * missing or non-UUID one is a 400 here. But this operation is *public and
   * unauthenticated*, and the response carries a credential: a replay cache
   * keyed on a caller-supplied header would hand a live portal bearer to anyone
   * who presented the same key. The operation is already idempotent where it
   * matters — `otp_sessions.link_token_hash` is `@unique`, so N verifications of
   * one link upsert ONE row and keep its grant. A fresh bearer per call is
   * correct, not a duplicate side effect: each is one hour of its own.
   */
  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  async createSession(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PortalSession> {
    parseIdempotencyKey(createPortalSessionHeader, idempotencyKey);
    const request = parseBoundary(createPortalSessionBody, body, 'request body');
    const issued = await this.sessions.createSession(request);
    return { token: issued.token, expiresAt: issued.expiresAt.toISOString() };
  }

  /**
   * `POST /portal/sign-in-codes` — public. Setup link + address → a six-digit
   * code, by email.
   *
   * ⚠ **`202`, always, whatever happened.** An unknown token, an expired or
   * already-accepted invite and a wrong address are one outcome here. Whether an
   * address is registered on a workspace is not something an unauthenticated
   * caller may learn, and the setup link travels by email through people who are
   * not always the client. The mail is what distinguishes the outcomes, and it
   * goes to the address rather than to the caller.
   *
   * The `Idempotency-Key` is required and parsed but not replay-cached, for the
   * reason given on `createSession`: this is public, and a cache keyed on a
   * caller-supplied header would let anyone replay someone else's request. It is
   * naturally idempotent anyway — asking twice sends a second code and voids
   * the first.
   */
  @Post('sign-in-codes')
  @HttpCode(HttpStatus.ACCEPTED)
  async createSignInCode(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<void> {
    parseIdempotencyKey(createPortalSignInCodeHeader, idempotencyKey);
    const request = parseBoundary(createPortalSignInCodeBody, body, 'request body');
    await this.onboarding.requestSignInCode(request);
  }

  /**
   * `POST /portal/onboarding-sessions` — public. Setup link + address + code
   * → a portal bearer, opened under `ONBOARDING` rather than
   * `DELEGATED_UPLOAD`.
   *
   * Every refusal is the same `401 NT-OTP-001` the chase path raises. The
   * service answers `null` for all of them — wrong code, locked, expired,
   * unknown token, wrong address — because telling them apart would say which
   * links exist and which addresses are on them.
   */
  @Post('onboarding-sessions')
  @HttpCode(HttpStatus.CREATED)
  async createOnboardingSession(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PortalSession> {
    parseIdempotencyKey(createPortalOnboardingSessionHeader, idempotencyKey);
    const request = parseBoundary(createPortalOnboardingSessionBody, body, 'request body');
    const issued = await this.onboarding.createOnboardingSession(request);
    if (issued === null) {
      // One answer for every refusal - wrong code, locked out, expired,
      // unknown token, wrong address. See the header.
      throw new AppException(
        'NT-OTP-001',
        HttpStatus.UNAUTHORIZED,
        'Verification failed',
        'The link, the email address or the code did not verify. Ask your accountant to send a fresh link if this one has expired.',
      );
    }
    // ⚠ `businessId` is an ANSWER, not an instruction (contract-change #205).
    // An invited client has to name their business to subscribe and nothing
    // else can tell them — `getPortalContext` needs a chase, and they have
    // none. The checkout handler still re-derives it from the session and 404s
    // a body naming a different one, so this is a convenience for the caller
    // and never the thing that decides.
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      businessId: issued.businessId,
    };
  }

  /** `GET /portal/context` — the chased items this session exists to collect, and nothing else. */
  @Get('context')
  @HttpCode(HttpStatus.OK)
  async getContext(@Headers('authorization') authorization: string | undefined): Promise<PortalContext> {
    return this.context.getContext(await this.resolver.resolve(authorization));
  }

  /**
   * `POST /portal/uploads` — step one of two: a presigned `PUT` under the
   * delegated scope. Completion is `POST /document-uploads/{uploadId}/complete`,
   * which accepts this same bearer (`openapi.yaml`).
   *
   * The session is resolved BEFORE the body is parsed: a caller with no valid
   * bearer gets `401 NT-OTP-002` and learns nothing about which of their fields
   * we would have objected to.
   */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  async createUpload(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<DocumentUpload> {
    const facts = await this.resolver.resolve(authorization);
    const key = parseIdempotencyKey(createPortalUploadHeader, idempotencyKey);
    const request = parseBoundary(createPortalUploadBody, body, 'request body');
    return this.uploads.createPortalUpload(facts, request, key);
  }
}
