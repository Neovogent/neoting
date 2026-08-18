import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Query } from '@nestjs/common';

import {
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
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
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

  @Get(':documentId')
  @HttpCode(HttpStatus.OK)
  async get(@Param('documentId') documentId: string) {
    const params = parseBoundary(getDocumentParams, { documentId }, 'documentId');
    return this.service.getDocument(await this.context.require(), params.documentId);
  }

  @Get(':documentId/original')
  @HttpCode(HttpStatus.OK)
  async original(@Param('documentId') documentId: string) {
    const params = parseBoundary(getDocumentOriginalParams, { documentId }, 'documentId');
    return this.service.getDocumentOriginal(await this.context.require(), params.documentId);
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
