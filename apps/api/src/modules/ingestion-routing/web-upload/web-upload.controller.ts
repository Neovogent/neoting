import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';

import type { Document, DocumentUpload } from '@neoting/contracts/model';
import {
  completeDocumentUploadBody,
  completeDocumentUploadHeader,
  completeDocumentUploadParams,
  createDocumentUploadBody,
  createDocumentUploadHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../../common/context/context.module.js';
import type { RequestContext } from '../../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../../common/validation/parse-boundary.js';
import { WEB_UPLOAD_SERVICE } from './tokens.js';
import type { WebUploadService } from './web-upload.service.js';

/**
 * Web upload, two steps (issue #76, SoT §4 Stage 1).
 *
 * The API never receives the file. Step one declares what is coming and returns
 * a presigned `PUT` straight to object storage; step two verifies what landed
 * and puts the document into the pipeline. That is what keeps a 100 MB
 * accountant batch off the request path — and keeps the OTP portal usable on a
 * phone with one bar.
 *
 * **This is `ingest`, not `proposal`.** Submitting evidence creates a new record
 * and changes no existing one, so it needs no Approve and introduces no
 * side-effect endpoint outside the Review → Approve spine (Governance §10).
 * The contract says so mechanically: both operations are `x-nt-side-effect:
 * ingest`, which the architectural route-table test reads.
 *
 * Thin by design (apps/api/CLAUDE.md, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service, return its result.
 */
@Controller('document-uploads')
export class WebUploadController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(WEB_UPLOAD_SERVICE) private readonly service: WebUploadService,
  ) {}

  /** Step one — declare the upload, get a presigned PUT. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<DocumentUpload> {
    const key = parseIdempotencyKey(createDocumentUploadHeader, idempotencyKey);
    const request = parseBoundary(createDocumentUploadBody, body, 'request body');
    // `require()` resolves the context here, inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.createUpload(await this.context.require(), request, key);
  }

  /** Step two — the bytes have landed; verify them and enter the pipeline. */
  @Post(':uploadId/complete')
  @HttpCode(HttpStatus.CREATED)
  async complete(
    @Param('uploadId') uploadId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Document> {
    const key = parseIdempotencyKey(completeDocumentUploadHeader, idempotencyKey);
    const params = parseBoundary(completeDocumentUploadParams, { uploadId }, 'uploadId');
    const { byteHash } = parseBoundary(completeDocumentUploadBody, body, 'request body');
    return this.service.completeUpload(await this.context.require(), params.uploadId, byteHash, key);
  }
}
