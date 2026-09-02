import { Controller, Headers, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';

import {
  deleteDocumentHeader,
  deleteDocumentParams,
  restoreDocumentHeader,
  restoreDocumentParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { DocumentManagementService } from './document-management.service.js';
import { DOCUMENT_MANAGEMENT_SERVICE } from './tokens.js';

/**
 * Trash and restore (document management, 2 Sep 2026).
 *
 * ## A second controller, on the same `documents` path
 *
 * `documents.controller.ts` is the read surface and its header states the
 * property that made it worth keeping: five GETs, none of which can write.
 * These two POSTs are the module's first mutations, so they get their own file
 * rather than diluting that — and `apps/api/CLAUDE.md`'s 200-line controller cap
 * points the same way.
 *
 * ⚠ **Route ordering.** This controller declares only `POST` routes with a
 * literal segment after the id, so it cannot shadow — or be shadowed by —
 * `@Get(':documentId')` next door whatever order the module lists them in.
 * `GET /documents/counts` is the one route where order WOULD matter, and it is
 * deliberately on the other controller, declared above its parameter route.
 *
 * ## Both take an `Idempotency-Key`, and it is not ceremony
 *
 * `check-contract.mjs` requires the header on every non-GET operation whose
 * side effect is not `none`, and these are `ingest`. The key is honoured for
 * real (`DocumentManagementService#replayed`) even though the underlying writes
 * are natively idempotent, because the fingerprint is ACTOR-scoped and that is
 * what stops one caller replaying another's response out of the shared
 * in-memory store.
 *
 * Thin by design: parse with the generated schemas, take the request context,
 * call ONE service method, return it.
 */
@Controller('documents')
export class DocumentManagementController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(DOCUMENT_MANAGEMENT_SERVICE) private readonly service: DocumentManagementService,
  ) {}

  /**
   * `POST /documents/{documentId}/deletion` — move to Trash.
   *
   * **No `Authorization` header parameter, unlike `getDocumentOriginal`.** A
   * delegated OTP session may open the original of a receipt it sent; it may not
   * delete one. The operation carries no `security:` override in `openapi.yaml`,
   * so it inherits the global `workspaceSession` default, and this handler takes
   * no header — the arity is the enforcement, the same way
   * `documents.controller.test.ts` pins the arity of the four reads that did not
   * gain a second principal.
   */
  @Post(':documentId/deletion')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('documentId') documentId: string, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const params = parseBoundary(deleteDocumentParams, { documentId }, 'documentId');
    const key = parseIdempotencyKey(deleteDocumentHeader, idempotencyKey);
    // `require()` resolves the context here, inside Nest's pipeline, so a bad
    // one leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.deleteDocument(await this.context.require(), params.documentId, key);
  }

  /** `POST /documents/{documentId}/restoration` — back out of Trash. */
  @Post(':documentId/restoration')
  @HttpCode(HttpStatus.OK)
  async restore(@Param('documentId') documentId: string, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const params = parseBoundary(restoreDocumentParams, { documentId }, 'documentId');
    const key = parseIdempotencyKey(restoreDocumentHeader, idempotencyKey);
    return this.service.restoreDocument(await this.context.require(), params.documentId, key);
  }
}
