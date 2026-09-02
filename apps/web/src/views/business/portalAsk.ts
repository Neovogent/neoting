import type { BusinessPortalHome } from '../../api/onboarding';

/**
 * One thing the accountant is waiting for, in the shape the portal's screens
 * pass between themselves.
 *
 * Two kinds, because the server keeps two lists and folding them together
 * would put nulls in money fields: a chased bank line has an amount and a date,
 * a statement request has a calendar month and nothing else.
 *
 * ## ⚠ `transactionId` IS A DECLARATION, NOT AN INSTRUCTION
 *
 * `PortalUploadRequest.transactionId` is contracted, it reaches the signed
 * upload claims, and the server records which ask the client tapped. What it
 * does **not** do is close that ask: auto-close re-derives the match from the
 * extraction (supplier + amount + date) against every open chase, deliberately,
 * so a client who taps the wrong row still gets the right outcome. Verified
 * against `apps/api/src/modules/chase/auto-close.ts` before this UI was built.
 *
 * The consequence for copy is absolute: **starting from an ask may not promise
 * that the ask will close.** The row stays "Requested" until the server flips
 * `received`, which is the same deterministic fact that closes the chase.
 */
export type PortalAsk =
  | {
      readonly kind: 'item';
      readonly transactionId: string;
      /** The merchant, else the client's own bank descriptor, else nothing. */
      readonly label: string | null;
      /** Pounds, signed as the feed records it. */
      readonly amount: number;
      /** "09 Aug 2026" — what every screen in this app renders. */
      readonly date: string;
      readonly received: boolean;
    }
  | {
      readonly kind: 'statement';
      /** `YYYY-MM`. The view formats it into the client's own month name. */
      readonly period: string;
      readonly received: boolean;
    };

/** What travels on the upload for this ask. A statement answers no one line. */
export function transactionIdFor(ask: PortalAsk | null): string | null {
  return ask !== null && ask.kind === 'item' ? ask.transactionId : null;
}

/** A stable React key — the two kinds share a list and must not collide. */
export function askKey(ask: PortalAsk): string {
  return ask.kind === 'item' ? `txn:${ask.transactionId}` : `stmt:${ask.period}`;
}

/**
 * Everything outstanding, statements first.
 *
 * Statements lead because one of them answers a whole month of missing lines,
 * so a client with both should be pointed at the cheaper job first.
 */
export function asksFrom(home: BusinessPortalHome): PortalAsk[] {
  return [
    ...home.statementRequests.map(
      (request): PortalAsk => ({ kind: 'statement', period: request.period, received: request.received }),
    ),
    ...home.items.map(
      (item): PortalAsk => ({
        kind: 'item',
        transactionId: item.transactionId,
        label: item.label,
        amount: item.amount,
        date: item.date,
        received: item.received,
      }),
    ),
  ];
}
