import type { DocumentPurgePayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `document.purge` — permanently destroy documents that are already in Trash
 * (document management, 2 Sep 2026).
 *
 * ## Why this is the ONLY document deletion on the proposal spine
 *
 * Moving a document to Trash is `POST /v1/documents/{id}/deletion`, an ordinary
 * authenticated mutation, because `POST .../restoration` undoes it exactly —
 * `RELEASE_KINDS`' own test for an internal act. Purging undoes nothing. It is
 * the one genuinely irreversible thing that can happen to a document, so it is
 * a proposal, and **there is no `DELETE /documents/{documentId}` anywhere in the
 * contract** for it to be reachable around. Same shape and same argument as
 * `document.revoke-link`, whose header records that no revoke endpoint exists
 * either.
 *
 * ## ⚠ The refusal — `NT-DOC-002`, and it is D43
 *
 * > *Every exported transaction carries a resolvable link to its source
 * > document.* (D43)
 *
 * An export mints a `document_links` capability code per document it carries,
 * and an accountant reads that code out of a CSV column inside VT Transaction+ —
 * outside this product, with no session of ours, weeks or months later. Purging
 * such a document turns a working URL in somebody's ledger into a permanent
 * `410`, and **nothing in this product would ever surface that it had
 * happened**: nobody is watching the accountant's VT file. The failure is
 * silent, remote and permanent, which is the exact combination that justifies
 * refusing rather than warning.
 *
 * **Three checks, and all three read ROWS.** The contract's phrasing is "has
 * been PUBLISHED or appears in any export", and the `state` column can answer
 * neither on its own:
 *
 * 1. `state = 'PUBLISHED'` — the document is released for export right now.
 * 2. a `publishes` row exists — it HAS been released, even if `state` has since
 *    moved. `document.archive`'s unarchive path demotes a PUBLISHED document to
 *    READY or TO_REVIEW and `publish-batch.ts`'s retry edge takes a REJECTED
 *    one through PROCESSING, so a document that has been in an export can be
 *    sitting in any of five states by the time somebody purges it. Reasoning
 *    from `state` alone would miss every one of those.
 * 3. a `document_links` row exists — the D43 code itself, which is the direct
 *    evidence and the thing that actually breaks. **Including a revoked or
 *    expired one**: a revoked link is a `410` that an operator can explain from
 *    the row, and destroying the row turns the same URL into "no such code",
 *    which is indistinguishable from a typo. `exports` has no per-document
 *    rows, so this table IS the export-membership record.
 *
 * **Refused, never cascaded.** Revoking the links first and purging anyway
 * would be this executor quietly performing a `document.revoke-link` that
 * nobody reviewed, on rows inside somebody else's ledger — a second door onto
 * an act that has its own proposal kind precisely so a human sees it first. The
 * available paths are to revoke deliberately, or to leave the document in Trash,
 * where it is already gone from every working surface.
 *
 * ⚠ **The refusal is also what keeps RELEASE AN APPEND-ONLY FACT**, which is the
 * single thing `docs/research/dext-document-management.md` §10.3 R1 refuses
 * absolutely — Dext's *Clear Publishing Data*, which erases the record that a
 * document was ever released and leaves the system unable to tell "never
 * released" from "released, then cleared". Both `publishes.document` and
 * `document_links.document` are `ON DELETE CASCADE`, so a purge that ran on a
 * released document would delete its release record along with it and produce
 * exactly that ambiguity — by a different door and with no prompt at all.
 * Because a `publishes` row REFUSES the purge, that path is unreachable: no
 * operation in this product can erase a release. Do not "fix" the cascade to
 * make purge work; the cascade is not the problem, purging a released document
 * is.
 *
 * ## What it destroys, and the one thing it does not
 *
 * The `documents` row, and by `ON DELETE CASCADE` its extractions, its
 * `document_events` processing log, its duplicate pairs, its suggestions and its
 * item threads.
 *
 * ⚠ **THE PROCESSING LOG GOES WITH IT, SO THE PROPOSAL ROW IS THE SURVIVING
 * RECORD.** `document_events` cascades, which means the document's own history
 * — including the `delete` event that put it in Trash — is destroyed here.
 * What outlives it, and what makes this act accountable a year later:
 *
 * - the `action_proposals` row, which is **never deleted and is immutable after
 *   execution** (`action_proposals_guard()` in rls.sql §6). It carries
 *   `payload.documentIds` — the ids themselves — `approved_by_user_id`, and
 *   `outcome.changed`, the engine's record of every row this executor reported
 *   touching;
 * - the `audit_events` hash-chain row the engine appends in the same
 *   transaction, naming the approver and pointing at that proposal.
 *
 * So "which documents were destroyed, by whom, when, and why" is answerable
 * from two immutable tables after the documents are gone. That is deliberately
 * better than the market: Hubdoc's per-document audit panel records provenance
 * only — no deletion, no restore — and once its Trash is emptied a document's
 * removal leaves no trace at all. Do not let a future change make the proposal
 * row optional on this path.
 *
 * ⚠ **THE STORED OBJECT IS NOT DELETED, AND THE REVIEW CARD SAYS SO.** An
 * executor runs inside the engine's transaction and may not make an external
 * call; `document.reprocess` records the identical limitation on its own card
 * for the identical reason. Reclaiming the bytes needs an object-lifecycle
 * sweep that does not exist. Stating the shortfall on the card is the Review →
 * Approve promise — what was shown is what happens — applied to a shortfall.
 */
export const purgeDocumentExecutor: ProposalExecutor<'document.purge', DocumentPurgePayload> = {
  kind: 'document.purge',

  async execute(db: ScopedClient, input: ExecutionInput<DocumentPurgePayload>): Promise<ExecutionResult> {
    const { payload, proposalId } = input;
    const ids = [...payload.documentIds];

    const documents = await db.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        state: true,
        deletedAt: true,
        // The two row-level export proofs, counted rather than fetched: the
        // question is "does any exist", and a count keeps the payload small for
        // a 100-document batch.
        _count: { select: { links: true, publishes: true } },
      },
    });

    // All-or-nothing, the `document.archive` rule: an id RLS cannot see and an
    // id that does not exist are the same refusal, and a batch that silently
    // skipped either would report success over a hole. It matters more here
    // than anywhere else — the successful half of a partial purge cannot be
    // re-run, because it no longer exists to be named.
    if (documents.length !== ids.length) {
      throw new ProposalExecutionRefused('document.purge', 'one or more documents are not reachable');
    }

    for (const document of documents) {
      // Trash first, always. Trash is the undo, and skipping it would make a
      // single approval the whole distance between a live document and no
      // document — which is the safeguard this two-step exists to be.
      if (document.deletedAt === null) {
        throw new ProposalExecutionRefused(
          'document.purge',
          'one or more documents are not in Trash; delete them first, which is reversible',
        );
      }

      if (document.state === 'PUBLISHED' || document._count.publishes > 0 || document._count.links > 0) {
        throw new ProposalExecutionRefused(
          'document.purge',
          // Written to be read by the person who pressed Approve. It names what
          // is protected and the one action available to them, and it names no
          // id — the batch refused as a whole and the reason is the same for
          // every member of it.
          'One or more of these documents has been released for export, or has an export link an accountant may still be using. ' +
            'Purging it would break the link from an exported line back to its source, with nothing to notice afterwards. ' +
            'Leave them in Trash, or revoke their links deliberately first.',
          // NAMED in the contract, so a client can branch on it. Without this
          // the wire code would be the engine's generic `NT-PRP-006` and the
          // one branch the contract promises could not be written — the reason
          // `ProposalExecutionRefused` carries a code at all.
          'NT-DOC-002',
        );
      }
    }

    // ⚠ THE FOURTH CHECK, and the one no relation could make for us.
    //
    // `statements.document_id` and `supplier_statements.document_id` are plain
    // nullable columns with **no foreign key** — so Postgres would let a purge
    // leave them pointing at a row that no longer exists, and nothing anywhere
    // would notice. Under D40 manual statement upload is the ONLY bank input in
    // this release, which makes that reference the sole answer to "which
    // uploaded file produced these 1,144 bank lines". A real client already
    // held 2,288 transactions that were 1,144 rows imported twice; the fix for
    // that (`20260902160000_bank_transaction_import_fingerprint`) is only
    // auditable while the statement can still name its source document.
    //
    // Same refusal, same code: it is the identical failure D43 names — a
    // durable reference that silently stops resolving — and one `NT-DOC-002`
    // with one runbook page beats two codes for one class of mistake. Two
    // queries rather than `_count`, because there is no relation to count
    // through.
    const [statements, supplierStatements] = await Promise.all([
      db.statement.count({ where: { documentId: { in: ids } } }),
      db.supplierStatement.count({ where: { documentId: { in: ids } } }),
    ]);
    if (statements > 0 || supplierStatements > 0) {
      throw new ProposalExecutionRefused(
        'document.purge',
        'One or more of these documents is the source file for a bank or supplier statement. ' +
          'Purging it would leave those statements unable to say where their figures came from. ' +
          'Leave them in Trash.',
        'NT-DOC-002',
      );
    }

    // Reached only when every document passed. `deleteMany` over the exact id
    // list — never a filter, never a prefix — so the statement can destroy
    // nothing the checks above did not individually clear.
    const removed = await db.document.deleteMany({ where: { id: { in: ids } } });

    return {
      // The engine records these in `outcome`, which lands in the audit chain —
      // and that is the ONLY surviving record of these ids, since the rows they
      // name no longer exist.
      changed: documents.map((document) => ({ entity: 'document' as const, id: document.id })),
      // Never a no-op replay. A second execution of the same proposal cannot
      // reach here: the ids are gone, so the reachability check above refuses
      // first — which is the correct answer, not `alreadyApplied`. The engine's
      // own exactly-once guard (the consumed proposal row plus the database
      // trigger) is what actually prevents the second attempt.
      alreadyApplied: false,
      followUps: [],
      detail: {
        purged: removed.count,
        proposalId,
        // Said out loud in the stored outcome, not only on the review card: an
        // operator reading this row later must not conclude the bytes are gone.
        storedObjectsRetained: true,
      },
    };
  },
};
