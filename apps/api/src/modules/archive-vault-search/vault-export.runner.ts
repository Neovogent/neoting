import { Logger } from '@nestjs/common';
import type { Document as DocumentRow, VaultExportState } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { safeEntryName } from '../../common/zip/store-zip.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import { DriveAdapter } from './drive-adapter.js';
import type { DriveTokenStore } from './drive-token-store.js';
import { extensionFor } from './vault.service.js';

/**
 * Copying a client's documents into their own Google Drive or OneDrive (D51).
 *
 * ## ⚠ Why this is a runner and not part of the request
 *
 * Four hundred files over someone else's network is minutes of work, and
 * `apps/api/CLAUDE.md` is explicit that anything over five seconds runs off the
 * request. So `POST /portal/vault/exports` writes a QUEUED row and returns; this
 * drives it afterwards.
 *
 * ⚠ **It is written to be re-drivable, and that is the crash story.** The work
 * list is "rows in QUEUED or RUNNING", so a process that dies mid-run leaves a
 * row that the next sweep picks up. The cost of that is documents copied twice
 * on a resumed run, which is why every upload asks the vendor to RENAME on
 * conflict rather than overwrite — a duplicate in a client's Drive is untidy; an
 * overwritten file is lost data.
 *
 * ## The three rules it shares with the ledger's follow-up
 *
 * 1. **No external call holds a tenant transaction open.** The document list is
 *    read in one short transaction, the copying happens outside every
 *    transaction, and the result is written in another short one.
 * 2. **A per-file failure is a RESULT, not a throw.** One refused file is a
 *    counted failure; the run continues. This is what makes `PARTIAL` mean
 *    something.
 * 3. **Nothing here changes a document.** No state, no flag, no `documents`
 *    write at all. A copy is a copy.
 */
export class VaultExportRunner {
  private readonly logger = new Logger(VaultExportRunner.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly tokens: (ctx: ScopeContext) => DriveTokenStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Drive one run to completion.
   *
   * `documents` is passed in rather than re-read, because the caller already
   * holds the same predicate the count was taken with — and re-reading here
   * would let the total on the row disagree with what actually gets copied.
   */
  async run(ctx: ScopeContext, exportId: string, businessId: string, documents: DocumentRow[]): Promise<void> {
    const row = await scopedDb(this.prisma, ctx, (db) =>
      db.vaultExport.findFirst({ where: { id: exportId, businessId } }),
    );
    if (row === null) return;
    if (row.state !== 'QUEUED' && row.state !== 'RUNNING') return;

    const store = this.tokens(ctx);
    let resolved;
    try {
      const connection = await scopedDb(this.prisma, ctx, (db) =>
        db.integration.findFirst({ where: { businessId, kind: row.kind, isActive: true }, select: { id: true } }),
      );
      if (connection === null) throw new Error('That drive is no longer connected.');
      resolved = await store.resolve(connection.id);
    } catch (error) {
      await this.finish(ctx, exportId, 'FAILED', { failureMessage: readable(error) });
      return;
    }

    const adapter = new DriveAdapter(resolved.vendor, resolved.accessToken, this.fetchImpl);
    const folderName = `Neo Accounting — ${new Date().toISOString().slice(0, 10)}`;

    let folderId: string;
    try {
      // ⚠ THE VENDOR CALL, OUTSIDE EVERY TRANSACTION.
      folderId = await adapter.createFolder(folderName);
    } catch (error) {
      await store.markUnhealthy(resolved.integrationId, readable(error));
      await this.finish(ctx, exportId, 'FAILED', { failureMessage: readable(error) });
      return;
    }

    await scopedDb(this.prisma, ctx, (db) =>
      db.vaultExport.updateMany({
        where: { id: exportId },
        data: { state: 'RUNNING', startedAt: new Date(), folderName },
      }),
    );

    let sent = 0;
    let failed = 0;
    const seen = new Map<string, number>();

    for (const document of documents) {
      if (document.s3Key === null) {
        failed += 1;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await this.store.get(document.s3Key);
      } catch (error) {
        this.logger.warn(`vault export ${exportId} could not read document ${document.id}: ${readable(error)}`);
        failed += 1;
        continue;
      }

      const name = entryName(document, seen);
      // ⚠ THE VENDOR CALL, OUTSIDE EVERY TRANSACTION, AND ITS FAILURE IS A
      // RESULT. One refused file does not end the run.
      const result = await adapter.upload(folderId, name, document.mimeType ?? 'application/octet-stream', bytes);
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
        this.logger.warn(`vault export ${exportId} could not send ${document.id}: ${result.reason}`);
      }

      // Progress is written as it happens, so a client watching the Vault tab
      // sees a number that moves rather than a spinner that might be stuck.
      if ((sent + failed) % PROGRESS_EVERY === 0) {
        await scopedDb(this.prisma, ctx, (db) =>
          db.vaultExport.updateMany({ where: { id: exportId }, data: { sentCount: sent, failedCount: failed } }),
        );
      }
    }

    // PARTIAL is its own outcome: 399 of 400 copied is not a failed export.
    const state: VaultExportState = failed === 0 ? 'SUCCEEDED' : sent === 0 ? 'FAILED' : 'PARTIAL';
    await this.finish(ctx, exportId, state, {
      sentCount: sent,
      failedCount: failed,
      failureMessage:
        failed === 0
          ? null
          : `${failed} of ${sent + failed} ${failed === 1 ? 'document' : 'documents'} could not be copied. The rest are in "${folderName}".`,
    });
    await store.markHealthy(resolved.integrationId);
  }

  private async finish(
    ctx: ScopeContext,
    exportId: string,
    state: VaultExportState,
    data: Record<string, unknown>,
  ): Promise<void> {
    await scopedDb(this.prisma, ctx, (db) =>
      db.vaultExport.updateMany({ where: { id: exportId }, data: { ...data, state, completedAt: new Date() } }),
    );
  }
}

/** How often progress is flushed. Often enough to move, rarely enough not to be a write per file. */
const PROGRESS_EVERY = 10;

/** The same naming as the ZIP, so a client's drive and their download agree. */
function entryName(row: DocumentRow, seen: Map<string, number>): string {
  const date = (row.documentDate ?? row.receivedAt).toISOString().slice(0, 10);
  const supplier = safeEntryName(row.supplierName ?? 'Document', 'Document');
  const extension = extensionFor(row.mimeType);
  const stem = `${date} ${supplier}`;
  const count = (seen.get(stem) ?? 0) + 1;
  seen.set(stem, count);
  return count === 1 ? `${stem}${extension}` : `${stem} (${count})${extension}`;
}

/** Never a stack trace: this sentence reaches a client's portal. */
function readable(error: unknown): string {
  return error instanceof Error ? error.message : 'The drive could not be reached.';
}
