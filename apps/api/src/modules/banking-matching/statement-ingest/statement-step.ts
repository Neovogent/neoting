import { resolveSystemActor } from '../../../common/db/resolve-system-actor.js';
import type { PrismaClient } from '../../../common/db/prisma.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { ingestStatement, type StatementScopedClient } from './statement-ingest.js';

/**
 * The ingest job's statement step.
 *
 * Runs after extraction for a document the extractor classified `STATEMENT`,
 * and turns it into `Statement` + `BankTransaction` rows. Before this existed
 * the classification was made and then discarded: `docType: 'STATEMENT'` was
 * written to the row and nothing ever read it, so the only bank input ID has
 * (D40) reached the database as a filed PDF and nothing else.
 *
 * ## Why it decides for itself rather than being told
 *
 * The processor does not pass the document type in. `ExtractionCompletion`
 * does not carry one, and widening it would push a banking concern into the
 * extraction contract for the benefit of a single caller. This step reads the
 * row it is about to act on — which it must read anyway, for the file name and
 * the object key — and answers "not mine" cheaply for everything else.
 *
 * ## It never fails the job
 *
 * Same rule, and the same reason, as chase auto-close: by the time this runs
 * the document is persisted and extracted. Losing that work to a parse error
 * would invert "nothing is ever silently dropped". A refusal is recorded
 * against the document and logged; the accountant sees a statement that did not
 * import and why, which is the safe direction.
 */

export interface StatementStepInput {
  readonly documentId: string;
  readonly practiceId: string;
  /** Null while unrouted — a statement cannot be ingested without a client. */
  readonly businessId: string | null;
  readonly traceId: string;
}

export interface StatementStep {
  run(input: StatementStepInput): Promise<void>;
}

export interface StatementStepLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** The one thing this needs from storage: the bytes back. */
export interface StatementBytesSource {
  get(key: string): Promise<Buffer>;
}

const NOOP_LOGGER: StatementStepLogger = { log() {}, warn() {} };

/**
 * A step that does nothing, for the composition roots that have no banking
 * concern (and for tests that are not about statements).
 *
 * Deliberately a NAMED export rather than letting the dep be optional: an
 * optional dependency is one a composition root can forget, and this module's
 * own processor already carries three comments about exactly that failure. A
 * root that wants no statement ingestion has to say so.
 */
export const NO_STATEMENT_STEP: StatementStep = { async run() {} };

export class PrismaStatementStep implements StatementStep {
  private readonly logger: StatementStepLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: StatementBytesSource,
    options: { logger?: StatementStepLogger } = {},
  ) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async run(input: StatementStepInput): Promise<void> {
    // An unrouted document has no client, so its lines would belong to nobody.
    // It is not an error: routing happens later, and the statement is ingested
    // on the re-run that follows the routing approval.
    if (input.businessId === null) return;
    const jobBusinessId = input.businessId;

    try {
      const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);
      const ctx = systemContext(input.practiceId, systemUserId);

      const document = await scopedDb(this.prisma, ctx, (db) =>
        db.document.findUnique({
          where: { id: input.documentId },
          select: { docType: true, originalFilename: true, s3Key: true, businessId: true },
        }),
      );
      if (document === null || document.docType !== 'STATEMENT') return;

      const bytes = await this.store.get(document.s3Key);

      const outcome = await scopedDb(this.prisma, ctx, (db) =>
        ingestStatement(
          db as unknown as StatementScopedClient,
          {
            documentId: input.documentId,
            // The row's own business, not the job payload's: routing may have
            // moved the document since the job was enqueued, and the lines must
            // land on the client the document actually belongs to now.
            businessId: document.businessId ?? jobBusinessId,
            fileName: document.originalFilename,
            bytes,
          },
          this.logger,
        ),
      );

      if (outcome.status === 'refused') {
        // Recorded on the document so the refusal is visible where the file is,
        // rather than only in a log line nobody reads. The document itself is
        // NOT failed: the bytes are safely stored and a person can look at it.
        // ⚠ `failureMessage` WITHOUT touching `state`, and the pair matters.
        //
        // The schema's own comment says failure columns are "never null when
        // state is REJECTED/FAILED" — it does not say the reverse, and this is
        // deliberately the reverse case: the DOCUMENT is fine. It was received,
        // stored and read; only the import of its rows did not happen. Failing
        // the document would hide a perfectly good statement in the
        // Rejected/Failed view and lose the file the accountant needs to look
        // at, when what they actually need is the file plus the reason.
        //
        // `NT-STM-001` is a lane-local marker, not a contract error code: no
        // response carries it, and adding one to the contract's enum is a G7
        // change this step does not own.
        await scopedDb(this.prisma, ctx, (db) =>
          db.document.update({
            where: { id: input.documentId },
            data: { failureCode: 'NT-STM-001', failureMessage: outcome.reason },
          }),
        );
        this.logger.warn(
          `statement-step: ${input.documentId} not imported — ${outcome.reason} (trace=${input.traceId})`,
        );
        return;
      }

      if (outcome.status === 'ingested') {
        this.logger.log(
          `statement-step: ${input.documentId} imported ${outcome.rowCount} transaction(s), ` +
            `assurance=${outcome.report.assurance} (trace=${input.traceId})`,
        );
      }
    } catch (error) {
      // Swallowed on purpose — see the header. The document survives; the
      // statement simply is not imported, and that is visible on the screen.
      this.logger.warn(
        `statement-step: ${input.documentId} threw and was skipped — ` +
          `${error instanceof Error ? error.message : String(error)} (trace=${input.traceId})`,
      );
    }
  }
}
