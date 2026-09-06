import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import { PORTAL_SESSION_CONTEXT, PortalSessionContextResolver, portalVisibleDocuments, systemScopeFor } from '../portal/index.js';
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
    const principal = await this.principalFor(authorization);
    return this.service.getDocumentOriginal(principal.context, params.documentId, principal.alsoWhere);
  }

  /**
   * Which of the two principals is asking for an original, and what bounds it.
   *
   * **A bearer means the portal**, judged as a portal session on its own merits
   * — the resolver re-reads the `otp_sessions` row and re-checks its scope, its
   * verification and its expiry, so holding a cookie as well changes nothing.
   * No `Authorization` header at all is the accountant, unchanged.
   *
   * ## The portal path changed on 7 Sep 2026 (review item 18)
   *
   * It used to build `delegatedScopeFor(facts)`, so
   * `documents_delegated_upload`'s `id = ANY(app_granted_item_ids())` decided.
   * That is the stronger kind of boundary and it is the one this handler wanted.
   * **It also meant a client could open almost nothing.** A grant is widened
   * only by `grantItems`, which only the upload path calls, so it holds exactly
   * the documents THIS sign-in uploaded: sign in tomorrow and yesterday's
   * receipt is a 404. Probed live against American Burger on 7 Sep 2026 — all
   * five rows the client's own list returns, including the `SMS_PORTAL` one they
   * sent themselves, answered 404. So the portal shipped a browsable list of
   * documents it could not open, which is item 18's whole complaint.
   *
   * Shakib's ruling was *"any document in their own list"*. Two ways to get
   * there: a new RLS branch meaning "this client's whole business", which is a
   * `prisma/` change and a stop-and-ask — or the pattern the portal's own reads
   * already use, which is the practice SYSTEM context narrowed **in the query**
   * by the session's business. This takes the second, and says so plainly rather
   * than implying SQL is still doing the work:
   *
   * - the predicate is `portalVisibleDocuments(facts)`, **the same expression**
   *   `GET /portal/documents` builds its list from, so the set a client can open
   *   and the set a client can see are one set by construction — including the
   *   deleted and archived exclusions, which means an accountant who withdraws a
   *   document withdraws it from both surfaces at once;
   * - it is built from `facts.businessId`, off the `otp_sessions` row the server
   *   wrote and the resolver re-checks on every request, and there is no
   *   `businessId` argument on this operation for a caller to supply or a
   *   handler to forget;
   * - it goes INTO the query, never over its result — see `getDocumentOriginal`,
   *   which reads before it presigns for the same reason.
   *
   * What did NOT change: this handler still adds no ownership check that could
   * answer 403, because a 403 confirms the document exists. Everything outside
   * the predicate is a 404 that reads exactly like every other 404.
   *
   * ⚠ **A CHASE session reaches this too** (`resolveForDocumentOriginal` takes
   * both kinds), and it now sees the business rather than its own grant. That is
   * the widening's real cost, and it is stated here rather than buried: a
   * forwarded chase link is deliberately anonymous, and its holder can now open
   * any document of the business the chase was raised against. Narrowing it to
   * `resolveOnboarding` would close that and would also stop the chase portal
   * previewing what it has just uploaded, which is a live surface — so the
   * narrower door is available the day the owner wants it, and this paragraph is
   * the record that it was not passed over silently.
   */
  private async principalFor(
    authorization: string | undefined,
  ): Promise<{ context: ScopeContext; alsoWhere?: Prisma.DocumentWhereInput }> {
    if (authorization === undefined || authorization.trim() === '') {
      // `require()` resolves the context inside Nest's pipeline, so a bad one
      // leaves as a 401 problem+json rather than an Express-level crash (#75).
      return { context: await this.context.require() };
    }

    const facts = await this.portalAuth.resolveForDocumentOriginal(authorization);
    return { context: systemScopeFor(facts), alsoWhere: portalVisibleDocuments(facts) };
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
