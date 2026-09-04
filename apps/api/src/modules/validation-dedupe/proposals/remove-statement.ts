import type { ProposalKind } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
} from './proposal-executor.js';

/**
 * `bank.remove-statement` — an accountant takes a wrongly-uploaded statement
 * back out, with every transaction that upload created.
 *
 * ⚠ **DORMANT — the kind is not in the contract yet.** `ProposalKind` is LAW
 * (G7), and `bank.remove-statement` is a contract-change issue for Shakib
 * before any of this is reachable: it is not in `buildExecutorRegistry`, not in
 * `ProposalPayloadMap`, and no boundary parses its payload. The full LAW delta
 * and the mechanical wiring that follows it are written out in
 * `modules/banking-matching/CLAUDE.md` ("Removing a statement — design note").
 * Both the registry and the payload map are total over `ProposalKind`, so the
 * moment the enum grows this file's absence is a compile error — which is the
 * intended reminder. The `as ProposalKind` cast below is the one concession to
 * dormancy and comes off with the same change.
 *
 * ## Why a proposal and not a DELETE
 *
 * Deleting a statement destroys a client's bank data — the most consequential
 * change on the Bank screen — and Governance §10 forbids any side-effect
 * endpoint outside the Review → Approve path. The statements surface says of
 * creation "there is no POST and none may be added"; the same one-door rule
 * extends to destruction. There is no `DELETE /v1/statements/{id}` anywhere and
 * none may exist.
 *
 * ## Hard delete of DERIVED rows — the source document is never touched
 *
 * `Statement` + `BankTransaction` rows are a projection of the uploaded file.
 * Removal deletes the projection; the file stays in the vault, and because
 * `statementAlreadyIngested` keys on `documentId`, removal FREES the document
 * for re-import — which re-runs the D41 completeness gate, so restoration is
 * re-proven rather than trusted. A soft-delete flag was considered and
 * rejected: it needs a prisma LAW change this does not, every reader (bank
 * feed, chase detection, the match suggester, `statementGaps`) would have to
 * honour it and the one that missed the filter would chase a client for a
 * deleted line, and it would either block re-import forever or allow a second
 * `Statement` for the same document.
 *
 * ## What refuses, so nothing asserted by a human is silently destroyed
 *
 * - **A CONFIRMED match.** A match is an accountant's assertion; breaking one
 *   has no approved path (`bank.unmatch` has no `ProposalKind` — the same
 *   refusal `confirm-match.ts` makes rather than overwriting). SUGGESTED rows
 *   are a machine's question, not an assertion, and die with their line
 *   (`Match.transactionId` is `onDelete: Cascade` — the schema's own vote).
 * - **An open chase.** A client has been asked for paperwork against the line;
 *   deleting it under an in-flight chase leaves the portal pointing at
 *   nothing. Closed chases are history and survive (`Chase.transactionId` is
 *   `onDelete: SetNull`; `itemRefs` keeps the ids as record). The guard reads
 *   `itemRefs`, not just the column — a grouped chase carries only its FIRST
 *   transaction id in `transactionId`.
 * - **Rows that cannot be provably enumerated.** The link is
 *   `BankTransaction.importBatchId`, stamped by `statement-ingest.ts` since
 *   3 Sep 2026. A statement whose recorded `rowCount` disagrees with its
 *   provenance-stamped rows (including the pre-stamp legacy case: rows exist,
 *   none stamped) refuses by name — deleting by period guess would remove
 *   another statement's lines.
 * - **A cross-workspace batch** (the chase.send rule), and a batch over 50.
 *
 * ## The preview is the server's, twice (the publish.batch pattern)
 *
 * `computeRemoveStatementPayload` runs at proposal CREATION: the caller's
 * figures are discarded and the server's counts are stored in the payload, so
 * what the reviewer reads at [Read review] is the real blast radius — how many
 * transactions, how many matched, how many chased. The executor recomputes at
 * approve and refuses on drift; `NT-PRP-004` structurally cannot see live-fact
 * drift, so this is the only place it is visible.
 *
 * ## Idempotent replay without a surviving row
 *
 * Every other executor answers "did I already run" from the row it changed;
 * removal has no surviving row. The durable marker is the `DocumentEvent`
 * (`stage: 'statement'`, `outcome: 'removed'`, `detail.proposalId`) written on
 * the source document in the effect transaction — a redelivery finds it and
 * reports `alreadyApplied` instead of refusing, and an id that is neither
 * present nor marked refuses without confirming whether it ever existed.
 */

/** Becomes the plain enum literal when the contract adds the kind (G7). */
const KIND = 'bank.remove-statement' as ProposalKind;

/** The house batch cap (`ArchivePayload`/`ReprocessPayload` declare 500 for
 * documents; a statement is up to ~1,500 transactions, so 50 statements is
 * already a far larger effect than any document batch). */
export const MAX_REMOVE_STATEMENT_BATCH = 50;

/** Everything before a chase settles — states in which a client is still being
 * asked for the paperwork. */
const OPEN_CHASE_STATES = ['DETECTED', 'PROPOSED', 'APPROVED', 'SENT', 'REMINDED', 'ESCALATED'] as const;

/**
 * One statement's share of the blast radius, computed by the SERVER at
 * proposal creation and stored in the payload — never trusted from a caller.
 *
 * These shapes move to `@neoting/contracts/model` (`BankRemoveStatementPayload`)
 * when the LAW change lands; they are declared here so the executor and its
 * tests are real in the meantime.
 */
export interface RemoveStatementPreviewEntry {
  readonly statementId: string;
  /** The source document — the vault keeps it, and re-import starts from it. */
  readonly documentId: string;
  readonly fileName: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** Rows provably created by this statement (`importBatchId` = statementId). */
  readonly transactionCount: number;
  /** Lines carrying a CONFIRMED match. Non-zero refuses — see the header. */
  readonly matchedCount: number;
  /** Lines inside an open chase. Non-zero refuses — see the header. */
  readonly openChaseCount: number;
}

export interface BankRemoveStatementPayload {
  readonly statementIds: readonly string[];
  readonly preview: {
    readonly statements: readonly RemoveStatementPreviewEntry[];
    readonly totalTransactions: number;
  };
}

interface StatementRow {
  readonly id: string;
  readonly businessId: string;
  readonly documentId: string | null;
  readonly rowCount: number | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

function refuse(message: string): never {
  throw new ProposalExecutionRefused(KIND, message);
}

function toIsoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * Inspect one statement and compute its share of the blast radius, refusing
 * everything the header names. Shared verbatim between proposal creation and
 * execution so the two cannot drift — the same numbers are computed both
 * times, and execution additionally compares them to what the reviewer saw.
 */
async function inspectStatement(db: ScopedClient, statement: StatementRow): Promise<RemoveStatementPreviewEntry> {
  // A statement with no source document was not created by an upload (only the
  // seed writes such rows) — there is nothing to re-import from, so removal
  // would be genuinely irreversible. Refuse rather than special-case it.
  if (statement.documentId === null) {
    refuse('that statement has no source document, so nothing could re-import it — it cannot be removed');
  }

  const transactions = await db.bankTransaction.findMany({
    where: { importBatchId: statement.id },
    select: { id: true, matchState: true },
  });

  // The provenance guard. `rowCount` is what the ingest recorded; the stamped
  // set is what removal can PROVE. Disagreement means rows this cannot see —
  // most likely a pre-stamp import — and deleting a set that disagrees with
  // the record is a partial removal presented as a removal.
  const recorded = statement.rowCount ?? 0;
  if (transactions.length !== recorded) {
    refuse(
      `the statement records ${recorded} imported line(s) but ${transactions.length} are provably linked to it ` +
        '(rows imported before provenance stamping cannot be identified) — refusing to remove a set that disagrees with the record',
    );
  }

  const transactionIds = new Set(transactions.map((t) => t.id));

  // A confirmed match is an accountant's assertion. `matchState` on the line
  // and the `matches` row are kept in step by confirm-match; read the rows,
  // which is where the assertion lives.
  const confirmed = transactionIds.size === 0
    ? []
    : await db.match.findMany({
        where: { transactionId: { in: [...transactionIds] }, state: 'CONFIRMED' },
        select: { id: true },
      });
  if (confirmed.length > 0) {
    refuse(
      `${confirmed.length} line(s) on this statement are matched to documents — a confirmed match is an ` +
        'accountant\'s assertion, and breaking one has no approved path yet (there is no bank.unmatch)',
    );
  }

  // Open chases: fetched per business and intersected in JS, because a grouped
  // chase names only its first transaction in the column and the rest live in
  // `itemRefs` (Json) — a column-only filter would miss them.
  const openChases =
    transactionIds.size === 0
      ? []
      : await db.chase.findMany({
          where: { businessId: statement.businessId, state: { in: [...OPEN_CHASE_STATES] } },
          select: { id: true, transactionId: true, itemRefs: true },
        });
  const chasing = openChases.filter(
    (chase) =>
      (chase.transactionId !== null && transactionIds.has(chase.transactionId)) ||
      (Array.isArray(chase.itemRefs) && chase.itemRefs.some((ref) => typeof ref === 'string' && transactionIds.has(ref))),
  );
  if (chasing.length > 0) {
    refuse(
      `${chasing.length} open chase(s) are asking the client for paperwork against lines on this statement — ` +
        'close them before removing the lines they stand on',
    );
  }

  return {
    statementId: statement.id,
    documentId: statement.documentId,
    // Resolved below by the caller — the document read is batched there.
    fileName: null,
    periodStart: toIsoDate(statement.periodStart),
    periodEnd: toIsoDate(statement.periodEnd),
    transactionCount: transactions.length,
    matchedCount: 0,
    openChaseCount: 0,
  };
}

/**
 * The creation-time half (the `computePublishBatchPayload` pattern): resolve
 * the statements through RLS, refuse everything refusable NOW — refusing at
 * proposal time beats approving a doomed proposal — and return the payload
 * whose preview [Read review] renders. The caller's own preview, if it sent
 * one, is discarded.
 *
 * Wired into `action-proposals.service.ts` beside the `publish.batch` branch
 * once the kind exists in the contract.
 */
export async function computeRemoveStatementPayload(
  db: ScopedClient,
  statementIds: readonly string[],
): Promise<BankRemoveStatementPayload> {
  const ids = [...new Set(statementIds)];
  if (ids.length === 0) refuse('a removal names at least one statement');
  if (ids.length > MAX_REMOVE_STATEMENT_BATCH) {
    refuse(`a removal batch is 1 to ${MAX_REMOVE_STATEMENT_BATCH} statements`);
  }

  const entries: RemoveStatementPreviewEntry[] = [];
  const businesses = new Set<string>();
  for (const id of ids) {
    // RLS decides visibility: an invisible statement and an absent one are the
    // same refusal, and neither answer confirms existence.
    const statement = await db.statement.findUnique({
      where: { id },
      select: { id: true, businessId: true, documentId: true, rowCount: true, periodStart: true, periodEnd: true },
    });
    if (statement === null) refuse('no statement with that id');
    businesses.add(statement.businessId);
    entries.push(await inspectStatement(db, statement));
  }

  // Both individually visible does not make them the same client's — a
  // practice-scoped approver sees every workspace it administers, and one
  // approval must not destroy two clients' bank data (the chase.send rule).
  if (businesses.size > 1) {
    refuse('the statements belong to different clients — a removal cannot cross a workspace');
  }

  // The file names, batched, for the review card — a reviewer recognises a
  // statement by the file it came from, not by a cuid.
  const documentIds = entries.map((entry) => entry.documentId);
  const names = new Map(
    (
      await db.document.findMany({
        where: { id: { in: documentIds } },
        select: { id: true, originalFilename: true },
      })
    ).map((doc) => [doc.id, doc.originalFilename]),
  );

  const withNames = entries.map((entry) => ({
    ...entry,
    fileName: names.get(entry.documentId) ?? null,
  }));

  return {
    statementIds: ids,
    preview: {
      statements: withNames,
      totalTransactions: withNames.reduce((sum, entry) => sum + entry.transactionCount, 0),
    },
  };
}

/**
 * The effect. Runs inside the ENGINE's open `scopedDb` transaction; decides
 * nothing about whether it may happen (the #81 seam).
 *
 * Satisfies `ProposalExecutor<'bank.remove-statement', BankRemoveStatementPayload>`
 * the day the kind exists; until then it is structurally identical and typed
 * locally so nothing here depends on the LAW change to compile.
 */
export const removeStatementExecutor = {
  kind: KIND,

  async execute(db: ScopedClient, input: ExecutionInput<BankRemoveStatementPayload>): Promise<ExecutionResult> {
    const { payload, proposalId, traceId } = input;

    // The stored row sat in a table between propose and approve. The engine
    // re-parses through the contract union once the kind exists; until then
    // this light guard keeps the executor from walking an unexpected shape.
    if (!Array.isArray(payload?.preview?.statements) || payload.preview.statements.length === 0) {
      refuse('the stored payload no longer parses');
    }

    const changed: { entity: 'document'; id: string }[] = [];
    let removedStatements = 0;
    let removedTransactions = 0;
    let alreadyApplied = 0;

    for (const entry of payload.preview.statements) {
      const statement = await db.statement.findUnique({
        where: { id: entry.statementId },
        select: { id: true, businessId: true, documentId: true, rowCount: true, periodStart: true, periodEnd: true },
      });

      if (statement === null) {
        // No surviving row to answer "did I already run" from — the durable
        // marker is the removal event this executor wrote on the source
        // document. Found, this entry is a replay; not found, the id is
        // unreachable and the refusal never confirms whether it ever existed.
        const marker = await db.documentEvent.findFirst({
          where: {
            documentId: entry.documentId,
            stage: 'statement',
            outcome: 'removed',
            detail: { path: ['proposalId'], equals: proposalId },
          },
          select: { id: true },
        });
        if (marker === null) refuse('no statement with that id');
        alreadyApplied += 1;
        changed.push({ entity: 'document', id: entry.documentId });
        continue;
      }

      // Re-inspect against live facts. Review is idempotent and the render is
      // payload-pure, so `NT-PRP-004` cannot see a match confirmed or a chase
      // sent between review and approve — this is the only place that drift is
      // visible (the publish.batch precedent).
      const live = await inspectStatement(db, statement);
      if (live.transactionCount !== entry.transactionCount) {
        refuse(
          `the transactions under this statement changed since the removal was reviewed ` +
            `(${entry.transactionCount} reviewed, ${live.transactionCount} now) — propose it again over the current facts`,
        );
      }

      // The effect: the provable set, then the statement row. SUGGESTED match
      // rows die with their lines (Cascade — a machine's question, not an
      // assertion; CONFIRMED refused above); a closed chase keeps its record
      // (SetNull). `deleteMany` on both so a concurrent duplicate execution
      // finds zero rows rather than throwing — the goal state is the same.
      const deleted = await db.bankTransaction.deleteMany({ where: { importBatchId: statement.id } });
      await db.statement.deleteMany({ where: { id: statement.id } });

      // The processing log is the audit surface for the document, and "the
      // rows read from this file were removed" is a fact about the document a
      // reader six months later needs. It is ALSO the replay marker above.
      await db.documentEvent.create({
        data: {
          documentId: entry.documentId,
          stage: 'statement',
          outcome: 'removed',
          traceId,
          detail: {
            proposalId,
            statementId: statement.id,
            transactionsRemoved: deleted.count,
          },
        },
      });

      removedStatements += 1;
      removedTransactions += deleted.count;
      changed.push({ entity: 'document', id: entry.documentId });
    }

    return {
      changed,
      alreadyApplied: alreadyApplied === payload.preview.statements.length,
      followUps: [],
      detail: {
        statementsRemoved: removedStatements,
        transactionsRemoved: removedTransactions,
      },
    };
  },
};
