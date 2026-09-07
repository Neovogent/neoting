import type { ProposalKind } from '@neoting/contracts/model';

/**
 * **What a proposal is ABOUT** — the records it acts on, reduced to a stable
 * string. Review item 26, 6 Sep 2026.
 *
 * > *For same document, multiple review request has come in the approval tab…
 * > make sure no duplicate approval request is sent*
 *
 * Mubashir's queue held **eight identical "Release for export" cards over one
 * Ready document**, all pending, all from the same person. Nothing stopped it:
 * every click of [Stage for review] minted a fresh proposal, and the broken
 * scroll of item 23 meant Approve was unreachable, so he closed and re-staged
 * until it was. The fix is server-side and it is here.
 *
 * ## Why not just hash the payload
 *
 * Because the payload a caller SENDS is not the payload that gets stored. The
 * engine recomputes three of them at creation, deliberately and for good
 * reasons written elsewhere: `publish.batch` gets the server's own entry
 * preview and totals, `chase.send` gets each message body composed server-side
 * with a signed portal link over a freshly minted chase id, and
 * `bank.remove-statement` gets a blast radius read off the provenance-stamped
 * rows. Two identical clicks a minute apart therefore produce two DIFFERENT
 * `payload_hash` values whenever any of those live facts has moved — a figure
 * reconciled, a chase id allocated — and hashing would silently stop deduping
 * exactly the kinds it exists for.
 *
 * What survives the rewrite intact is the **record ids**. So identity is
 * extracted from those, and it is read off the STORED payload, which means no
 * new column, no migration and no index: the candidate set is the handful of
 * pending proposals already narrowed by kind and business.
 *
 * ## Why a total record rather than "handle publish.batch and move on"
 *
 * `RELEASE_KINDS` and `ExecutorRegistry` are total over `ProposalKind` for one
 * reason and this shares it: a kind added to the spec must ANSWER the question
 * rather than inherit a default. The default here would be "never a duplicate",
 * and the bug would come back on whatever surface ships next — which is exactly
 * how it arrived on this one.
 *
 * ⚠ **`null` means "this kind has no stable identity, do not dedupe it"**, and
 * it is a real answer rather than a gap. It is returned for a payload that does
 * not parse to the shape this file expects — the stored row is re-parsed
 * against the contract at review and approve, not here, and a dedupe check is
 * the wrong place to start refusing rows.
 */

/** A payload as it sits in `action_proposals.payload` — jsonb, so nothing is trusted. */
type StoredPayload = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Sorted, so a caller reordering a selection is still the same batch. */
function ids(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === 'string' && v !== '');
  if (list.length === 0 || list.length !== value.length) return null;
  return [...list].sort().join(',');
}

/**
 * One extractor per kind, total by the mapped type.
 *
 * Each returns the ids the action acts on — never a figure, never a free-text
 * field, never a flag. Two proposals with the same identity are two attempts at
 * the same act; two with different identities are two acts, whatever else they
 * share.
 */
const IDENTITY: Readonly<Record<ProposalKind, (payload: StoredPayload) => string | null>> = {
  // The reported bug. One release names one client and a set of documents.
  'publish.batch': (p) => ids(p['documentIds']),

  // ⚠ A correction is identified by the DOCUMENT and the FIELD NAMES, not the
  // values. Two attempts to set the same field are the same act even if the
  // second click typed a different number — the pending one is the thing to
  // decide, and minting a rival proposal over the same field is how a queue
  // ends up holding two contradictory answers to one question. Correcting a
  // DIFFERENT field on the same document is a different act and stages
  // normally, which is the case that rules out keying on the document alone.
  'document.update-coding': (p) => {
    const documentId = str(p['documentId']);
    if (documentId === null) return null;
    const fields = p['fields'];
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
    const names = Object.keys(fields as Record<string, unknown>).sort();
    if (names.length === 0) return null;
    return `${documentId}:${names.join(',')}`;
  },

  // The chase's identity is what it is chasing: the transactions, or the
  // statement period when it is a statement request (which carries no
  // transactions at all). The BODY is deliberately not part of it — it is
  // composed server-side and discarded from the caller, so including it would
  // make every re-stage look novel.
  'chase.send': (p) => {
    const messages = p['messages'];
    if (!Array.isArray(messages)) return null;
    const parts = messages.map((message) => {
      if (typeof message !== 'object' || message === null) return null;
      const record = message as StoredPayload;
      return ids(record['transactionIds']) ?? str(record['statementPeriod']);
    });
    if (parts.some((part) => part === null)) return null;
    return [...(parts as string[])].sort().join('|');
  },

  'bank.remove-statement': (p) => ids(p['statementIds']),
  // The document, not the destination: a pending route over this document is
  // the thing to decide, whichever inbox the second click picked. Re-staging
  // with a different `inbox` is a person changing their mind about a question
  // that is already open, and the answer is to decide the open one.
  'document.route': (p) => str(p['documentId']),
  'document.move-business': (p) => str(p['documentId']),
  'document.reprocess': (p) => ids(p['documentIds']),
  'document.reject': (p) => ids(p['documentIds']),
  // ⚠ The `archived` flag is part of the identity, and it has to be: archive
  // and UNarchive are one kind carrying opposite acts, and a key over the
  // documents alone would refuse an unarchive because an archive of the same
  // rows happened to be pending.
  'document.archive': (p) => {
    const documentIds = ids(p['documentIds']);
    return documentIds === null ? null : `${documentIds}:${p['archived'] === true ? 'on' : 'off'}`;
  },
  'document.purge': (p) => ids(p['documentIds']),
  // `documentLinkIds`, not documents — this kind revokes LINKS, and two
  // different links on one document are two different acts.
  'document.revoke-link': (p) => ids(p['documentLinkIds']),
  'document.split': (p) => str(p['documentId']),
  'bank.confirm-match': (p) => {
    const transactionId = str(p['transactionId']);
    const documentId = str(p['documentId']);
    return transactionId === null || documentId === null ? null : `${transactionId}:${documentId}`;
  },
  // The PAIR being ruled on, in the payload's own two fields. A later ruling
  // supersedes an earlier one, so two pending rulings over one pair are two
  // answers waiting to disagree. Not sorted: keep and copy are asymmetric —
  // "keep A, delete B" is not "keep B, delete A".
  'document.resolve-duplicate': (p) => {
    const keep = str(p['documentKeepId']);
    const copy = str(p['documentCopyId']);
    return keep === null || copy === null ? null : `${keep}:${copy}`;
  },
  // The business, from the payload's own field rather than the proposal's
  // column — one offboard per client is the whole of it.
  'business.offboard': (p) => str(p['businessId']),
  // Same key for the mirror, and the reason is the same: one restore per
  // client is the whole of it. ⚠ The two kinds do NOT share an identity
  // space — `proposalIdentity` is keyed by kind as well — so a pending
  // offboard and a pending restore over one client are two live cards, which
  // is a state a person should be shown rather than one deduped away.
  'business.reactivate': (p) => str(p['businessId']),
  // ⚠ **`rule.create` deliberately has NO identity.** Two rules over the same
  // client are two different rules — that is what a rule set IS — and the
  // payload carries conditions and effects rather than record ids, so any key
  // this file could invent would either collapse distinct rules or dedupe
  // nothing. A rule drafted twice is a human deciding twice, and the review
  // card renders the whole rule so they can see which.
  'rule.create': () => null,
  // The WORKFLOW and the DIRECTION, the `document.archive` shape: arm and
  // disarm are one kind carrying opposite acts, so a key over the workflow
  // alone would refuse a disarm because an arm of the same policy happened to
  // be pending — which is precisely the pair a person needs to see both of.
  'policy.activate': (p) => {
    const workflowId = str(p['workflowId']);
    return workflowId === null ? null : `${workflowId}:${p['active'] === true ? 'on' : 'off'}`;
  },
};

/**
 * The dedupe key for a stored or about-to-be-stored payload, or `null` when
 * this kind is not deduped.
 *
 * The kind and business are NOT folded in — the caller has already narrowed the
 * candidate rows by both, and putting them in the string would only hide that.
 */
export function proposalIdentity(kind: ProposalKind, payload: StoredPayload): string | null {
  return IDENTITY[kind](payload);
}
