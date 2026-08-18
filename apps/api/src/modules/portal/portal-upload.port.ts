import type { z } from 'zod';

import type { DocumentUpload } from '@neoting/contracts/model';
import type { createPortalUploadBody } from '@neoting/contracts/zod';

import type { PortalSessionFacts } from './portal-session-context.js';

/**
 * The seam between `POST /v1/portal/uploads`'s **controller** and its
 * **implementation** — built by two agents in the same METH Stage 9, which is
 * why it is a named interface at all rather than a class the controller imports
 * directly.
 *
 * It has outlived that: `portal.controller.ts` depends on this shape, not on
 * `PrismaPortalUploadService`, so the controller can be unit-tested without an
 * object store, a Prisma client or a signing secret anywhere near it. The
 * implementation lives in `portal-upload.service.ts` and is wired to
 * `PORTAL_UPLOAD_SERVICE` in `portal.module.ts`.
 */

/**
 * The intent as the **boundary** produced it — `z.infer` of the generated
 * schema, not the generated `PortalUploadRequest` interface, for the reason
 * `web-upload.service.ts` documents: `exactOptionalPropertyTypes` is on, Zod
 * infers `transactionId?: string | null | undefined` and the interface writes
 * `transactionId?: string | null`, and under that flag a parsed body will not
 * assign to the interface. Both are generated from `openapi.yaml`; this is the
 * one that actually validated the value, so the controller needs no cast.
 */
export type PortalUploadIntent = z.infer<typeof createPortalUploadBody>;

export interface PortalUploadService {
  /**
   * Step one of two: declare what is coming, get a presigned `PUT`. The API
   * never receives the bytes — the client completes with
   * `POST /v1/document-uploads/{uploadId}/complete`, which accepts this
   * session's bearer (`openapi.yaml`).
   *
   * `facts` is the resolved `otp_sessions` row and is the ONLY source of tenancy
   * on this path: a portal caller has no business to name and must not be able
   * to name one. `idempotencyKey` is contract-required and already parsed by the
   * controller.
   */
  createPortalUpload(
    facts: PortalSessionFacts,
    request: PortalUploadIntent,
    idempotencyKey?: string,
  ): Promise<DocumentUpload>;
}
