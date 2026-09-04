import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Query } from '@nestjs/common';

import {
  getDocumentCountsQueryParams,
  getDocumentOriginalParams,
  getDocumentParams,
  listDocumentEventsParams,
  listDocumentEventsQueryParams,
  listDocumentExtractionsParams,
  listDocumentExtractionsQueryParams,
  listDocumentsQueryParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { AppException } from '../../common/problem/problem.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import { delegatedScopeFor, PORTAL_SESSION_CONTEXT, PortalSessionContextResolver } from '../portal/index.js';
import type { DocumentsService } from './documents.service.js';
import { DOCUMENTS_SERVICE } from './tokens.js';

/**
 * The documents read surface (issue #77, SoT §4 Stage 5).
 *
 * Five GETs. **No `Idempotency-Key` on any of them, and that is the contract's
 * rule rather than an omission**: `check-contract.mjs` requires the header only
 * where the method is not GET and the side effect is not `none`, and all five
 * operations are `x-nt-side-effect: none`. A read that demanded an idempotency
 * key would be cargo-culting the write surface.
 *
 * Thin by design (apps/api/CLAUDE.md, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service method, return it.
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(DOCUMENTS_SERVICE) private readonly service: DocumentsService,
    // The portal's second principal on `getDocumentOriginal` — see that
    // handler. Reached through `modules/portal`'s public seam, the only way one
    // module may depend on another (`apps/api/CLAUDE.md`, lint-enforced).
    @Inject(PORTAL_SESSION_CONTEXT) private readonly portalAuth: PortalSessionContextResolver,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    // `coerceQuery` first: Express delivers every query value as a string and a
    // once-given repeatable filter as a bare value, while the generated schema
    // types `limit` as a number and the filters as arrays. Without it,
    // `?limit=25` and `?state=READY` — the exact shapes apps/web sends — are
    // both 400s. Schema-driven, so it cannot drift from the contract.
    const parsed = parseBoundary(listDocumentsQueryParams, coerceQuery(listDocumentsQueryParams, query), 'query parameters');
    // `require()` resolves the context here, inside Nest's pipeline, so a bad
    // one leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.listDocuments(await this.context.require(), parsed);
  }

  /**
   * `GET /documents/counts` — the Documents screen's header, honestly.
   *
   * ⚠ **It MUST stay declared above `@Get(':documentId')`.** Nest matches
   * handlers in declaration order within a controller, so with the parameter
   * route first, `GET /documents/counts` would resolve as "the document whose
   * id is `counts`" and answer 404 forever. That ordering is also why this
   * handler is on THIS controller rather than on `DocumentManagementController`
   * with the other two management operations: ordering across controllers
   * depends on the `controllers` array in the module, which is a much easier
   * thing to reorder by accident.
   */
  @Get('counts')
  @HttpCode(HttpStatus.OK)
  async counts(@Query() query: unknown) {
    const parsed = parseBoundary(
      getDocumentCountsQueryParams,
      coerceQuery(getDocumentCountsQueryParams, query),
      'query parameters',
    );
    return this.service.getDocumentCounts(await this.context.require(), parsed);
  }

  @Get(':documentId')
  @HttpCode(HttpStatus.OK)
  async get(@Param('documentId') documentId: string) {
    const params = parseBoundary(getDocumentParams, { documentId }, 'documentId');
    return this.service.getDocument(await this.context.require(), params.documentId);
  }

  /**
   * `GET /documents/{documentId}/original` — a short-lived link to the bytes.
   *
   * ⚠ **The one operation on this controller with TWO principals.** The
   * contract puts `portalSession` beside `workspaceSession` on it (2 Sep 2026),
   * which is not a widening but this operation's own description finally being
   * declared: it has asserted *"a delegated OTP session may only call this for
   * items in its grant"* since the spec was drafted, and
   * `documents_delegated_upload` in `prisma/sql/rls.sql` has permitted exactly
   * that for just as long — while the missing `security:` block meant the
   * operation inherited the global `workspaceSession` default, so a client
   * could never open the receipt they had just sent.
   *
   * Everything below `principalFor` is unchanged: the SAME service method, the
   * same `findUnique`, the same 404. Only the context differs.
   */
  @Get(':documentId/original')
  @HttpCode(HttpStatus.OK)
  async original(
    @Param('documentId') documentId: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    const params = parseBoundary(getDocumentOriginalParams, { documentId }, 'documentId');
    return this.service.getDocumentOriginal(await this.principalFor(authorization), params.documentId);
  }

  /**
   * Which of the two principals is asking for an original, and what bounds it.
   *
   * **A bearer means the portal**, judged as a portal session on its own merits
   * — the resolver re-reads the `otp_sessions` row and re-checks its scope, its
   * verification and its expiry, so holding a cookie as well changes nothing.
   * No `Authorization` header at all is the accountant, unchanged.
   *
   * ⚠ **On the portal path the boundary is SQL, and it is the only one.**
   * `delegatedScopeFor` yields a `delegated_upload` context whose
   * `app_granted_item_ids()` is this session's own grant, so
   * `documents_delegated_upload`'s `id = ANY(...)` decides — a document outside
   * the grant is invisible to `findUnique`, the service's existing `null` check
   * raises 404, and nothing is ever signed for it (`documents.service.ts` reads
   * before it presigns, and a test in that module pins it). That is a database
   * guarantee, unlike the portal's other reads, and it is why this handler adds
   * no ownership check of its own: a check that could answer 403 would confirm
   * the document exists.
   *
   * A session whose grant is EMPTY — an onboarding session that has never
   * uploaded — cannot have a delegated context built for it at all
   * (`ScopeContextSchema` refuses one, for the good reason that an empty grant
   * reads as "no restriction" to a human and denies everything in SQL). It gets
   * the same 404, because there is nothing it may reach, and 404 is what the
   * database would have produced anyway.
   */
  private async principalFor(authorization: string | undefined): Promise<ScopeContext> {
    if (authorization === undefined || authorization.trim() === '') {
      // `require()` resolves the context inside Nest's pipeline, so a bad one
      // leaves as a 401 problem+json rather than an Express-level crash (#75).
      return this.context.require();
    }

    const facts = await this.portalAuth.resolveForDocumentOriginal(authorization);
    const delegated = delegatedScopeFor(facts);
    if (!delegated.ok) throw notFoundForPortal();
    return delegated.context;
  }

  @Get(':documentId/events')
  @HttpCode(HttpStatus.OK)
  async events(@Param('documentId') documentId: string, @Query() query: unknown) {
    const params = parseBoundary(listDocumentEventsParams, { documentId }, 'documentId');
    const parsed = parseBoundary(listDocumentEventsQueryParams, coerceQuery(listDocumentEventsQueryParams, query), 'query parameters');
    return this.service.listDocumentEvents(await this.context.require(), params.documentId, parsed);
  }

  @Get(':documentId/extractions')
  @HttpCode(HttpStatus.OK)
  async extractions(@Param('documentId') documentId: string, @Query() query: unknown) {
    const params = parseBoundary(listDocumentExtractionsParams, { documentId }, 'documentId');
    const parsed = parseBoundary(listDocumentExtractionsQueryParams, coerceQuery(listDocumentExtractionsQueryParams, query), 'query parameters');
    return this.service.listDocumentExtractions(await this.context.require(), params.documentId, parsed);
  }
}

/**
 * The 404 a portal session with nothing in its grant receives.
 *
 * Word for word the service's own `notFound()` — same code, same title, same
 * detail, and it echoes no id back. It has to be indistinguishable: a caller
 * must not be able to tell "your session may reach no documents at all" from
 * "that document is not yours", because the first sentence is a fact about the
 * session and the second would be a fact about someone else's document.
 *
 * `NT-VAL-001` rather than a not-found code of its own: the `ErrorCode` enum in
 * `openapi.yaml` has none, and this is the house fallback for an otherwise
 * uncoded 4xx (`ProblemFilter.CODE_BY_STATUS`) — see `documents/CLAUDE.md`.
 */
function notFoundForPortal(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Document not found', 'No document with that id.');
}
