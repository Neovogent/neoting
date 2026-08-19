/**
 * The public seam of ingestion-routing (Boundaries, ./CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend
 * on; everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 * Growing this list is a boundary decision, not a convenience — a name added
 * here is a name every other module is now allowed to build against, which
 * makes it this module's API in exactly the G7 sense, minus the contract file.
 *
 * Today's surface is deliberately small: the documents read lane serves
 * objects this module ingested, so it needs the store interface to type
 * against and the config-driven selector to provide one — nothing else. The
 * composition roots (`app.module.ts`, `worker/`) wire internals directly and
 * are exempt by location: assembly is their job. Integration tests are exempt
 * the same way `no-restricted-imports` already exempts them — proving
 * behaviour across module seams is what they are for.
 */
export type { DocumentStore } from './storage/document-store.js';
export { selectDocumentStore } from './storage/select-document-store.js';
/**
 * Grown for the Review → Approve engine (METH S3, issue #122): the
 * `document.route` executor defers dedupe-on-route, and the engine drives the
 * follow-up post-commit through validation-dedupe's structural
 * `DedupeDetection` seam — with THIS module's real detector behind it. The
 * class was already the cross-module composition point in the #81 integration
 * test; the engine is its first production consumer.
 */
export { PrismaDuplicateDetector } from './queue/duplicate-detector.js';

/**
 * Grown for the OTP portal's delegated upload (METH Stage 9, SoT §4 Stage 8.4).
 *
 * `POST /v1/portal/uploads` is the SAME intent → presigned `PUT` → complete flow
 * as `/document-uploads`, under a delegated scope — the contract says so, and
 * says it twice: the portal operation's own description, and
 * `completeDocumentUpload` accepting the portal bearer alongside the workspace
 * session. So `modules/portal` mints an intent that THIS module's completion
 * path then verifies, which means both halves have to agree on the cap, the
 * allowlist, the object key, the token format and the derived document id.
 *
 * They agree by being the same code. Everything named here is a MECHANISM the
 * portal reuses rather than re-derives — a second `uploadIntentKey` or a second
 * MIME allowlist is how the two lanes start disagreeing about what an upload is,
 * and the disagreement would surface as a client's receipt failing to complete
 * on a phone in a car park.
 *
 * What is deliberately NOT here: `WebUploadService` itself. The portal's intent
 * differs in the one place that matters — the business comes from the session
 * row, not the request body, and the derived document id has to be granted to
 * the session before the client can complete — and injecting the service across
 * the boundary would make `PortalModule` and `WebUploadModule` mutually
 * dependent (web-upload already imports the portal to honour the bearer).
 */
export { documentIdFor } from './queue/document-sink.js';
export { uploadIntentKey } from './storage/document-store.js';
export { isAllowedMime, maxBytesForChannel } from './web-upload/upload-policy.js';
export { signUploadToken, type UploadClaims } from './web-upload/upload-token.js';
