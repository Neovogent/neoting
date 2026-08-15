import type { ApprovalBranch, ApprovalStage, ApprovalWorkflow } from './types';

/**
 * Turns a description of an approval policy into a structured workflow, the
 * same way `ruleParser` turns a sentence into a coding rule.
 *
 * Deliberately deterministic and local rather than a model call: it runs
 * offline, gives the same answer twice, and — because every field it fills
 * stays editable — a wrong guess costs a correction rather than a bad policy.
 * What it cannot find, it leaves for the person to fill in.
 *
 * Nothing here activates anything. The result is a draft in the editor, and
 * the workflow still has to be saved.
 */

/** Roles an accountant actually names, longest first so "Finance Director" wins over "Director". */
const APPROVERS = [
  'Finance Director',
  'Managing Director',
  'Practice Partner',
  'Partner',
  'Compliance',
  'Bookkeeper',
  'Manager',
  'Director',
  'Owner',
  'Accountant',
  'Client',
];

/** Named people already in the practice, so "Sam approves" resolves to a person. */
const PEOPLE = ['R. Okafor', 'S. Patel', 'J. Whitfield', 'L. Nguyen', 'You'];

const CATEGORY_HINTS = [
  'Computer Equipment', 'Kitchen Equipment', 'Cost of Sales Food', 'Cost of Sales Drink',
  'Office Supplies', 'Software', 'Travel', 'Subsistence', 'Marketing', 'Professional Fees',
  'Utilities', 'Repairs & Maintenance',
];

const WORD_AMOUNTS: Record<string, number> = {
  hundred: 100,
  'five hundred': 500,
  thousand: 1000,
  'a thousand': 1000,
  'two thousand': 2000,
  'five thousand': 5000,
  'ten thousand': 10000,
};

export interface ParsedWorkflow {
  workflow: ApprovalWorkflow;
  /** What was actually understood, shown so the guess can be checked. */
  understood: string[];
  /** What the description did not say, and therefore had to be defaulted. */
  assumed: string[];
}

export function parseWorkflow(text: string, base: ApprovalWorkflow): ParsedWorkflow {
  const understood: string[] = [];
  const assumed: string[] = [];
  const lower = text.toLowerCase();

  /* ── what it applies to ─────────────────────────────────────────────────── */
  const categories = CATEGORY_HINTS.filter((c) => lower.includes(c.toLowerCase()));
  let appliesTo: string;
  if (categories.length) {
    appliesTo = `Category: ${categories.join(', ')}`;
    understood.push(`Applies to ${categories.join(' and ')}`);
  } else if (/\bsales\b|\binvoices? (?:we )?(?:raise|issue)\b|\bcustomer invoices?\b/.test(lower)) {
    appliesTo = 'All sales items';
    understood.push('Applies to sales items');
  } else if (/\bexpense claims?\b/.test(lower)) {
    appliesTo = 'All expense claims';
    understood.push('Applies to expense claims');
  } else {
    appliesTo = 'All cost items';
    assumed.push('Assumed it applies to all cost items');
  }

  /* ── the money thresholds ───────────────────────────────────────────────── */
  const amounts = findAmounts(lower);
  if (amounts.length) {
    understood.push(
      `Threshold${amounts.length > 1 ? 's' : ''} at ${amounts.map((a) => money(a.value)).join(' and ')}`,
    );
  }

  /* ── stages ─────────────────────────────────────────────────────────────── */
  const named = findApprovers(text);
  const stages: ApprovalStage[] = [];

  if (named.length === 0) {
    stages.push({ name: 'Manager review', approver: 'Manager', canEdit: true });
    assumed.push('No approver named — started with a manager review');
  } else {
    /**
     * Each amount belongs to the approver named closest to it. "Over £500 a
     * manager, over £2,000 the Finance Director too" and "the Finance Director,
     * then the client signs off over £1,000" put the figure on opposite sides
     * of the approver, so position beats order.
     */
    const thresholds = new Map<string, number>();
    for (const amount of amounts) {
      // Nearest approver wins, but one already carrying a threshold is passed
      // over rather than swallowing the figure — otherwise a second amount
      // sitting closer to an approver that is already spoken for is lost.
      const claimant = named
        .map((who) => ({ who, gap: Math.abs(positionOf(text, who) - amount.at) }))
        .sort((a, b) => a.gap - b.gap)
        .find((c) => !thresholds.has(c.who));
      if (claimant) thresholds.set(claimant.who, amount.value);
    }

    named.forEach((approver, i) => {
      const clientSide = isClientSide(approver);
      stages.push({
        name: clientSide ? 'Client sign-off' : `${approver} approval`,
        approver: clientSide ? 'Business owner' : approver,
        // The first approver usually corrects coding; later ones sign off. A
        // client-side approver never edits — they see the coding, not a form.
        canEdit: i === 0 && !clientSide,
        thresholdAbove: thresholds.get(approver),
        ...(clientSide ? { clientSide: true } : {}),
      });
    });
    understood.push(`${named.length} stage${named.length === 1 ? '' : 's'}: ${named.join(' → ')}`);
    if (stages.some((s) => s.clientSide)) {
      understood.push('The last word is the business owner’s, over SMS');
    }
  }

  /* ── conditional branches ───────────────────────────────────────────────── */
  /**
   * Only genuinely conditional language becomes a branch. Value thresholds
   * already live on the stages above, so turning them into branches as well
   * would double the policy and pull in an approver twice.
   */
  const branches: ApprovalBranch[] = [];

  if (/\bnew supplier\b|\bfirst time\b|\bunknown supplier\b|\bnever (?:used|seen)\b/.test(lower)) {
    branches.push({
      field: 'supplier-age',
      operator: 'is',
      value: 'new',
      addApprover: 'Compliance',
      label: 'A brand-new supplier adds Compliance',
    });
    understood.push('A new supplier pulls in Compliance');
  }

  // "…over £5,000 also needs the partner" — an approver added on a condition
  // rather than a stage everything passes through.
  const added = text.match(
    /(?:over|above|more than)\s*£?\s*([\d,]+)\s*(k\b)?[^.]{0,40}?\b(?:also (?:needs|requires)|adds?|brings? in|pulls? in)\s+(?:the\s+)?([a-z ]{3,24}?)\b/i,
  );
  // The figure and the approver are both required groups — only the "k" suffix
  // is optional — so a match that reaches here carries them.
  if (added?.[1] && added[3]) {
    let amount = Number(added[1].replace(/,/g, ''));
    if (added[2]) amount *= 1000;
    const who = titleCase(added[3].trim());
    branches.push({
      field: 'amount',
      operator: '>',
      value: String(amount),
      addApprover: who,
      label: `Amount over ${money(amount)} adds ${who}`,
    });
    understood.push(`Over ${money(amount)} also pulls in ${who}`);
  }

  /* ── the two policy switches ────────────────────────────────────────────── */
  const selfApproval = /\bself[- ]approv/.test(lower) && !/\bno self[- ]approv|\bcannot self[- ]approv|\bnot self[- ]approv/.test(lower);
  const autoPublish = /\bauto[- ]?publish|\bpublish (?:it |them )?(?:automatically|straight away|once approved)/.test(lower);

  if (autoPublish) understood.push('Publishes automatically once fully approved');
  if (selfApproval) understood.push('Self-approval allowed');
  if (!autoPublish) assumed.push('Auto-publish left off');

  /* ── name ───────────────────────────────────────────────────────────────── */
  const quoted = text.match(/"([^"]{2,40})"|call it ([a-z0-9 &-]{2,40})/i);
  // The two are alternatives, so a match fills exactly one of them.
  const given = quoted?.[1] ?? quoted?.[2];
  const [smallest] = amounts;
  const name = given
    ? given.trim()
    : categories.length
    ? `${categories[0]} approvals`
    : appliesTo === 'All sales items'
    ? 'Sales approvals'
    : smallest
    ? `Over ${money(smallest.value)}`
    : 'Approval workflow';
  if (!quoted) assumed.push(`Named it "${name}"`);

  return {
    workflow: {
      ...base,
      name,
      appliesTo,
      // A category-scoped workflow beats a catch-all when both could apply.
      specificity: categories.length ? 3 : appliesTo === 'All cost items' ? 1 : 2,
      stages,
      branches,
      selfApproval,
      autoPublishOnApproval: autoPublish,
      active: true,
    },
    understood,
    assumed,
  };
}

/** Every money figure, with where it was said — position is what pairs it to an approver. */
function findAmounts(lower: string): { value: number; at: number }[] {
  const found: { value: number; at: number }[] = [];
  const seen = new Set<number>();

  const add = (value: number, at: number) => {
    if (value > 0 && !seen.has(value)) {
      seen.add(value);
      found.push({ value, at });
    }
  };

  for (const m of lower.matchAll(/£\s*([\d,]+(?:\.\d+)?)\s*(k\b)?|(?:over|above|more than|exceeds?|greater than)\s*£?\s*([\d,]+(?:\.\d+)?)\s*(k\b)?/g)) {
    const raw = m[1] ?? m[3];
    if (!raw) continue;
    let n = Number(raw.replace(/,/g, ''));
    if (m[2] === 'k' || m[4] === 'k') n *= 1000;
    add(n, m.index ?? 0);
  }

  for (const [word, value] of Object.entries(WORD_AMOUNTS)) {
    const m = lower.match(new RegExp(`(?:over|above|more than)\\s+${word}\\b`));
    if (m) add(value, m.index ?? 0);
  }

  return found.sort((a, b) => a.value - b.value);
}

/** Where an approver was named, for pairing amounts to stages. */
const positionOf = (text: string, who: string) => text.toLowerCase().indexOf(who.toLowerCase());

/**
 * Approvers in the order they are mentioned.
 *
 * Longest match wins and claims its span, so "Finance Director" is one
 * approver rather than also matching "Director" eight characters in — which
 * would otherwise invent a second stage out of the same two words.
 */
function findApprovers(text: string): string[] {
  const lower = text.toLowerCase();
  const claimed: [number, number][] = [];
  const hits: { at: number; who: string }[] = [];

  const overlaps = (from: number, to: number) => claimed.some(([a, b]) => from < b && to > a);

  // People first, then roles longest-first — both already ordered that way.
  for (const who of [...PEOPLE, ...APPROVERS]) {
    let from = lower.indexOf(who.toLowerCase());
    while (from >= 0) {
      const to = from + who.length;
      if (!overlaps(from, to)) {
        claimed.push([from, to]);
        hits.push({ at: from, who });
      }
      from = lower.indexOf(who.toLowerCase(), from + 1);
    }
  }

  return hits
    .sort((a, b) => a.at - b.at)
    .map((h) => h.who)
    .filter((who, i, all) => all.indexOf(who) === i);
}

/**
 * Only the business's own people sign off client-side. This is a fixed list
 * rather than a proximity guess: an earlier version looked for "client" near
 * the approver and turned every stage in the sentence client-side, because the
 * word usually appears once and applies to one of them.
 */
const CLIENT_SIDE = ['client', 'owner'];
const isClientSide = (approver: string) => CLIENT_SIDE.includes(approver.toLowerCase());

const money = (n: number) => `£${n.toLocaleString('en-GB')}`;

function titleCase(s: string) {
  return s
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Example prompts, so the field is never a blank box. */
export const WORKFLOW_EXAMPLES = [
  'Anything over £500 needs a manager, and over £2,000 the Finance Director too. Auto-publish once approved.',
  'Computer Equipment and Kitchen Equipment go to the Finance Director, then the client signs off over £1,000.',
  'All sales items just need a manager review. Allow self-approval.',
  'A brand-new supplier always adds Compliance, whatever the amount.',
];
