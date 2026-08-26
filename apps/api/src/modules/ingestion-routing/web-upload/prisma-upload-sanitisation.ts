/**
 * The real worker-side sanitisation step for web and portal uploads (Stage A3).
 *
 * Three phases, split on purpose and in this order:
 *
 *   1  read the row under the practice's SYSTEM actor and decide whether there is
 *      anything to do (idempotent — only a RECEIVED document proceeds);
 *   2  read the bytes, run `sanitise()`, hash and re-store — ALL OUTSIDE any
 *      transaction, because sharp decodes images and qpdf is a subprocess, and
 *      neither may hold a tenant row locked while it runs;
 *   3  one short transaction to make the row describe the bytes that now exist,
 *      or to move the document to REJECTED with the reason on it.
 *
 * The same shape as `PrismaExtractionStep`, for the same reasons. Everything
 * goes through `scopedDb` — an unscoped query here would be a tenancy leak, and
 * RLS fails closed and silent.
 */

import type { Document as DocumentRow, Prisma } from '@prisma/client';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { resolveSystemActor } from '../../../common/db/resolve-system-actor.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { transitionDocument } from '../../validation-dedupe/index.js';
import type { DocumentStore } from '../storage/document-store.js';
import { capChannelFor } from './upload-policy.js';
import {
  sanitiseUploadBytes,
  type SanitisedUpload,
  type UploadSanitisationDeps,
  type UploadSanitisationInput,
  type UploadSanitisationResult,
  type UploadSanitisationStep,
} from './upload-sanitisation.js';

export interface UploadSanitisationStepLogger {
  log(message: string): void;
  warn(message: string): void;
}

const NOOP_LOGGER: UploadSanitisationStepLogger = { log() {}, warn() {} };

/** What the step needs beyond Prisma: the bytes, and the sanitisation capabilities. */
export interface PrismaUploadSanitisationDeps extends UploadSanitisationDeps {
  /** The store the intent was presigned into, and the one the clean bytes go back to. */
  readonly store: DocumentStore;
}

/** The columns the step reads and the ones it is about to overwrite. */
type UploadRow = Pick<
  DocumentRow,
  | 'id'
  | 'state'
  | 'channel'
  | 's3Key'
  | 'byteHash'
  | 'byteSize'
  | 'mimeType'
  | 'perceptualHash'
  | 'businessId'
  | 'practiceId'
>;

function identityOf(row: UploadRow): SanitisedUpload {
  return {
    storageKey: row.s3Key,
    byteHash: row.byteHash,
    byteSize: row.byteSize,
    mimeType: row.mimeType,
    perceptualHash: row.perceptualHash,
  };
}

export class PrismaUploadSanitisationStep implements UploadSanitisationStep {
  private readonly logger: UploadSanitisationStepLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: PrismaUploadSanitisationDeps,
    options: { readonly logger?: UploadSanitisationStepLogger } = {},
  ) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async run(input: UploadSanitisationInput): Promise<UploadSanitisationResult> {
    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);
    const ctx = systemContext(input.practiceId, systemUserId);

    // Phase 1 — is there anything to do? A redelivery, a crash-retry, or a
    // second completion of the same intent must not re-decode and re-store a
    // document a previous attempt already finished.
    //
    // ⚠ THE STATE IS NOT ENOUGH ON ITS OWN, and that is the trap. Sanitisation
    // leaves the document in RECEIVED — extraction is what moves it — so "is it
    // still RECEIVED?" answers yes both before and after the work, and a second
    // job would decode, re-encode and re-store the whole file again. The
    // durable marker is the `sanitise` event this step writes, so that is what
    // is asked for. The state check stays as the second half: once extraction
    // has read the bytes, sanitising underneath it is worse than pointless.
    const seen = await scopedDb(this.prisma, ctx, async (db) => ({
      row: await this.read(db, input.documentId),
      alreadySanitised: await this.hasSanitiseEvent(db, input.documentId),
    }));
    const row = seen.row;
    if (row === null) {
      const reason = `sanitise: document ${input.documentId} not visible — skipping (trace=${input.traceId})`;
      this.logger.warn(reason);
      return { status: 'unavailable', reason };
    }
    if (seen.alreadySanitised || row.state !== 'RECEIVED') {
      this.logger.log(
        `sanitise: ${input.documentId} already handled (state=${row.state}) — skipping (idempotent, trace=${input.traceId})`,
      );
      return { status: 'already-sanitised', document: identityOf(row) };
    }

    // Phase 2 — the work. Outside any transaction (see the file header).
    //
    // ⚠ THIS BUFFERS THE WHOLE OBJECT. `get()` materialises it, and the
    // accountant channel's cap is 100 MB, so a worker running eight jobs
    // concurrently can hold 800 MB of document. That is the price of sanitising
    // at all — the pipeline sniffs, decodes and re-encodes, none of which can be
    // done on a stream — and it is why this runs in the worker rather than on
    // the request path the presigned two-step exists to keep light.
    const bytes = await this.deps.store.get(row.s3Key);
    const result = await sanitiseUploadBytes({ bytes, channel: capChannelFor(row.channel) }, this.deps);

    if (!result.ok) {
      // A rejection is a DECISION about this document, and the document already
      // exists — so unlike the WhatsApp lane (which has no row to write to and
      // must dead-letter) this one has somewhere honest to put it. REJECTED with
      // the NT-ING code and the plain-English reason is the Rejected/Failed
      // surface (`GET /documents?state=REJECTED`), which is where a human can
      // see it and drive a `document.reprocess` proposal. Nothing is dropped and
      // nothing pages.
      const { rejection } = result;
      await scopedDb(this.prisma, ctx, (db) =>
        transitionDocument(
          db,
          { id: row.id, state: 'RECEIVED' },
          {
            to: 'REJECTED',
            failure: { code: rejection.code, message: rejection.message },
            traceId: input.traceId,
            detail: { stage: 'sanitise', kind: rejection.kind },
          },
        ),
      );
      this.logger.warn(
        `sanitise: ${input.documentId} REJECTED ${rejection.code} (${rejection.kind}) (trace=${input.traceId})`,
      );
      return { status: 'rejected', rejection };
    }

    const clean = result.document;
    // Store BEFORE the row is repointed, so `documents.s3_key` never names an
    // object that does not exist. The key is content-addressed on the SANITISED
    // hash, which also finally moves a web upload off its `uploads/<nonce>`
    // intent key onto the same `documents/<sha256>` layout every other channel
    // uses (storage/CLAUDE.md's own TODO).
    const stored = await this.deps.store.put({
      bytes: clean.bytes,
      sha256: clean.sha256,
      contentType: clean.mimeType,
      workspaceId: row.businessId,
      practiceId: row.practiceId,
    });

    // Phase 3 — make the row describe the bytes that now exist.
    const document: SanitisedUpload = {
      storageKey: stored.key,
      byteHash: clean.sha256,
      byteSize: clean.byteLength,
      mimeType: clean.mimeType,
      perceptualHash: clean.perceptualHash,
    };
    const applied = await scopedDb(this.prisma, ctx, (db) => this.apply(db, input, row, document));
    if (applied === null) {
      // A concurrent worker finalised it between phase 1 and phase 3. Its write
      // won; ours would clobber a row that already describes real bytes. Re-read
      // and report what is actually there rather than what we just computed.
      const current = await scopedDb(this.prisma, ctx, (db) => this.read(db, input.documentId));
      this.logger.log(`sanitise: ${input.documentId} finalised concurrently — keeping the winner (trace=${input.traceId})`);
      return { status: 'already-sanitised', document: current === null ? null : identityOf(current) };
    }

    this.logger.log(
      `sanitise: ${input.documentId} → ${document.mimeType} ${document.byteSize}B (trace=${input.traceId})`,
    );
    return { status: 'sanitised', document };
  }

  /**
   * The durable "this has already been sanitised" marker.
   *
   * `document_events` is the module's audit surface and is written in the same
   * transaction as the row it describes, so its presence and the row's contents
   * cannot disagree. Using it rather than inventing a `sanitisedAt` column keeps
   * `prisma/` — LAW (G7) — out of this stage entirely.
   */
  private async hasSanitiseEvent(db: ScopedClient, documentId: string): Promise<boolean> {
    const event = await db.documentEvent.findFirst({
      where: { documentId, stage: 'sanitise' },
      select: { id: true },
    });
    return event !== null;
  }

  private async read(db: ScopedClient, documentId: string): Promise<UploadRow | null> {
    return db.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        state: true,
        channel: true,
        s3Key: true,
        byteHash: true,
        byteSize: true,
        mimeType: true,
        perceptualHash: true,
        businessId: true,
        practiceId: true,
      },
    });
  }

  /**
   * Repoint the row at the sanitised object, and record it on the timeline.
   *
   * NOT a `transitionDocument` call: the document stays in RECEIVED and
   * extraction is what moves it to PROCESSING. Sanitisation changes what the
   * document IS, not where it is in the pipeline, so it writes its own
   * `document_events` row (stage `sanitise`) rather than borrowing the state
   * machine for a move that does not happen.
   *
   * `updateMany` guarded on BOTH the state and the `s3Key` we read in phase 1,
   * so the write is compare-and-swap shaped and a lost race is a zero rowcount
   * rather than a clobber — the same discipline `transitionDocument` uses. The
   * key is the half that matters here: two workers racing this document are both
   * looking at a RECEIVED row, and only the key tells them apart, because the
   * winner has already moved it off the `uploads/<nonce>` intent key.
   */
  private async apply(
    db: ScopedClient,
    input: UploadSanitisationInput,
    row: UploadRow,
    document: SanitisedUpload,
  ): Promise<true | null> {
    const updated = await db.document.updateMany({
      where: { id: row.id, state: 'RECEIVED', s3Key: row.s3Key },
      data: {
        s3Key: document.storageKey,
        byteHash: document.byteHash,
        byteSize: document.byteSize,
        mimeType: document.mimeType,
        perceptualHash: document.perceptualHash,
      },
    });
    if (updated.count === 0) return null;

    await db.documentEvent.create({
      data: {
        documentId: row.id,
        stage: 'sanitise',
        outcome: 'sanitised',
        traceId: input.traceId,
        detail: {
          // The declared values, kept as the record of what the browser claimed
          // versus what the bytes turned out to be. `originalFilename` is
          // deliberately absent: it is submitter-chosen text and this JSON is
          // read back onto a screen.
          declaredMimeType: row.mimeType,
          storedMimeType: document.mimeType,
          declaredByteSize: row.byteSize,
          storedByteSize: document.byteSize,
          rekeyed: row.s3Key !== document.storageKey,
        } as Prisma.InputJsonValue,
      },
    });
    return true;
  }
}
