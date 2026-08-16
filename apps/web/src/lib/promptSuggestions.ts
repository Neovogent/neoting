import { defineMessages, type IntlShape } from 'react-intl';
import type { ApprovalItem, Chase, Client, Document, MissingItem } from './types';

/**
 * What to suggest typing, based on what is actually waiting.
 *
 * The old placeholder said "Type something to generate…", which asks the
 * accountant to invent the product's vocabulary from nothing — the blank-page
 * problem, on the screen they land on every morning. The five chips underneath
 * were fixed strings, so they named clients who might have nothing wrong and
 * stayed identical after the work was done.
 *
 * These are read off the same state the dashboards read: what is missing, what
 * is overdue, what is sitting in review, what failed. Ranked by what would
 * actually hurt to leave — a failed publish is money not in the ledger; a
 * chase overdue by a week is a client relationship going quiet — so the
 * first thing offered is usually the first thing worth doing.
 *
 * ## Why `intl` is a parameter, and where the `plural()` helper went
 *
 * This is not a component, so it cannot call `useIntl` — every string below is
 * a `MessageDescriptor` (`i18n/index.ts`). A `Suggestion` is a sentence the box
 * types on the user's behalf, so it has to arrive as text; `InputRow` passes
 * its own `intl` in and gets finished sentences back, the second shape §12.6
 * allows for a module with no hooks of its own.
 *
 * This file used to carry its own `plural(n, one, many = one + 's')`, which is
 * exactly the concatenation §12.6 forbids: it hard-codes English's plural rule
 * into the source, so no catalogue can correct it for a language with a dual or
 * a paucal form. Every one of its call sites is an ICU `plural` below and the
 * helper is gone.
 */

const m = defineMessages({
  textFailedPublish: {
    id: 'pipeline.promptSuggestions.textFailedPublish',
    defaultMessage: 'What failed to publish, and why?',
  },
  becauseFailedPublish: {
    id: 'pipeline.promptSuggestions.becauseFailedPublish',
    defaultMessage: '{count, plural, one {# document} other {# documents}} failed',
  },

  textStaleChases: {
    id: 'pipeline.promptSuggestions.textStaleChases',
    defaultMessage: 'Which chases have had no reply, and what should I do about {client}?',
  },
  becauseStaleChases: {
    id: 'pipeline.promptSuggestions.becauseStaleChases',
    defaultMessage: '{count, plural, one {# chase} other {# chases}} unanswered for 3 days or more',
  },

  textChaseWorstClient: {
    id: 'pipeline.promptSuggestions.textChaseWorstClient',
    defaultMessage: 'Chase {client} for the {count, plural, one {# document} other {# documents}} still missing',
  },
  becauseChaseWorstClient: {
    id: 'pipeline.promptSuggestions.becauseChaseWorstClient',
    defaultMessage: '{client} is short {count, plural, one {# document} other {# documents}}',
  },

  textAllMissing: {
    id: 'pipeline.promptSuggestions.textAllMissing',
    defaultMessage: 'Show everything missing across all clients',
  },
  becauseAllMissing: {
    id: 'pipeline.promptSuggestions.becauseAllMissing',
    defaultMessage: '{count, plural, one {# item} other {# items}} outstanding in total',
  },

  textAgingApprovals: {
    id: 'pipeline.promptSuggestions.textAgingApprovals',
    defaultMessage: 'What is waiting on my approval, oldest first?',
  },
  becauseAgingApprovals: {
    id: 'pipeline.promptSuggestions.becauseAgingApprovals',
    defaultMessage: '{count, plural, one {# approval} other {# approvals}} waiting 5 days or more',
  },

  textPendingApprovals: {
    id: 'pipeline.promptSuggestions.textPendingApprovals',
    defaultMessage: 'Anything need approving?',
  },
  becausePendingApprovals: {
    id: 'pipeline.promptSuggestions.becausePendingApprovals',
    defaultMessage: 'items are pending approval',
  },

  textUncategorised: {
    id: 'pipeline.promptSuggestions.textUncategorised',
    defaultMessage: 'Which documents are missing a category?',
  },
  becauseUncategorised: {
    id: 'pipeline.promptSuggestions.becauseUncategorised',
    defaultMessage: '{count, plural, one {# document} other {# documents}} with no category',
  },
  textReviewQueue: {
    id: 'pipeline.promptSuggestions.textReviewQueue',
    defaultMessage: 'Show me everything waiting to be reviewed',
  },
  becauseReviewQueue: {
    id: 'pipeline.promptSuggestions.becauseReviewQueue',
    defaultMessage: '{count, plural, one {# document} other {# documents}} to review',
  },

  textReadyToPublish: {
    id: 'pipeline.promptSuggestions.textReadyToPublish',
    defaultMessage: 'Publish everything that is ready',
  },
  becauseReadyToPublish: {
    id: 'pipeline.promptSuggestions.becauseReadyToPublish',
    defaultMessage: '{count, plural, one {# document} other {# documents}} ready · £{value}',
  },

  textSupplierRule: {
    id: 'pipeline.promptSuggestions.textSupplierRule',
    defaultMessage: 'Whenever {supplier} invoices arrive, code them the same way every time',
  },
  becauseSupplierRule: {
    id: 'pipeline.promptSuggestions.becauseSupplierRule',
    defaultMessage: '{supplier} has sent {count, plural, one {# document} other {# documents}}',
  },

  textMonthOverview: {
    id: 'pipeline.promptSuggestions.textMonthOverview',
    defaultMessage: 'How is the month looking?',
  },
  becauseMonthOverview: {
    id: 'pipeline.promptSuggestions.becauseMonthOverview',
    defaultMessage: 'nothing urgent is outstanding',
  },

  textClientSummary: {
    id: 'pipeline.promptSuggestions.textClientSummary',
    defaultMessage: 'Give me a summary for {client}',
  },
  becauseClientSummary: {
    id: 'pipeline.promptSuggestions.becauseClientSummary',
    defaultMessage: 'a client overview',
  },
});

export interface Suggestion {
  /** The sentence typed into the box. */
  text: string;
  /** Why it is being offered, for the line under the box. */
  because: string;
  /** Higher is more urgent. Ties keep source order. */
  weight: number;
}

export interface SuggestionInput {
  clients: Client[];
  documents: Document[];
  missing: MissingItem[];
  chases: Chase[];
  approvals: ApprovalItem[];
}

/** The client with the most of something, for naming a specific company. */
function worst<T>(items: T[], keyOf: (item: T) => string): { key: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: { key: string; count: number } | null = null;
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
  return best;
}

export function suggestPrompts(
  intl: IntlShape,
  { clients, documents, missing, chases, approvals }: SuggestionInput,
): Suggestion[] {
  const out: Suggestion[] = [];

  // Failed publishes: the ledger is wrong until these clear.
  const failed = documents.filter((d) => d.status === 'rejected');
  if (failed.length) {
    out.push({
      text: intl.formatMessage(m.textFailedPublish),
      because: intl.formatMessage(m.becauseFailedPublish, { count: failed.length }),
      weight: 100,
    });
  }

  // Chases nobody has answered, oldest first — this is the relationship risk.
  const stale = chases.filter((c) => c.stage !== 'closed' && c.hoursSinceSent >= 72);
  // A non-empty list always has a first element after sorting, so gating on the
  // oldest chase is the same condition as gating on `stale.length`.
  const oldest = [...stale].sort((a, b) => b.hoursSinceSent - a.hoursSinceSent)[0];
  if (oldest) {
    out.push({
      text: intl.formatMessage(m.textStaleChases, { client: oldest.clientName }),
      because: intl.formatMessage(m.becauseStaleChases, { count: stale.length }),
      weight: 90,
    });
  }

  // Missing documents, named at the client who has the most of them.
  if (missing.length) {
    const top = worst(missing, (mi) => mi.clientName);
    if (top) {
      out.push({
        text: intl.formatMessage(m.textChaseWorstClient, { client: top.key, count: top.count }),
        because: intl.formatMessage(m.becauseChaseWorstClient, { client: top.key, count: top.count }),
        weight: 80,
      });
    }
    out.push({
      text: intl.formatMessage(m.textAllMissing),
      because: intl.formatMessage(m.becauseAllMissing, { count: missing.length }),
      weight: 55,
    });
  }

  // Approvals aging: someone is waiting on a signature.
  const aging = approvals.filter((a) => a.state === 'pending' && a.waitingDays >= 5);
  if (aging.length) {
    out.push({
      text: intl.formatMessage(m.textAgingApprovals),
      because: intl.formatMessage(m.becauseAgingApprovals, { count: aging.length }),
      weight: 85,
    });
  } else if (approvals.some((a) => a.state === 'pending')) {
    out.push({
      text: intl.formatMessage(m.textPendingApprovals),
      because: intl.formatMessage(m.becausePendingApprovals),
      weight: 45,
    });
  }

  // The review queue, where a document cannot move without a human.
  const review = documents.filter((d) => d.status === 'review');
  if (review.length) {
    const blocked = review.filter((d) => d.category === '—' || !d.category).length;
    out.push({
      text: blocked ? intl.formatMessage(m.textUncategorised) : intl.formatMessage(m.textReviewQueue),
      because: blocked
        ? intl.formatMessage(m.becauseUncategorised, { count: blocked })
        : intl.formatMessage(m.becauseReviewQueue, { count: review.length }),
      weight: 70,
    });
  }

  // Ready to publish: the satisfying one, and genuinely the next action.
  const ready = documents.filter((d) => d.status === 'ready');
  if (ready.length) {
    const value = ready.reduce((sum, d) => sum + d.total, 0);
    out.push({
      text: intl.formatMessage(m.textReadyToPublish),
      because: intl.formatMessage(m.becauseReadyToPublish, {
        count: ready.length,
        value: value.toLocaleString('en-GB', { minimumFractionDigits: 2 }),
      }),
      weight: 60,
    });
  }

  // A rule, which is the feature people forget exists.
  const supplier = worst(
    documents.filter((d) => d.kind === 'cost' && d.supplier && d.supplier !== 'Unknown'),
    (d) => d.supplier,
  );
  if (supplier && supplier.count > 1) {
    out.push({
      text: intl.formatMessage(m.textSupplierRule, { supplier: supplier.key }),
      because: intl.formatMessage(m.becauseSupplierRule, { supplier: supplier.key, count: supplier.count }),
      weight: 40,
    });
  }

  // Always something to say, even on a clean morning.
  if (out.length < 3) {
    const name = clients[0]?.name;
    out.push({
      text: intl.formatMessage(m.textMonthOverview),
      because: intl.formatMessage(m.becauseMonthOverview),
      weight: 10,
    });
    if (name) {
      out.push({
        text: intl.formatMessage(m.textClientSummary, { client: name }),
        because: intl.formatMessage(m.becauseClientSummary),
        weight: 5,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
}
