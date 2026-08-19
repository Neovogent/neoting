import type {
  BankTransaction as BankTransactionRow,
  Chase as ChaseRow,
  ChaseMessage as ChaseMessageRow,
  SmsLog as SmsLogRow,
} from '@prisma/client';

import type { Chase, ChaseItem, ChaseMessage, ChaseSummary, SmsOutboxMessage } from '@neoting/contracts/model';

/**
 * Prisma row → contract shape, for the chase read surface (METH Stage 8 — the
 * three GETs `GET /v1/chases`, `/chases/{id}`, `/sms-outbox`).
 *
 * It lives beside the read service rather than in `common/` because the chase
 * module is the ONLY module that projects these rows — unlike `document-response.ts`,
 * which two modules share. If a second consumer ever appears it moves to
 * `common/` and joins the public seam; until then a name here is internal
 * (`apps/api/CLAUDE.md`, Boundaries).
 *
 * **Money is integer pence, straight through.** `amountPence` is the integer
 * Prisma typed; no arithmetic, no coercion, no float ever touches it — the one
 * thing that must never happen to money on a read path (repo CLAUDE.md, R5).
 *
 * **Nullable columns project as explicit `null`, never omitted.** The contract
 * fields are optional-and-nullable (`string | null`), and under this app's
 * `exactOptionalPropertyTypes` a present key must carry a non-undefined value;
 * `null` is the honest "this is known to be absent" the summary shapes want,
 * matching `document-response.ts`. (`sentAt` on a message is the one genuine
 * "did not happen yet" and is nulled for the same reason.)
 */

/**
 * The list shape (`ChaseSummary`). `itemCount` is derived from the stored
 * `itemRefs` array — one grouped chase covers many receipts (SoT §8.2), so the
 * count is the length of that list, never 1. The contract guarantees `>= 1`; a
 * chase with an empty `itemRefs` is a malformed row the executor never writes,
 * and `readItemRefs` falls back to the single-transaction convenience column so
 * the count is honest even then.
 */
export function toChaseSummary(row: ChaseRow): ChaseSummary {
  return {
    id: row.id,
    businessId: row.businessId,
    detectionEngine: row.detectionEngine,
    state: row.state,
    recipientContactId: row.recipientContactId,
    itemCount: Math.max(1, chaseItemRefs(row).length),
    actionProposalId: row.actionProposalId,
    firstSentAt: toIso(row.firstSentAt),
    lastSentAt: toIso(row.lastSentAt),
    closedAt: toIso(row.closedAt),
    closedReason: row.closedReason,
    closedByDocumentId: row.closedByDocumentId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The full record (`Chase` = `ChaseSummary` + items + messages). Deliberately
 * built ON TOP of `toChaseSummary`, so a summary field cannot be present in the
 * list and missing from the detail — the same discipline `toDocumentResponse`
 * keeps with `toDocumentSummary`.
 *
 * The caller fetches the item transactions (by `itemRefs`) and the messages
 * inside the SAME scoped transaction and hands them here — this stays a pure
 * projection with no database of its own, so it can never become a way around
 * `scopedDb`.
 */
export function toChaseDetail(
  row: ChaseRow,
  transactions: readonly BankTransactionRow[],
  messages: readonly ChaseMessageRow[],
): Chase {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const refs = chaseItemRefs(row);
  const closed = isChaseReceivedClose(row.state);

  return {
    ...toChaseSummary(row),
    // One item per chased transaction ref, in the order the chase recorded them.
    // A ref whose transaction RLS did not return is dropped rather than faked —
    // the accountant sees what they can see, never a placeholder for what they
    // cannot. `items` is `minItems: 1` in the contract; every chase the executor
    // writes has at least one reachable transaction (it resolved them all at
    // approve time), so an empty list here is a row that should not exist.
    items: refs.flatMap((ref) => {
      const txn = byId.get(ref);
      return txn === undefined ? [] : [toChaseItem(txn, closed)];
    }),
    messages: messages.map(toChaseMessage),
  };
}

/**
 * One chased item — today always an unmatched bank transaction (engine (a)).
 *
 * `received` answers "has a matching document arrived for this item". It is
 * derived, not stored, from the two facts the read can see: this transaction is
 * no longer `UNMATCHED` (its paperwork is attached — true whichever channel
 * brought it), OR the caller says the chase-level close credits THIS item.
 *
 * ⚠ `chaseReceived` is a per-ITEM claim, not "the chase is closed". Stage 8's
 * auto-close closes the whole chase on the FIRST matching document, so a
 * grouped chase ("one text, many receipts", SoT §8.2) goes `CLOSED_RECEIVED`
 * with its other lines still outstanding. A caller that passes
 * `isChaseReceivedClose(chase.state)` for every ref therefore marks all of them
 * received off one upload — which told a portal client the receipt we were
 * still asking for had already arrived. Pass true only for the ref the close
 * actually matched (`chase.transactionId`); see `portal-context.service.ts`.
 * // DEMO-MOCK: per-item receipt tracking replaces this derivation when engines
 * (b)–(e) and partial closure land.
 */
export function toChaseItem(txn: BankTransactionRow, chaseReceived: boolean): ChaseItem {
  return {
    transactionId: txn.id,
    merchantName: txn.merchantName,
    descriptionRaw: txn.descriptionRaw,
    amountPence: txn.amountPence,
    bookedAt: txn.bookedAt.toISOString(),
    received: chaseReceived || txn.matchState !== 'UNMATCHED',
  };
}

/**
 * One message on a chase. `body` is the verbatim text shown at review and sent
 * (the Review → Approve guarantee) — this read passes it through untouched, as
 * it must. The contract omits `chaseId`'s parent path but keeps it on the
 * message shape, so it is carried.
 */
export function toChaseMessage(row: ChaseMessageRow): ChaseMessage {
  return {
    id: row.id,
    chaseId: row.chaseId,
    channel: row.channel,
    body: row.body,
    recipientE164: row.recipientE164,
    deliveryState: row.deliveryState,
    sentAt: toIso(row.sentAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One recorded SMS as the demo outbox (the "client's phone") renders it. Reads
 * from the same `sms_log` rows the real Twilio sender will write, so the surface
 * survives the un-faking; only its audience changes (SoT §8, METH §0.5).
 *
 * `portalUrl` is the portal link carried inside `body`, extracted so the outbox
 * screen can make it tappable — a demo affordance, a real phone taps the text
 * itself. It is pulled from the composed copy's own marker (`Upload securely: `,
 * `sms-copy.ts`), never re-derived, so what the screen links to is exactly what
 * the client received.
 */
export function toSmsOutboxMessage(row: SmsLogRow): SmsOutboxMessage {
  return {
    id: row.id,
    businessId: row.businessId,
    toE164: row.toE164,
    body: row.body,
    deliveryState: row.deliveryState,
    chaseId: row.chaseId,
    portalUrl: extractPortalUrl(row.body),
    sentAt: row.sentAt.toISOString(),
  };
}

/** The marker `composeChaseSms` puts before the portal link. One place, one string. */
const PORTAL_LINK_MARKER = 'Upload securely: ';

/**
 * The portal link out of a composed SMS body, or `null` when there is none.
 *
 * Split on the marker composition emits (`sms-copy.ts`), take the trailing token
 * up to the first whitespace, and return `null` if the marker is absent or the
 * tail is empty — a message that is not a chase SMS (a future reminder, an ad-hoc
 * note) legitimately has no link, and the outbox must not invent one. This reads
 * the message's OWN text; it never signs or verifies, so it cannot leak or mint
 * authority.
 */
export function extractPortalUrl(body: string): string | null {
  const at = body.indexOf(PORTAL_LINK_MARKER);
  if (at === -1) return null;
  const tail = body.slice(at + PORTAL_LINK_MARKER.length).trimStart();
  if (tail === '') return null;
  const end = tail.search(/\s/u);
  const link = end === -1 ? tail : tail.slice(0, end);
  return link === '' ? null : link;
}

/**
 * The stored `itemRefs` JSON as a string array. It is written by the executor as
 * `string[]` (the chased transaction ids), but the column is bare Prisma `Json`,
 * so the read surface narrows rather than trusts: a non-array, or an array with a
 * non-string in it, yields the strings it can and drops the rest. A row with no
 * usable refs falls back to the single-transaction convenience column so the
 * count and item list are never emptier than the chase truly is.
 *
 * Exported (and taking only the two columns it reads) because THREE readers now
 * need the same narrowing — this projection, `chases.service`'s item fetch, and
 * the OTP portal's `GET /portal/context` (METH Stage 9). Three copies of "what
 * counts as an item ref" is how the accountant's chase detail and the client's
 * portal list start disagreeing about what is being chased.
 */
export function chaseItemRefs(row: Pick<ChaseRow, 'itemRefs' | 'transactionId'>): string[] {
  const raw = row.itemRefs;
  const refs = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  if (refs.length > 0) return refs;
  return row.transactionId === null ? [] : [row.transactionId];
}

/**
 * `CLOSED_RECEIVED` is the auto-close every-item-received state (SoT §8.5), and
 * therefore the chase-level half of `ChaseItem.received`. Exported for the same
 * reason as `chaseItemRefs`: the portal renders the same `received` flag to the
 * client that the accountant sees, and it must be the same predicate.
 */
export function isChaseReceivedClose(state: ChaseRow['state']): boolean {
  return state === 'CLOSED_RECEIVED';
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
