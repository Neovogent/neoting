import { defineMessages, type MessageDescriptor } from 'react-intl';
import type { Client, Intent } from './types';

/**
 * What the assistant says back, per intent.
 *
 * This is module scope, where no hook can run, so the table below holds
 * `MessageDescriptor`s and the chat box formats the one that matched — the
 * pattern in `i18n/index.ts`. Only the reply is a message: the `Intent` beside
 * it is an enum value the whole app switches on, and the `test` is a matcher
 * against what the user typed. Translating either would change behaviour rather
 * than wording.
 */
const m = defineMessages({
  addClient: {
    id: 'pipeline.resolver.addClient',
    defaultMessage: "I'll set that client up. Complete the intake form below and I'll take it through review before anything is created.",
  },
  chaseMissing: {
    id: 'pipeline.resolver.chaseMissing',
    defaultMessage: "I've drafted the chase. Nothing sends until you read the review and approve it.",
  },
  showMissing: {
    id: 'pipeline.resolver.showMissing',
    defaultMessage: "I've scanned bank feeds, supplier statements and recurring patterns. Here's what's missing:",
  },
  showDuplicates: {
    id: 'pipeline.resolver.showDuplicates',
    defaultMessage: 'Here are the flagged duplicate pairs with their similarity signals.',
  },
  showMatches: {
    id: 'pipeline.resolver.showMatches',
    defaultMessage: 'Here are the current document ↔ transaction links, with match confidence on each.',
  },
  showRejected: {
    id: 'pipeline.resolver.showRejected',
    defaultMessage: 'Every failure lands here with a reason and a retry — nothing vanishes silently.',
  },
  showApprovals: {
    id: 'pipeline.resolver.showApprovals',
    defaultMessage: 'Here is the approval queue, oldest first.',
  },
  approveItems: {
    id: 'pipeline.resolver.approveItems',
    defaultMessage: "I've prepared the approval batch. Read the review to see exactly what will be approved.",
  },
  createRule: {
    id: 'pipeline.resolver.createRule',
    defaultMessage: "I've parsed that into a rule. It activates only after you review and approve it.",
  },
  publish: {
    id: 'pipeline.resolver.publish',
    defaultMessage: "Here's the publish batch with gross and VAT totals. Read the review before approving.",
  },
  inviteUser: {
    id: 'pipeline.resolver.inviteUser',
    defaultMessage: 'Fill in the invite below — it goes through review before the invitation is sent.',
  },
  showAudit: {
    id: 'pipeline.resolver.showAudit',
    defaultMessage: 'Every approval is recorded with who, when, and what was shown at the time.',
  },
  showAnalytics: {
    id: 'pipeline.resolver.showAnalytics',
    defaultMessage: 'Here are the document-pipeline metrics. (Ledger reporting is out of scope for this product.)',
  },
  reviewDocument: {
    id: 'pipeline.resolver.reviewDocument',
    defaultMessage: 'Here it is. Every field shows its confidence and provenance — click any value to correct it.',
  },
  showInbox: {
    id: 'pipeline.resolver.showInbox',
    defaultMessage: 'Here is the inbox. Sort or bulk-select any of these.',
  },
  general: {
    id: 'pipeline.resolver.general',
    defaultMessage:
      'I run the document pipeline: ingest, extract, rules, review, dedupe, bank match, chase, approve, publish. Ask me to show missing documents, chase a client, set up a rule, or publish a batch.',
  },
});

/**
 * Local intent classifier. The server (Gemini) is the primary path; this runs
 * whenever the API is unreachable or unconfigured so the workspace stays usable.
 */
const PATTERNS: { intent: Intent; test: RegExp; response: MessageDescriptor }[] = [
  {
    intent: 'ADD_CLIENT',
    test: /\b(add|create|onboard|set ?up)\b.*\b(client|company|business)\b|\badd\b.*\bas a client\b/i,
    response: m.addClient,
  },
  {
    intent: 'CHASE_MISSING',
    test: /\b(chase|remind|nudge|follow up)\b/i,
    response: m.chaseMissing,
  },
  {
    intent: 'SHOW_MISSING',
    test: /\b(missing|outstanding|unverified|no receipt|without paperwork)\b/i,
    response: m.showMissing,
  },
  {
    intent: 'SHOW_DUPLICATES',
    test: /\b(duplicate|dupe|same invoice|twice)\b/i,
    response: m.showDuplicates,
  },
  {
    intent: 'SHOW_MATCHES',
    test: /\b(match|matched|reconcil|bank match)\b/i,
    response: m.showMatches,
  },
  {
    intent: 'SHOW_REJECTED',
    test: /\b(rejected|failed|failure|error|bounce)\b/i,
    response: m.showRejected,
  },
  {
    intent: 'SHOW_APPROVALS',
    test: /\b(approval|approvals|awaiting approval|pending approval|need approving|approve queue)\b/i,
    response: m.showApprovals,
  },
  {
    intent: 'APPROVE_ITEMS',
    test: /\b(approve)\b.*\b(items|claims|costs|invoices|bills|all|pending|under)\b/i,
    response: m.approveItems,
  },
  {
    intent: 'CREATE_RULE',
    test: /\b(rule|whenever|always code|code (it|them)|auto-?publish)\b/i,
    response: m.createRule,
  },
  {
    intent: 'PUBLISH',
    test: /\b(publish|push|send to (xero|quickbooks|qbo|sage|freeagent))\b/i,
    response: m.publish,
  },
  {
    intent: 'INVITE_USER',
    test: /\b(invite|add)\b.*\b(user|colleague|team member|staff|approver)\b/i,
    response: m.inviteUser,
  },
  {
    intent: 'SHOW_AUDIT',
    test: /\b(audit|audit log|who approved|history of changes|trail)\b/i,
    response: m.showAudit,
  },
  {
    intent: 'SHOW_ANALYTICS',
    test: /\b(analytics|stats|metrics|how many|report|throughput|performance)\b/i,
    response: m.showAnalytics,
  },
  {
    intent: 'REVIEW_DOCUMENT',
    test: /\b(review|open|show me|check|look at)\b.*\b(document|receipt|invoice|bill)\b|\bextraction\b/i,
    response: m.reviewDocument,
  },
  {
    intent: 'SHOW_INBOX',
    test: /\b(inbox|to review|ready|processing|costs|sales|documents)\b/i,
    response: m.showInbox,
  },
];

export function classifyLocally(text: string): { intent: Intent; response: MessageDescriptor } {
  for (const p of PATTERNS) {
    if (p.test.test(text)) return { intent: p.intent, response: p.response };
  }
  return { intent: 'GENERAL', response: m.general };
}

/**
 * Works out which clients a message is about: explicit mentions first,
 * otherwise whatever is attached to the conversation.
 */
export function resolveScope(text: string, clients: Client[], attachedClientIds: string[]) {
  const lower = text.toLowerCase();
  const mentioned = clients.filter((c) => {
    // Splitting always yields a first element; on a nameless client it is the
    // empty string, which the length check below rejects anyway.
    const first = (c.name.split(' ')[0] ?? '').toLowerCase();
    return lower.includes(c.name.toLowerCase()) || (first.length > 3 && lower.includes(first));
  });

  const ids = mentioned.length ? mentioned.map((c) => c.id) : attachedClientIds;
  const scoped = clients.filter((c) => ids.includes(c.id));

  return {
    clientIds: scoped.map((c) => c.id),
    clientNames: scoped.map((c) => c.name),
    period: extractPeriod(text),
    query: text,
  };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function extractPeriod(text: string): string | undefined {
  const lower = text.toLowerCase();
  const month = MONTHS.find((m) => lower.includes(m));
  // charAt over indexing: every name in MONTHS is a non-empty literal, so this
  // is the same first character without a possibly-undefined read.
  if (month) return month.charAt(0).toUpperCase() + month.slice(1);
  if (/\bthis month\b/.test(lower)) return 'This month';
  if (/\blast month\b/.test(lower)) return 'Last month';
  return undefined;
}

/** Pulls a prospective client name out of an "add X as a client" utterance. */
export function extractClientName(text: string): string {
  const patterns = [
    /\badd\s+(.+?)\s+as\s+a\s+(?:new\s+)?client\b/i,
    /\b(?:add|create|onboard|set ?up)\s+(?:a\s+)?(?:new\s+)?client\s+(?:called\s+|named\s+)?(.+?)(?:\s*[.,]|$)/i,
    /\bonboard\s+(.+?)(?:\s*[.,]|$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const name = m[1].trim().replace(/^(the|a)\s+/i, '');
      if (name.length > 1 && name.length < 60) return titleCaseName(name);
    }
  }
  return '';
}

function titleCaseName(s: string) {
  return s
    .split(/\s+/)
    // The caller trims before splitting, so no word is empty; charAt keeps that
    // honest without asserting on the index.
    .map((w) => (/^(ltd|llp|plc|uk)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Derives a conversation title from its first user message. */
export function titleFromMessage(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= 34) return clean;
  return clean.slice(0, 34).trimEnd() + '…';
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

export const currency = (n: number) =>
  `${n < 0 ? '−' : ''}£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
