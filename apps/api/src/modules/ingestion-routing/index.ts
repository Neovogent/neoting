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
