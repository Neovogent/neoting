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
 * Above this many items the copy summarises — mirrors the server's
 * `CHASE_SUMMARISE_THRESHOLD` (`chase/sms-copy.ts`, the 6 Sep 2026 §8.2
 * amendment, review item 31). The two must move together.
 */
export const CHASE_SUMMARISE_THRESHOLD = 3;

const MONTH_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "09 Aug 2026" → a sortable number, or null when the shape is unknown. */
function dayValue(displayDate: string): number | null {
  const m2 = /^(\d{1,2})\s+([A-Za-z]{3})\s*(\d{4})?/.exec(displayDate.trim());
  if (!m2) return null;
  const month = MONTH_ORDER.indexOf(m2[2] ?? '');
  if (month < 0) return null;
  return Number(m2[3] ?? '0') * 10_000 + (month + 1) * 100 + Number(m2[1]);
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
 *
 * ⚠ And long lists SUMMARISE — the 6 Sep 2026 amendment (review item 31):
 * more than three items becomes "12 payments between 3 Aug and 28 Aug,
 * including X and Y" instead of a thirty-descriptor recitation, mirroring the
 * server template. This client-side compose is a PREVIEW of what the engine
 * writes at proposal creation, never a promise of exact words — the card says
 * so, and Read review shows the real bytes.
 */
export function composeChaseBody(businessName: string, items: readonly DemoChaseItem[], portalLink: string): string {
  if (items.length > CHASE_SUMMARISE_THRESHOLD) {
    const days = items.map((i) => ({ value: dayValue(i.date), label: shortDay(i.date) }));
    const known = days.filter((d): d is { value: number; label: string } => d.value !== null);
    const from = known.length ? known.reduce((a, b) => (b.value < a.value ? b : a)).label : null;
    const to = known.length ? known.reduce((a, b) => (b.value > a.value ? b : a)).label : null;
    const period = from === null || to === null ? '' : from === to ? ` on ${from}` : ` between ${from} and ${to}`;
    const named = [...new Set(items.map((i) => i.supplier))].slice(0, 2);
    const examples = named.length <= 1 ? named[0] ?? '' : `${named[0]} and ${named[1]}`;
    return `${businessName} Accounts: we're missing receipts for ${items.length} payments${period}, including ${examples}. Upload securely: ${portalLink}`;
  }
  const parts = items.map((i) => `${i.supplier} on ${shortDay(i.date)}`);
  const list =
    parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
  const noun = items.length === 1 ? 'the receipt' : 'the receipts';
  return `${businessName} Accounts: we're missing ${noun} for ${list}. Upload securely: ${portalLink}`;
}

/**
 * The accountant's own wording in the engine's frame — the preview twin of the
 * server's `composeCustomChaseBody` (review item 31): greeting and secure link
 * stay the engine's, the middle sentence is theirs.
 */
export function composeCustomChaseBody(businessName: string, message: string, portalLink: string): string {
  return `${businessName} Accounts: ${message} Upload securely: ${portalLink}`;
}

/** "+44 7700 900123" → "+447700900123", or null when it cannot be an E.164 number. */
export function toE164(mobile: string): string | null {
  const compact = mobile.replace(/[\s()-]/g, '');
  // A UK national mobile (07…) is rewritten, not refused (5 Sep 2026 review
  // finding: the hint demanded "+447700900001" of a UK accountant). This is a
  // deterministic rule, not a guess — an 11-digit 07 number is a UK mobile and
  // nothing else, and this product is UK-first. Other countries stay
  // +-prefixed until a locale-aware rewrite is a real requirement.
  if (/^07[0-9]{9}$/.test(compact)) return `+44${compact.slice(1)}`;
  return /^\+[1-9][0-9]{6,14}$/.test(compact) ? compact : null;
}
