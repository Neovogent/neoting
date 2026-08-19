import { defineMessages, type MessageDescriptor } from 'react-intl';
import type { Intent, MessagePayload } from './types';

/**
 * The canned intent table for the live golden paths (METH Stage 13).
 *
 * // DEMO-MOCK: Opus via Bedrock replaces this table — the model classifies the
 * // utterance and drafts the action. What it will NOT replace is what happens
 * // next: the intents below render real components over real API data, and
 * // every state change goes through the real Review → Approve engine. The
 * // model is mocked; the actions are not.
 *
 * This runs ONLY when the workspace session is live (`InputRow` gates it), and
 * only ahead of the regex classifier in `resolver.ts` — anything it does not
 * recognise falls through to that classifier, whose GENERAL fallback is the
 * graceful "here's what I can do" card. Matching is deliberately tolerant:
 * the demo script's five utterances must land whether typed or dictated, with
 * fillers, casing and small rewordings absorbed.
 */

const m = defineMessages({
  liveMissing: {
    id: 'pipeline.demoIntents.liveMissing',
    defaultMessage: "Here's what's missing, straight from the bank feed: unmatched transactions with no paperwork, and the chases already out for them.",
  },
  liveChase: {
    id: 'pipeline.demoIntents.liveChase',
    defaultMessage: "I've drafted the chase from the live bank feed. Nothing sends until you read the review and approve it.",
  },
  liveRule: {
    id: 'pipeline.demoIntents.liveRule',
    defaultMessage: "I've parsed that into a rule. It activates only after you review and approve it — and the next matching document arrives pre-coded.",
  },
  livePublish: {
    id: 'pipeline.demoIntents.livePublish',
    defaultMessage: "Here's the publish batch. The review shows the server-computed totals before anything moves.",
  },
  toReview: {
    id: 'pipeline.demoIntents.toReview',
    defaultMessage: 'Here is everything waiting for review.',
  },
  openDocument: {
    id: 'pipeline.demoIntents.openDocument',
    defaultMessage: 'Here it is. Every field shows its confidence and provenance — click any value to correct it.',
  },
});

export interface DemoIntentMatch {
  intent: Intent;
  response: MessageDescriptor;
  payload: Partial<MessagePayload>;
}

export interface DemoIntentContext {
  /** The businesses slice — server ids and names (`GET /businesses`). */
  businesses: readonly { id: string; name: string }[];
  /** The documents on screen, for resolving "open the Currys receipt". */
  documents: readonly { id: string; supplier: string; status: string }[];
}

/**
 * Which business an utterance names, as a SERVER id. Full name first, then a
 * distinctive first word ("American" → American Burger Ltd) — the
 * `resolveScope` heuristic, pointed at the live businesses list because the
 * ids go into proposal payloads the API resolves through RLS.
 */
export function resolveBusiness(
  text: string,
  businesses: readonly { id: string; name: string }[],
): { id: string; name: string } | null {
  const lower = text.toLowerCase();
  const byFullName = businesses.find((b) => lower.includes(b.name.toLowerCase()));
  if (byFullName) return byFullName;
  return (
    businesses.find((b) => {
      const first = (b.name.split(' ')[0] ?? '').toLowerCase();
      return first.length > 3 && lower.includes(first);
    }) ?? null
  );
}

/**
 * The demo cast's chart of accounts (the seeded `refsync_burger_coa` list) —
 * spoken category → the CoA code the extractor profiles and rules code
 * against. // DEMO-MOCK: the real parse resolves against the client's own
 * synced reference lists.
 */
const CATEGORY_TABLE: { spoken: RegExp; code: string; name: string }[] = [
  { spoken: /cost of sales[,\s—-]*food|food cost/i, code: 'COST_OF_SALES_FOOD', name: 'Cost of Sales — Food' },
  { spoken: /cost of sales[,\s—-]*drink|drink cost/i, code: 'COST_OF_SALES_DRINK', name: 'Cost of Sales — Drink' },
  { spoken: /advertising|marketing/i, code: 'ADVERTISING', name: 'Advertising' },
  { spoken: /software|subscriptions?/i, code: 'SOFTWARE', name: 'Software' },
  { spoken: /office equipment/i, code: 'OFFICE_EQUIPMENT', name: 'Office Equipment' },
  { spoken: /general expenses?/i, code: 'GENERAL_EXPENSES', name: 'General Expenses' },
];

export interface DemoRuleDraft {
  scopeKey: string;
  categoryCode: string;
  categoryName: string;
  vatTreatment: string | undefined;
}

const DOC_WORDS: ReadonlySet<string> = new Set([
  'invoice',
  'invoices',
  'bill',
  'bills',
  'receipt',
  'receipts',
  'document',
  'documents',
]);

/**
 * "Whenever Bidfood invoices arrive for American Burger, code them Cost of
 * Sales Food with standard VAT" → a single-tier supplier rule draft. Null when
 * either half is missing — a rule with no supplier or no category is not a
 * rule, and the graceful fallback says so better than a guess would.
 */
export function parseDemoRule(text: string): DemoRuleDraft | null {
  const supplier =
    /whenever\s+(?:an?\s+)?([a-z0-9&' -]{2,30}?)\s+(?:invoices?|bills?|receipts?|documents?)?\s*(?:arrives?|comes? in|lands?)/i.exec(text)?.[1] ??
    /\b(?:from|for)\s+supplier\s+([a-z0-9&' -]{2,30})\b/i.exec(text)?.[1] ??
    null;
  // "Whenever invoices arrive" names no supplier — the lazy capture would
  // otherwise take the document word itself and mint a rule for "Invoices".
  if (!supplier || DOC_WORDS.has(supplier.trim().toLowerCase())) return null;

  const category = CATEGORY_TABLE.find((c) => c.spoken.test(text));
  if (!category) return null;

  const vatTreatment = /\bstandard\s+vat\b|\bstandard[- ]rated\b/i.test(text)
    ? 'standard'
    : /\bzero[- ]rated\b|\bno vat\b/i.test(text)
      ? 'zero'
      : /\bexempt\b/i.test(text)
        ? 'exempt'
        : undefined;

  return {
    // Title-cased so the scopeKey matches the extractor's supplierName exactly
    // ("Bidfood", not "bidfood") — the single-tier match is case-sensitive.
    scopeKey: titleCase(supplier.trim()),
    categoryCode: category.code,
    categoryName: category.name,
    vatTreatment,
  };
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** "open the Currys receipt" → the named supplier's document, in-review first. */
function resolveNamedDocument(
  text: string,
  documents: readonly { id: string; supplier: string; status: string }[],
): string | null {
  const named = /\b(?:open|show me|pull up)\b\s+(?:the\s+)?(.+?)\s+(?:receipt|invoice|bill|document)\b/i.exec(text)?.[1];
  if (!named) return null;
  const needle = named.trim().toLowerCase();
  if (needle.length < 2) return null;
  const candidates = documents.filter((d) => d.supplier.toLowerCase().includes(needle));
  const inReview = candidates.find((d) => d.status === 'review');
  return (inReview ?? candidates[0])?.id ?? null;
}

/**
 * First match wins; order matters where vocabularies overlap ("chase … for the
 * missing receipts" must not land on the missing TABLE, and the rule utterance
 * carries neither word).
 */
export function matchDemoIntent(text: string, ctx: DemoIntentContext): DemoIntentMatch | null {
  const business = resolveBusiness(text, ctx.businesses);
  const scoped: Partial<MessagePayload> =
    business === null ? {} : { businessId: business.id, businessName: business.name };

  // 3 — "Whenever Bidfood invoices arrive…, code them Cost of Sales Food…"
  const rule = /\b(whenever|always|every time|rule)\b/i.test(text) ? parseDemoRule(text) : null;
  if (rule) {
    return { intent: 'LIVE_RULE', response: m.liveRule, payload: { ...scoped, ruleDraft: rule, query: text } };
  }

  // 2 — "Chase American Burger for the missing receipts"
  if (/\b(chase|nudge|remind|follow up with)\b/i.test(text)) {
    return { intent: 'LIVE_CHASE', response: m.liveChase, payload: { ...scoped, query: text } };
  }

  // 4 — "Publish all approved costs to Xero"
  if (/\b(publish|push)\b/i.test(text)) {
    return { intent: 'LIVE_PUBLISH', response: m.livePublish, payload: { ...scoped, query: text } };
  }

  // 1 — "Show missing paperwork for American Burger"
  if (/\b(missing|outstanding|unmatched|without paperwork|no receipt)\b/i.test(text)) {
    return { intent: 'LIVE_MISSING', response: m.liveMissing, payload: { ...scoped, query: text } };
  }

  // 5a — "Show everything to review" (navigation: the inbox, narrowed)
  if (/\b(show|open|list)\b.*\b(to|for|needs?|awaiting)\s+review\b/i.test(text)) {
    return { intent: 'SHOW_INBOX', response: m.toReview, payload: { ...scoped, statusFilter: 'review', query: text } };
  }

  // 5b — "open the Currys receipt" (navigation: one document)
  const documentId = resolveNamedDocument(text, ctx.documents);
  if (documentId !== null) {
    return { intent: 'REVIEW_DOCUMENT', response: m.openDocument, payload: { ...scoped, documentId, query: text } };
  }

  return null;
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
 * £1,299 on 9 Aug. Upload securely: <link>".
 */
export function composeChaseBody(businessName: string, items: readonly DemoChaseItem[], portalLink: string): string {
  const parts = items.map((i) => `${i.supplier} ${formatPoundsForSms(i.amount)} on ${shortDay(i.date)}`);
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
