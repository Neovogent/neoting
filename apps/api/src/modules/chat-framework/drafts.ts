import type { ScopedClient } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import type { CategoryOption } from './grounding.js';
import type { ModelTurn } from './prompts/output-schema.js';

/**
 * Turning a validated model turn into a proposal the caller can send.
 *
 * Only `rule.create` is drafted here, and the omissions are deliberate rather
 * than unfinished:
 *
 * - **`chase.send`** requires every SMS byte-for-byte *including the signed
 *   portal link*, and the contract is explicit that "composition is server-side;
 *   this payload is its output, never free-typed by a caller". The composer
 *   lives in the chase module and the signing secret is not this module's to
 *   hold. So chat returns the INTENT and the existing composer card builds the
 *   payload, exactly as it does today. Moving composition to proposal time is
 *   the known seam that also fixes the dead SMS link — it is a separate change,
 *   not a thing to half-do here.
 * - **`publish.batch`** requires a server-computed preview (count, gross, VAT)
 *   that Read review renders. The publishing module computes it. A preview
 *   assembled by a chat model would be a number a human approves without it
 *   ever having been derived from the ledger — which is the specific failure
 *   §9.4 forbids.
 *
 * What both share: the model names the *intent*, real code assembles the
 * *numbers*. That division is the whole safety property, and it is why this
 * file is short.
 */

export interface RuleDraftResult {
  readonly ok: true;
  readonly draft: {
    readonly kind: 'rule.create';
    readonly businessId: string;
    readonly payload: {
      readonly tier: 'SUPPLIER_CUSTOMER';
      readonly scopeKey: string;
      readonly sets: { categoryCode: string; vatTreatment?: string };
    };
  };
  readonly categoryName: string;
}

export interface RuleDraftRejection {
  readonly ok: false;
  /** Shown to the accountant. Names what is wrong and what would fix it. */
  readonly reason: string;
}

/**
 * Build a `rule.create` proposal request from a model turn.
 *
 * Two checks the model does not get to skip:
 *
 * 1. **The category must be on the client's own synced list.** A code that is
 *    not is refused outright — not corrected, not fuzzy-matched. Fuzzy-matching
 *    a chart of accounts is how a client's food costs quietly become drink
 *    costs, and the accountant approving it has no way to see that happened.
 * 2. **The supplier is re-cased from the client's real documents.** The
 *    single-tier match compares `scopeKey` against `extraction.supplierName`
 *    exactly, so "bidfood" typed in chat must become "Bidfood" as it appears on
 *    the invoices — otherwise the rule is created, looks right on screen, and
 *    silently never fires.
 */
export async function buildRuleDraft(
  db: ScopedClient,
  businessId: string,
  turn: ModelTurn,
  categories: readonly CategoryOption[],
): Promise<RuleDraftResult | RuleDraftRejection> {
  const rule = turn.rule;
  if (rule === undefined) {
    return { ok: false, reason: 'That did not name both a supplier and a category, so there is no rule to make yet.' };
  }

  if (categories.length === 0) {
    return {
      ok: false,
      reason: 'This client has no synced chart of accounts yet, so a coding rule has nothing to code against.',
    };
  }

  const category = categories.find((option) => option.code === rule.categoryCode);
  if (category === undefined) {
    const known = categories.map((option) => option.name).join(', ');
    return {
      ok: false,
      reason: `I could not match that category on this client's chart of accounts. The available ones are: ${known}.`,
    };
  }

  const scopeKey = await resolveSupplierCasing(db, businessId, rule.supplier);

  return {
    ok: true,
    categoryName: category.name,
    draft: {
      kind: 'rule.create',
      businessId,
      payload: {
        tier: 'SUPPLIER_CUSTOMER',
        scopeKey,
        sets: {
          categoryCode: category.code,
          ...(rule.vatTreatment === undefined ? {} : { vatTreatment: rule.vatTreatment }),
        },
      },
    },
  };
}

/**
 * The supplier name as this client's documents actually spell it.
 *
 * Falls back to title case when no document names that supplier yet — which is
 * a legitimate case (teaching a rule ahead of the first invoice) and the reason
 * this returns a value rather than refusing.
 */
async function resolveSupplierCasing(db: ScopedClient, businessId: string, spoken: string): Promise<string> {
  const match = await db.document.findFirst({
    where: { businessId, supplierName: { equals: spoken, mode: 'insensitive' } },
    select: { supplierName: true },
    orderBy: { receivedAt: 'desc' },
  });

  return match?.supplierName ?? titleCase(spoken);
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Chat reach (15 Oct 2026): three more drafts, the rule.create posture. The
// model names a document in WORDS and, for coding, a category code; this file
// resolves the id from RLS-scoped rows, checks the code against the client's
// own chart, and builds a request `POST /action-proposals` already accepts.
// Nothing here executes — a human reviews and approves the proposal.
// ---------------------------------------------------------------------------

export type ChatDraft =
  | {
      readonly kind: 'document.update-coding';
      readonly businessId: string;
      readonly payload: { documentId: string; fields: { categoryCode: string } };
    }
  | {
      readonly kind: 'document.reject';
      readonly businessId: string;
      readonly payload: { documentIds: string[]; reason: string };
    }
  | {
      readonly kind: 'bank.confirm-match';
      readonly businessId: string;
      readonly payload: { transactionId: string; documentId: string; matchKind: string; confidence: number | null };
    };

export type DraftResult = { ok: true; draft: ChatDraft; reply: string } | RuleDraftRejection;

/** Words that name a KIND of document rather than which one. */
const NOISE = /\b(the|a|an|that|this|receipt|invoice|bill|document|doc|from|for|one|latest|last|recent)\b/gi;

interface FoundDocument {
  id: string;
  supplierName: string | null;
  categoryCode: string | null;
}

/** "the Currys receipt" → this client's newest live document from Currys. */
export async function findNamedDocument(db: ScopedClient, businessId: string, query: string): Promise<FoundDocument | null> {
  const needle = query.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (needle.length < 2) return null;
  const contains = { contains: needle, mode: 'insensitive' as const };
  return db.document.findFirst({
    where: {
      businessId,
      archivedAt: null,
      ...notDeleted(),
      OR: [{ supplierName: contains }, { originalFilename: contains }, { reference: contains }],
    },
    orderBy: { receivedAt: 'desc' },
    select: { id: true, supplierName: true, categoryCode: true },
  });
}

const notFound = (query: string): RuleDraftRejection => ({
  ok: false,
  reason: `I could not find a document matching "${query}" for this client.`,
});

export async function buildCodingDraft(
  db: ScopedClient,
  businessId: string,
  turn: ModelTurn,
  categories: readonly CategoryOption[],
): Promise<DraftResult> {
  const query = turn.navigation?.documentQuery ?? '';
  const doc = await findNamedDocument(db, businessId, query);
  if (doc === null) return notFound(query);
  const supplier = doc.supplierName ?? 'named';

  const asked = turn.action?.categoryCode;
  const code = asked ?? doc.categoryCode;
  if (code === null) {
    return {
      ok: false,
      reason: `The ${supplier} document has no category yet, so there is nothing to accept. Tell me which category to code it to.`,
    };
  }
  // A changed code must be on the client's own chart — the rule.create check.
  // Accepting the code the document already carries needs no chart: it is
  // what the pipeline (or a person) already put there.
  const known = categories.find((c) => c.code === code);
  if (asked !== undefined && known === undefined) {
    const names = categories.map((c) => c.name).join(', ');
    return {
      ok: false,
      reason:
        names.length === 0
          ? 'This client has no synced chart of accounts yet, so I cannot check that category.'
          : `I could not match that category on this client's chart of accounts. The available ones are: ${names}.`,
    };
  }
  const name = known?.name ?? code;
  const accepting = asked === undefined || asked === doc.categoryCode;
  return {
    ok: true,
    draft: { kind: 'document.update-coding', businessId, payload: { documentId: doc.id, fields: { categoryCode: code } } },
    reply: accepting
      ? `Accept ${name} as the category on the ${supplier} document. It takes effect only after you review and approve it.`
      : `Change the ${supplier} document's category to ${name}. It takes effect only after you review and approve it.`,
  };
}

export async function buildRejectDraft(db: ScopedClient, businessId: string, turn: ModelTurn): Promise<DraftResult> {
  const query = turn.navigation?.documentQuery ?? '';
  const doc = await findNamedDocument(db, businessId, query);
  if (doc === null) return notFound(query);
  const reason = (turn.action?.reason ?? '').trim();
  if (reason.length === 0) {
    return { ok: false, reason: 'Tell me why it should be rejected — the reason is shown to whoever sent it.' };
  }
  return {
    ok: true,
    draft: { kind: 'document.reject', businessId, payload: { documentIds: [doc.id], reason } },
    reply: `Reject the ${doc.supplierName ?? 'named'} document with the reason "${reason}". Nothing changes until you review and approve it.`,
  };
}

export async function buildConfirmMatchDraft(db: ScopedClient, businessId: string, turn: ModelTurn): Promise<DraftResult> {
  const query = turn.navigation?.documentQuery;
  let documentId: string | undefined;
  if (query !== undefined) {
    const doc = await findNamedDocument(db, businessId, query);
    if (doc === null) return notFound(query);
    documentId = doc.id;
  }
  const match = await db.match.findFirst({
    where: { businessId, state: 'SUGGESTED', unmatchedAt: null, ...(documentId === undefined ? {} : { documentId }) },
    orderBy: { createdAt: 'desc' },
    select: {
      documentId: true,
      transactionId: true,
      kind: true,
      confidence: true,
      transaction: { select: { merchantName: true, descriptionRaw: true, bookedAt: true } },
    },
  });
  if (match === null) {
    return {
      ok: false,
      reason:
        query === undefined
          ? 'There is no suggested bank match waiting for this client.'
          : `There is no suggested bank match for the "${query}" document.`,
    };
  }
  const doc = await db.document.findUnique({ where: { id: match.documentId }, select: { supplierName: true } });
  const line = match.transaction.merchantName ?? match.transaction.descriptionRaw;
  return {
    ok: true,
    draft: {
      kind: 'bank.confirm-match',
      businessId,
      payload: {
        transactionId: match.transactionId,
        documentId: match.documentId,
        matchKind: match.kind,
        confidence: match.confidence,
      },
    },
    reply:
      `Confirm the suggested match between the ${doc?.supplierName ?? 'named'} document and the bank line ` +
      `"${line}" booked ${match.transaction.bookedAt.toISOString().slice(0, 10)}. Nothing changes until you review and approve it.`,
  };
}
