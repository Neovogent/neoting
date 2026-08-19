import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';

import type { DocumentUpload, PortalContext, PortalSession } from '@neoting/contracts/model';
import {
  createPortalSessionBody,
  createPortalSessionHeader,
  createPortalUploadBody,
  createPortalUploadHeader,
} from '@neoting/contracts/zod';

import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { PortalContextService } from './portal-context.service.js';
import type { PortalSessionContextResolver } from './portal-session-context.js';
import type { PortalSessionService } from './portal-session.service.js';
import type { PortalUploadService } from './portal-upload.port.js';
import { PORTAL_CONTEXT_SERVICE, PORTAL_SESSION_CONTEXT, PORTAL_SESSION_SERVICE, PORTAL_UPLOAD_SERVICE } from './tokens.js';

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
