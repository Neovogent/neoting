/**
 * The Trash predicate — **the one place "deleted" is spelled** (Documents
 * management, 2 Sep 2026).
 *
 * ## Why a helper and not `{ deletedAt: null }` written out per call site
 *
 * This is the `PORTAL_HIDDEN_DOCUMENT_STATE` shape, and it exists for the same
 * reason that constant does: **a list filter and a count that encode the same
 * exclusion in two places will eventually disagree, and the more permissive of
 * the two wins on the day it matters.** The document surfaces already prove the
 * point — "hidden" is currently spelled three different ways across this
 * codebase (`state: { not: 'ARCHIVED' }` in `documents.service.ts`,
 * `state: { not: PORTAL_HIDDEN_DOCUMENT_STATE }` in
 * `portal-documents.service.ts`, `archivedAt: null` in the chat and coding
 * paths), and those three are not equivalent. Deletion gets one spelling from
 * the start.
 *
 * ## What it is NOT
 *
 * ⚠ **This is not a tenancy boundary and must never be read as one.** Tenancy is
 * RLS, and every query that spreads this still runs inside `scopedDb`
 * (`documents.service.ts#buildFilters` carries the same warning about
 * `businessId`). This is a product predicate applied ON TOP of the set RLS has
 * already narrowed to: a deleted document belonging to another practice was
 * invisible before this predicate and is invisible without it.
 *
 * ## Deletion is a timestamp, not a `DocumentState`
 *
 * `documents.deleted_at`, added by `20260902220000_document_soft_delete`. A
 * ninth `DocumentState` member would have broken every total mapping over that
 * enum — `portal-document-status.ts` above all, which turns a state into one of
 * the five words a CLIENT is shown, and where "deleted" must never appear — and
 * it would have destroyed the state a restore has to put back. See the migration
 * header for the full argument.
 */

/**
 * The two shapes, written as exact literal types rather than as
 * `Prisma.DocumentWhereInput['deletedAt']`.
 *
 * That looks like the more honest spelling and is the wrong one here: the Prisma
 * field type includes `undefined`, and `apps/api` compiles with
 * `exactOptionalPropertyTypes`, so a value typed that way is not assignable to a
 * `DocumentWhereInput` at all. Being exact also buys the thing this file exists
 * for — `notDeleted()` and `onlyDeleted()` have DIFFERENT types, so they cannot
 * be swapped by a refactor without the compiler noticing.
 */
type NotDeleted = { readonly deletedAt: null };
type OnlyDeleted = { readonly deletedAt: { readonly not: null } };

/**
 * `AND` this into any `documents` query that should not see Trash. Spread it
 * rather than nesting it, so it composes with an existing `where` without an
 * extra `AND` layer:
 *
 * ```ts
 * where: { businessId, ...notDeleted() }
 * ```
 *
 * A separate function per direction, rather than `deletedFilter(boolean)`,
 * because the two are read at a glance and a boolean argument at a call site is
 * not — `notDeleted()` beside `onlyDeleted()` cannot be got the wrong way round
 * by a misplaced `!`.
 */
export function notDeleted(): NotDeleted {
  return { deletedAt: null };
}

/** The Trash listing, and nothing else: `GET /v1/documents?deleted=true`. */
export function onlyDeleted(): OnlyDeleted {
  return { deletedAt: { not: null } };
}

/**
 * The listing predicate, chosen by the contract's `deleted` query parameter.
 *
 * **Total over the two directions on purpose.** `deleted` defaults to `false` in
 * the contract, so a caller who says nothing gets `notDeleted()` — which is what
 * makes "the default listing excludes Trash" true of the SERVER rather than of
 * whatever the caller remembered to send.
 */
export function deletedFilterFor(deleted: boolean): NotDeleted | OnlyDeleted {
  return deleted ? onlyDeleted() : notDeleted();
}
