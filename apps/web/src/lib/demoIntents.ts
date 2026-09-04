/**
 * Chase composition helpers, and the rule-draft shape the live cards render.
 *
 * **The canned intent table that used to live here is gone.** Classification
 * and rule parsing moved to the server in the §9 chat runtime
 * (`apps/api/src/modules/chat-framework`), where the pinned model does the work
 * and `POST /v1/chat/turns` returns the intent plus a draft built from the
 * client's own RLS-scoped records. `src/api/chat.ts` is the wire; `InputRow`
 * calls it. Nothing in the browser classifies an utterance any more.
 *
 * What is left is display-tier and still earns its place: the SMS copy shape
 * the chase composer card renders, and the money/day formatting the review
 * screen shows verbatim.
 */

/** The rule draft a `LiveRuleCard` renders. Filled from the server draft now. */
export interface DemoRuleDraft {
  scopeKey: string;
  categoryCode: string;
  categoryName: string;
  vatTreatment: string | undefined;
}

// ---------------------------------------------------------------------------
// Chase composition helpers — pure, unit-tested, display-tier.
//
// // DEMO-MOCK: composition belongs SERVER-SIDE at proposal time
// // (`apps/api/src/modules/chase/sms-copy.ts` is the composer; the contract's
// // ChaseSendPayload says "never free-typed by a caller") — but no endpoint
// // runs it yet, so the chat drafts the same copy shape client-side and the
// // review still shows the exact bytes that will send. The signed portal link
// // CANNOT be minted here (no client may hold the HMAC secret), so the body
// // carries a tokenless portal path — the S8/S9 flagged gap, called out on the
// // Stage 13 PR: the compose seam is what closes it.
// ---------------------------------------------------------------------------

export interface DemoChaseItem {
  /** Display-tier float pounds — never sent to the server (the payload carries only ids + text). */
  amount: number;
  /** The app's display date, e.g. "09 Aug 2026". */
  date: string;
  supplier: string;
}

/** 1299 → "£1,299" · 78.4 → "£78.40" — the SoT copy drops whole-pound zeros. */
export function formatPoundsForSms(amount: number): string {
  const value = Math.abs(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `£${value.endsWith('.00') ? value.slice(0, -3) : value}`;
}

/** "09 Aug 2026" → "9 Aug" — the SoT copy's day, no leading zero, no year. */
export function shortDay(displayDate: string): string {
  const m2 = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(displayDate.trim());
  if (!m2) return displayDate;
  return `${Number(m2[1])} ${m2[2]}`;
}

/**
 * The SoT §8.2 copy shape, verbatim — grouped per client, one text covering
 * every item: "American Burger Accounts: we're missing the receipt for Currys
 * on 9 Aug. Upload securely: <link>".
 *
 * ⚠ NO amount in the copy — the 4 Sep 2026 §8.2 amendment, mirrored from the
 * server's `chase/sms-copy.ts`: a lock-screen preview must not carry a
 * client's spending. `formatPoundsForSms` stays exported — the composer CARD
 * still shows the amounts to the accountant beside the checkboxes; they just
 * never enter the message.
 */
export function composeChaseBody(businessName: string, items: readonly DemoChaseItem[], portalLink: string): string {
  const parts = items.map((i) => `${i.supplier} on ${shortDay(i.date)}`);
  const list =
    parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
  const noun = items.length === 1 ? 'the receipt' : 'the receipts';
  return `${businessName} Accounts: we're missing ${noun} for ${list}. Upload securely: ${portalLink}`;
}

/** "+44 7700 900123" → "+447700900123", or null when it cannot be an E.164 number. */
export function toE164(mobile: string): string | null {
  const compact = mobile.replace(/[\s()-]/g, '');
  return /^\+[1-9][0-9]{6,14}$/.test(compact) ? compact : null;
}
