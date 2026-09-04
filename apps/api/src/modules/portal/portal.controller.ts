import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';

import type { DocumentUpload, PortalContext, PortalDocument, PortalSession, PortalSetupPreview } from '@neoting/contracts/model';
import {
  createPortalOnboardingSessionBody,
  createPortalOnboardingSessionHeader,
  createPortalSessionBody,
  createPortalSessionHeader,
  createPortalSignInCodeBody,
  createPortalSignInCodeHeader,
  createPortalUploadBody,
  createPortalUploadHeader,
  listPortalDocumentsQueryParams,
  previewPortalSetupBody,
} from '@neoting/contracts/zod';

import type { Page } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { PortalContextService } from './portal-context.service.js';
import type { PortalDocumentsService } from './portal-documents.service.js';
import type { PortalOnboardingService } from './portal-onboarding.service.js';
import type { PortalSessionContextResolver } from './portal-session-context.js';
import type { PortalSessionService } from './portal-session.service.js';
import type { PortalUploadService } from './portal-upload.port.js';
import {
  PORTAL_CONTEXT_SERVICE,
  PORTAL_DOCUMENTS_SERVICE,
  PORTAL_ONBOARDING_SERVICE,
  PORTAL_SESSION_CONTEXT,
  PORTAL_SESSION_SERVICE,
  PORTAL_UPLOAD_SERVICE,
} from './tokens.js';

/**
 * The **seven** contracted portal operations (METH Stage 9, SoT §4 Stage 8.3,
 * D49): open a session from a link plus six digits, ask for the code that opens
 * one, open one from a setup link, preview what a setup link names, see what is
 * being chased, see what you have sent, start an upload. Nothing else lives
 * here — the portal is the smallest surface in the product and the only one a
 * stranger holding a forwarded link can reach, so an eighth handler is a
 * contract decision rather than a convenience, and `portal.controller.test.ts`
 * pins the list.
 *
 * It read "three" until 28 Aug 2026 (the two invited-client routes, published by
 * S0 and implemented by nobody), "six" until 2 Sep 2026
 * (`GET /portal/documents` — the client's own document list, which D49's home
 * and upload tabs are built on and for which the only server-side fact was the
 * integer `PortalSummary.documentsSent`), and grew the setup preview on
 * 5 Sep 2026 (the review finding on the sign-in screen's empty email field).
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
    @Inject(PORTAL_DOCUMENTS_SERVICE) private readonly documents: PortalDocumentsService,
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
    // Three routes, one uniform 202. A chase link names its chase and the code
    // goes to the REGISTERED recipient (never a typed address — the link is
    // forwardable); an email names a workspace; a body naming neither
    // identifies nothing and is silently accepted like every other refusal.
    if (typeof request.linkToken === 'string' && request.linkToken !== '') {
      await this.onboarding.requestChaseCode(request.linkToken);
    } else if (typeof request.email === 'string' && request.email !== '') {
      await this.onboarding.requestSignInCode({ setupToken: request.setupToken, email: request.email });
    }
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
      // The subscription state at open (5 Sep 2026) — the journey skips the
      // subscribe step for an already-entitled business instead of walking
      // them back to the £8.50 screen. Omitted when never subscribed.
      ...(issued.subscriptionStatus === undefined ? {} : { subscriptionStatus: issued.subscriptionStatus }),
    };
  }

  /**
   * `POST /portal/setup-previews` — public. Setup token → the registered
   * address and the business name, so the sign-in screen can PREFILL the email
   * instead of asking the client to retype the one fact a mistype silently
   * kills (the uniform 202 sends nothing and says nothing — 5 Sep 2026 review
   * finding, and it happened to a real client the day before).
   *
   * Safe to answer where `sign-in-codes` must stay silent: the caller holds a
   * token WE emailed to the address the answer names — the invitation-preview
   * argument, one trust level down. Every refusal is the uniform `NT-OTP-001`.
   * No Idempotency-Key: `x-nt-side-effect: none`, nothing is written.
   */
  @Post('setup-previews')
  @HttpCode(HttpStatus.OK)
  async previewSetup(@Body() body: unknown): Promise<PortalSetupPreview> {
    const request = parseBoundary(previewPortalSetupBody, body, 'request body');
    const preview = await this.onboarding.previewSetup(request.setupToken);
    if (preview === null) {
      throw new AppException(
        'NT-OTP-001',
        HttpStatus.UNAUTHORIZED,
        'Verification failed',
        'That setup link did not verify. Ask your accountant to send a fresh one if it has expired.',
      );
    }
    return preview;
  }

  /** `GET /portal/context` — the chased items this session exists to collect, and nothing else. */
  @Get('context')
  @HttpCode(HttpStatus.OK)
  async getContext(@Headers('authorization') authorization: string | undefined): Promise<PortalContext> {
    // Both kinds of session read their own context — see `resolveForContext`.
    return this.context.getContext(await this.resolver.resolveForContext(authorization));
  }

  /**
   * `GET /portal/documents` — what this client has sent, in their own words
   * (D49's home and upload tabs).
   *
   * ⚠ **`resolveOnboarding`, so a CHASE session is refused — and that is the
   * whole security decision on this route.** A chase link is deliberately
   * forwardable to whoever physically holds the paperwork (SoT Stage 8.3), and
   * its holder's authority is the chased items plus the right to upload against
   * them. Handing them the client's entire document history — every supplier,
   * every amount, every date — because they were passed a text is a widening
   * nothing asked for. It is the same line `getPortalContext` already draws by
   * returning `summary: null` and `businessId: null` to a chase session: the
   * workspace is not a chase session's to read.
   *
   * The refusal is the uniform `401 NT-OTP-002`, identical to the one a missing
   * or expired bearer gets, so it says only "not a session for this".
   *
   * Authenticate, then validate — a caller with no valid bearer learns nothing
   * about which of their query parameters we would have objected to.
   */
  @Get('documents')
  @HttpCode(HttpStatus.OK)
  async getDocuments(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<Page<PortalDocument>> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    // `coerceQuery` first: Express delivers every query value as a string while
    // the generated schema types `limit` as a number, so `?limit=25` — the
    // exact shape the portal sends — is otherwise a 400. Schema-driven, so it
    // cannot drift from the contract.
    const parsed = parseBoundary(
      listPortalDocumentsQueryParams,
      coerceQuery(listPortalDocumentsQueryParams, query),
      'query parameters',
    );
    return this.documents.listDocuments(facts, parsed);
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
    // A chase session answering a request, or a client sending paperwork from
    // their own portal — see `resolveForUpload`.
    const facts = await this.resolver.resolveForUpload(authorization);
    const key = parseIdempotencyKey(createPortalUploadHeader, idempotencyKey);
    const request = parseBoundary(createPortalUploadBody, body, 'request body');
    return this.uploads.createPortalUpload(facts, request, key);
  }
}
