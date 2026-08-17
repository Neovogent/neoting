import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';

import { AppException } from '../problem/problem.js';

/**
 * Cursor pagination — written once, in `common/`, because four more list
 * endpoints are coming behind `GET /documents` (issue #77).
 *
 * **Keyset, never offset.** Governance §3 forbids offset pagination and the
 * contract checker asserts it, but the reason is worth stating: `OFFSET 40` asks
 * the database to count 40 rows it will throw away, and — the part that actually
 * hurts — it counts them *at query time*. Three documents arriving while the user
 * reads page 1 shift every subsequent row down by three, so page 2 re-serves
 * three rows page 1 already showed and the three at the boundary are never seen
 * at all. That is the "never skips or repeats a row" acceptance criterion, and
 * an offset cannot satisfy it at any page size.
 *
 * A keyset cursor instead says *"resume after this exact row"*. New rows landing
 * at the head of a `receivedAt desc` list sort **before** the cursor position and
 * are simply not in the remainder of the scan — no shift, so nothing to skip or
 * repeat. They appear the next time page 1 is fetched, which is what a user
 * expects and what a scroll position implies.
 */

/** The cursor payload. Versioned so a future shape change can be rejected rather than misread. */
const CursorPayload = z.object({
  v: z.literal(1),
  /**
   * The sort field's value on the last row of the previous page, or `null` when
   * that row's value was null. JSON-safe: `Date`s travel as ISO strings and are
   * revived by the field's own decoder, because JSON has no date type and a
   * silently-stringified `Date` would compare as text in Postgres.
   */
  k: z.union([z.string(), z.number(), z.null()]),
  /** That row's id. The unique tie-breaker — without it, rows sharing a sort value are unorderable. */
  id: z.string(),
  /**
   * A fingerprint of the query the cursor was minted for (sort field, direction,
   * and every filter). Paging is only coherent within one query: a cursor from
   * `state=READY` replayed against `state=REJECTED` seeks to a position that
   * means nothing in the second list, and would silently return a wrong page
   * rather than an error. Compared, not trusted.
   */
  f: z.string(),
});

export type CursorPayload = z.infer<typeof CursorPayload>;

/**
 * A sort field, as the caller names it in the contract, paired with how to read
 * it off a row and how to move its value across the wire.
 *
 * `decode` exists because of `Date`. A cursor is JSON, JSON has no date, and
 * handing Prisma the ISO **string** for a `DateTime` column makes Postgres
 * compare text — `'2026-08-16T09:00:00.000Z' < '2026-08-9...'` is true as text
 * and false as time. It fails only on the days the string ordering diverges,
 * which is the worst possible failure schedule.
 */
export interface SortField<Row> {
  /** The Prisma column name. Must be a real column — this is spliced into `orderBy`/`where`. */
  readonly column: string;
  /** Read the sort value off a row for the cursor. Return `null` for a null column. */
  readonly read: (row: Row) => string | number | null;
  /** Revive the JSON value into what Prisma must receive for that column. */
  readonly decode: (value: string | number) => unknown;
  /**
   * Whether the column is nullable **in the database**, which is not a detail.
   * Prisma accepts `orderBy: { col: { sort, nulls } }` only for an optional
   * field and throws a validation error on a required one — so `receivedAt`
   * (required) and `documentDate` (optional) cannot share one code path. It also
   * decides whether the seek predicate needs its null branches at all.
   */
  readonly nullable: boolean;
}

/** A `Date` column: out as ISO, back in as a `Date`. */
export function dateField<Row>(column: string, read: (row: Row) => Date | null, nullable: boolean): SortField<Row> {
  return {
    column,
    read: (row) => read(row)?.toISOString() ?? null,
    decode: (value) => new Date(String(value)),
    nullable,
  };
}

/** A scalar column that survives JSON unchanged — `string`, or an integer (pence stays an integer). */
export function scalarField<Row>(
  column: string,
  read: (row: Row) => string | number | null,
  nullable: boolean,
): SortField<Row> {
  return { column, read, decode: (value) => value, nullable };
}

export interface PageRequest<Row> {
  readonly sort: SortField<Row>;
  readonly order: 'asc' | 'desc';
  readonly limit: number;
  readonly cursor?: string | undefined;
  /**
   * Everything that defines *which* list this is — the parsed filters, the sort
   * and the order. Stringified into the cursor fingerprint, so any change to it
   * invalidates outstanding cursors instead of mis-seeking with them.
   */
  readonly query: unknown;
}

export interface PageQuery {
  /** Splice into the Prisma `where` alongside the caller's filters (`AND`ed). */
  readonly where: Record<string, unknown> | undefined;
  /** Use verbatim as `orderBy`. Two keys: the sort column, then `id`. */
  readonly orderBy: readonly Record<string, unknown>[];
  /** `limit + 1` — the extra row is how `hasMore` is known without a second COUNT query. */
  readonly take: number;
}

/**
 * Deliberately shaped as the contract's list envelope — `data` + `PageInfo`
 * (`openapi.yaml`), not a generic `{ rows }` a caller would have to re-wrap.
 * All three list operations in #77 return exactly this, so a service method can
 * return `toPage(...)` directly and there is no hand-written mapping step in
 * between to drift from the spec.
 */
export interface Page<Row> {
  readonly data: readonly Row[];
  readonly pageInfo: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Turn a page request into the `where` / `orderBy` / `take` a Prisma `findMany`
 * needs. The caller merges `where` with its own filters and runs the query
 * itself — this helper never touches the database, so it stays independent of
 * `scopedDb` and cannot become a way around it.
 */
export function pageQuery<Row>(request: PageRequest<Row>): PageQuery {
  const { sort, order } = request;
  // NULLS LAST in BOTH directions, deliberately. Postgres defaults to nulls
  // first on DESC, so the default would put every document with no
  // `documentDate` at the top of "newest first" — the emptiest rows first, which
  // is exactly backwards for a review queue. Pinning it also makes the seek
  // predicate below decidable: "nulls are last" is a rule the cursor can encode.
  //
  // Only for a nullable column, though. Prisma validates `nulls` against the
  // field's optionality and throws on a required one, so handing `receivedAt`
  // the same shape as `documentDate` fails at runtime — a test with a nullable
  // sort field would pass and the DEFAULT sort would 500.
  const orderBy = [
    sort.nullable ? { [sort.column]: { sort: order, nulls: 'last' } } : { [sort.column]: order },
    { id: order },
  ];
  const take = request.limit + 1;

  if (request.cursor === undefined) return { where: undefined, orderBy, take };

  const after = decodeCursor(request.cursor, fingerprint(request.query));
  return { where: seekPredicate(sort, order, after), orderBy, take };
}

/**
 * The seek predicate: everything strictly after `(k, id)` in the given order.
 *
 * Written as an `OR` of two comparisons rather than the row-value form
 * `(col, id) < (k, id)` — Postgres supports that, Prisma has no way to express
 * it, and dropping to `$queryRaw` to get it would put a user-supplied sort
 * column into a hand-built SQL string. This shape is index-usable and needs no
 * interpolation.
 */
function seekPredicate<Row>(sort: SortField<Row>, order: 'asc' | 'desc', after: CursorPayload): Record<string, unknown> {
  const beyond = order === 'asc' ? 'gt' : 'lt';

  // The previous page ended ON a null. Nulls are last in both directions, so
  // everything remaining is also null and only the id tie-break separates them.
  if (after.k === null) {
    return { AND: [{ [sort.column]: null }, { id: { [beyond]: after.id } }] };
  }

  const value = sort.decode(after.k);
  return {
    OR: [
      { [sort.column]: { [beyond]: value } },
      { [sort.column]: value, id: { [beyond]: after.id } },
      // ...and then the null tail, which sorts after every non-null value in
      // both directions. Omitting this branch silently truncates the list at the
      // first null — the bug reads as "documents with no supplier don't exist".
      ...(sort.nullable ? [{ [sort.column]: null }] : []),
    ],
  };
}

/**
 * Trim the extra row and mint the next cursor.
 *
 * `rows` must be the result of a `findMany` using {@link pageQuery}'s `take`, so
 * it holds at most `limit + 1`. The `+1` is the entire `hasMore` mechanism: a
 * `COUNT(*)` over the same filters would double the work on every page and still
 * be a lie by the time it was serialised.
 */
export function toPage<Row extends { id: string }>(rows: readonly Row[], request: PageRequest<Row>): Page<Row> {
  const hasMore = rows.length > request.limit;
  const page = hasMore ? rows.slice(0, request.limit) : rows;
  const last = page.at(-1);
  return {
    data: page,
    pageInfo: {
      // No next cursor when there is no next page. A cursor that returns an
      // empty page reads to a client as "keep going", and infinite scroll does.
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({ v: 1, k: request.sort.read(last), id: last.id, f: fingerprint(request.query) })
        : null,
      hasMore,
    },
  };
}

/**
 * Base64url of the JSON payload. **Opaque, not secret** — the contract says
 * "never construct one by hand", and this keeps that honest by making the shape
 * unstable-looking rather than by encrypting it.
 *
 * It is deliberately NOT signed. A tampered cursor cannot widen access: the
 * query it feeds still runs inside `scopedDb`, so RLS is the boundary either
 * way, and the worst a forged cursor achieves is a page of the caller's own rows
 * starting somewhere odd. Signing would add a secret to rotate for no boundary
 * it actually moves.
 */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and **validate**. A cursor is client-supplied input like any other, so
 * it is Zod-parsed rather than trusted: malformed base64, valid base64 that is
 * not JSON, JSON of the wrong shape, and a cursor minted for a different query
 * all land on the same 400 rather than reaching Prisma as `undefined` and
 * quietly serving page 1 again.
 */
function decodeCursor(cursor: string, expectedFingerprint: string): CursorPayload {
  const parsed = CursorPayload.safeParse(readJson(cursor));
  if (!parsed.success) throw badCursor('It is not a cursor this API issued.');
  if (parsed.data.f !== expectedFingerprint) {
    // Naming the cause matters here: from the outside this looks like the API
    // losing its place, and the fix ("start from the first page") is not
    // guessable from a bare "invalid cursor".
    throw badCursor('It was issued for a different set of filters or a different sort. Start again from the first page.');
  }
  return parsed.data;
}

function readJson(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null; // any decode failure is the same answer: not our cursor
  }
}

function badCursor(detail: string): AppException {
  return new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Invalid cursor', detail, [
    { field: 'cursor', message: detail },
  ]);
}

/**
 * A stable fingerprint of the query a cursor belongs to.
 *
 * Keys are sorted so `{a,b}` and `{b,a}` — the same filters in a different query
 * -string order — fingerprint identically; without that, reordering the query
 * string would invalidate a live cursor for no reason. `undefined` is dropped so
 * an absent filter and an omitted one agree.
 *
 * It is a HASH, not a prefix of the encoded query, and that distinction was a
 * real bug caught by its own test. Truncating the base64 to keep the cursor
 * short means the fingerprint only covers the first ~16 bytes of the query —
 * which for `{"inbox":[…],"limit":2,"order":"desc","sort":…}` stops before
 * `order` and `sort` are even reached, so changing the sort direction produced
 * an identical fingerprint and the cursor was silently accepted. A digest
 * depends on every byte, which is the whole property being relied on.
 *
 * This is an identity check, not a security control: it catches a cursor
 * replayed against a different list, and the tenancy boundary is RLS regardless.
 */
function fingerprint(query: unknown): string {
  return createHash('sha256').update(stableStringify(query)).digest('base64url').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
