import type { Rule, RuleCondition } from './types';

const KNOWN_SUPPLIERS = [
  'Adobe', 'Amazon', 'Bidfood', 'Uber', 'Uber Eats', 'Google Ads', 'Google', 'Currys', 'Costco',
  'Brakes', 'Booker', 'Sysco', 'AWS', 'Hilti', 'Square', 'Just Eat', 'Deliveroo', 'Apple', 'Microsoft',
];

const CATEGORY_HINTS = [
  'Cost of Sales Food', 'Cost of Sales', 'Office Supplies', 'Computer Equipment', 'Software',
  'Travel', 'Subsistence', 'Marketing', 'Advertising', 'Professional Fees', 'Repairs & Maintenance',
  'Utilities', 'Rent', 'Insurance', 'Telephone & Internet',
];

const WORD_AMOUNTS: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  'a thousand': 1000,
  'two thousand': 2000,
  'five hundred': 500,
};

/**
 * Parses a natural-language rule utterance into a structured rule (PRD stage 3).
 * Nothing here activates anything — the result is rendered as a rule card and
 * only takes effect after Review -> Approve.
 */
export function parseRule(text: string, clientId: string, clientName: string, existing: Rule[]): Rule {
  const supplier = findSupplier(text) ?? 'Unknown supplier';
  const conditions = findConditions(text);
  const sets = findSets(text);

  const conflict = existing.find(
    (r) => r.supplier.toLowerCase() === supplier.toLowerCase() && (r.clientId === clientId || r.clientId === 'all'),
  );

  return {
    id: `rule-${Date.now()}`,
    clientId,
    clientName,
    supplier,
    tier: 'supplier',
    conditions,
    sets: sets.length ? sets : [{ field: 'Category', value: 'Needs a category' }],
    active: false,
    retroApply: false,
    conflictsWith: conflict ? describe(conflict) : undefined,
  };
}

function findSupplier(text: string): string | null {
  const lower = text.toLowerCase();
  const known = KNOWN_SUPPLIERS.find((s) => lower.includes(s.toLowerCase()));
  if (known) return known;

  // "whenever <X> arrives" / "anything from <X>" / "<X> invoices"
  const patterns = [
    /whenever\s+([a-z0-9&' -]{2,24}?)\s+(?:arrives|invoices|bills|comes)/i,
    /(?:anything|everything)\s+from\s+([a-z0-9&' -]{2,24}?)(?:\s+over|\s+above|\s*,|\s*$)/i,
    /\bfrom\s+([A-Z][a-zA-Z0-9&']+(?:\s+[A-Z][a-zA-Z0-9&']+)?)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return titleCase(m[1].trim());
  }
  return null;
}

function findConditions(text: string): RuleCondition[] {
  const conditions: RuleCondition[] = [];
  const lower = text.toLowerCase();

  // The figure is the one capture group and is not optional, so a match carries it.
  const numeric = lower.match(/(?:over|above|more than|greater than|>)\s*£?\s*([\d,]+(?:\.\d+)?)/)?.[1];
  if (numeric) {
    conditions.push({ field: 'Total', operator: '>', value: `£${Number(numeric.replace(/,/g, '')).toLocaleString('en-GB')}` });
  } else {
    // Entries rather than keys so the amount comes back with the word it matched.
    const worded = Object.entries(WORD_AMOUNTS).find(([w]) => lower.includes(`over ${w}`) || lower.includes(`above ${w}`));
    if (worded) {
      conditions.push({ field: 'Total', operator: '>', value: `£${worded[1].toLocaleString('en-GB')}` });
    }
  }

  const under = lower.match(/(?:under|below|less than|<)\s*£?\s*([\d,]+(?:\.\d+)?)/)?.[1];
  if (under) {
    conditions.push({ field: 'Total', operator: '<', value: `£${Number(under.replace(/,/g, '')).toLocaleString('en-GB')}` });
  }

  if (/\bcredit note\b/i.test(text)) conditions.push({ field: 'Document type', operator: 'is', value: 'Credit note' });

  return conditions;
}

function findSets(text: string): { field: string; value: string }[] {
  const sets: { field: string; value: string }[] = [];
  const lower = text.toLowerCase();

  const category = CATEGORY_HINTS.find((c) => lower.includes(c.toLowerCase()));
  if (category) {
    sets.push({ field: 'Category', value: category });
  } else {
    const m = text.match(/(?:code (?:it|them)|goes to|categorise as|categorize as|post to)\s+([a-z0-9 &-]{3,32})/i);
    if (m?.[1]) sets.push({ field: 'Category', value: titleCase(m[1].trim().replace(/\s+(with|and|,).*$/i, '')) });
  }

  const vat = lower.match(/(\d{1,2})\s*%\s*(?:vat|tax)?/);
  if (vat) sets.push({ field: 'Tax rate', value: `${vat[1]}% standard` });
  else if (/\b(zero[- ]rated|no vat|exempt)\b/i.test(text)) sets.push({ field: 'Tax rate', value: 'Zero-rated' });

  if (/auto[- ]?publish/i.test(text)) sets.push({ field: 'Auto-publish', value: 'On (approvals still override)' });
  if (/\bflag(?:ged)?\b/i.test(text)) {
    const m = text.match(/flag(?:ged)?\s+(?:for\s+)?([a-z0-9 -]{3,28})/i);
    sets.push({ field: 'Flag', value: m?.[1] ? titleCase(m[1].trim()) : 'Review' });
  }
  if (/\bpayment method\b/i.test(text)) {
    const m = text.match(/payment method (?:to |as )?([a-z0-9 ]{3,20})/i);
    if (m?.[1]) sets.push({ field: 'Payment method', value: titleCase(m[1].trim()) });
  }

  return sets;
}

export function describe(rule: Rule): string {
  const conds = rule.conditions.length
    ? ` where ${rule.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`).join(' and ')}`
    : '';
  return `${rule.supplier}${conds} → ${rule.sets.map((s) => `${s.field}: ${s.value}`).join(', ')}`;
}

/** The four-tier priority Dext uses and accountants already reason in. */
export const TIER_ORDER: { tier: Rule['tier']; label: string }[] = [
  { tier: 'user', label: '1 · User rules' },
  { tier: 'payment-method', label: '2 · Payment-method rules' },
  { tier: 'supplier', label: '3 · Supplier / customer rules' },
  { tier: 'defaults', label: '4 · Account defaults' },
];

function titleCase(s: string) {
  return s
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
