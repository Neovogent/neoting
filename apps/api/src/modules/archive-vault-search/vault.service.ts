import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Document as DocumentRow, Prisma } from '@prisma/client';
import type { IntegrationKind } from '@prisma/client';

import type { PortalVault, VaultDestination, VaultExport } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { safeEntryName, type ZipEntry } from '../../common/zip/store-zip.js';
import { assertMayUseVault, mayUseVault } from '../billing/index.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import { type PortalSessionFacts, portalVisibleDocuments, systemScopeFor } from '../portal/index.js';
import { driveFor } from './drive-vendors.js';
import type { VaultExportRunner } from './vault-export.runner.js';

/**
 * The Document Vault add-on (D51) — a client's own documents, in their own
 * portal, searchable, downloadable and copyable to a drive they connect.
 *
 * ## ⚠ The set of documents is the PORTAL'S predicate, imported, not restated
 *
 * `portalVisibleDocuments` is on `modules/portal`'s public seam precisely so a
 * second surface cannot come to disagree with the list a client browses. Every
 * read here goes through it, which means:
 *
 * - the archive can never contain a document the portal list would not show;
 * - an accountant who deletes or archives a document has taken it out of the
 *   list, the download AND the Drive copy with one edit;
 * - the tenancy story is the one already written out at length in
 *   `portal-documents.service.ts` — the SYSTEM scope can see the practice, and
 *   the only thing narrowing it to one client is `facts.businessId`, which no
 *   caller supplies and no parameter carries.
 *
 * ## ⚠ What the add-on gates, and what it must never gate
 *
 * The add-on buys the Vault surface, the ZIP and the Drive copy. It does NOT
 * gate the document list, the search, or a client's ability to open one
 * document — those existed before it and taking them away would be selling
 * somebody their own paperwork back. `assertMayUseVault` therefore guards
 * exactly three methods, and `searchable` guards none.
 */
@Injectable()
export class VaultService {
  private readonly logger = new Logger(VaultService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    /**
     * Optional so a unit test can build the service without a drive stack.
     * ⚠ Absent means an export is created and never driven, which is exactly
     * the defect this argument was added to fix — so the composition root must
     * always pass one.
     */
    private readonly runner?: VaultExportRunner,
  ) {}

  /**
   * What the Vault tab renders itself from, for `PortalContext`.
   *
   * ⚠ Returns a shape with `active: false` rather than null when the add-on is
   * off. "Not bought" and "not loaded" must be distinguishable, or the tab
   * renders a spinner forever for every client who has not subscribed.
   */
  async vaultState(facts: PortalSessionFacts): Promise<PortalVault> {
    const businessId = facts.businessId;

    const [business, integrations, latest] = await scopedDb(this.prisma, systemScopeFor(facts), async (db) => [
      await db.business.findFirst({
        where: { id: businessId },
        select: { subscriptionStatus: true, vaultAddon: true },
      }),
      await db.integration.findMany({
        where: { businessId, kind: { in: DRIVE_KINDS }, isActive: true },
        select: { kind: true, health: true, orgName: true },
      }),
      await db.vaultExport.findFirst({ where: { businessId }, orderBy: { createdAt: 'desc' } }),
    ]);

    // A session whose business row is unreadable is a session that should not
    // have resolved. Answering "no vault" would render the buy-it offer to
    // somebody whose workspace we cannot see, so it refuses instead.
    if (business === null) {
      throw new AppException('NT-OTP-002', HttpStatus.UNAUTHORIZED, 'Not a session for this', 'No such workspace.');
    }

    const destinations: VaultDestination[] = integrations.flatMap((row) => {
      const drive = driveFor(row.kind);
      if (drive === null) return [];
      return [
        {
          kind: row.kind,
          label: drive.label,
          // ⚠ Anything that is not OK is not healthy. `health` has more values
          // than two and a `=== 'ERROR'` test would call an unknown one fine.
          healthy: row.health === 'OK',
          connectedAccount: row.orgName,
        },
      ];
    });

    return {
      active: mayUseVault(business),
      destinations,
      latestExport: latest === null ? null : toVaultExport(latest),
    };
  }

  /**
   * Every document this client has, as ZIP entries, newest first.
   *
   * ⚠ **An async generator, and that is the memory story.** It yields one
   * document at a time: the controller pipes each entry into the archive and
   * the archive into the response, so a client with four hundred receipts costs
   * one document of memory rather than four hundred. Assembling a list first
   * would typecheck identically and fall over on the first real client.
   *
   * ⚠ **A document whose bytes cannot be read is SKIPPED, loudly logged, and
   * does not fail the download.** One unreadable object out of four hundred
   * must not deny a client the other three hundred and ninety-nine — the same
   * judgement `PARTIAL` encodes for the Drive copy.
   */
  async *archiveEntries(facts: PortalSessionFacts): AsyncGenerator<ZipEntry> {
    const rows = await this.documentsFor(facts);
    const seen = new Map<string, number>();
    const missing: string[] = [];
    let sent = 0;

    for (const row of rows) {
      if (row.s3Key === null) {
        missing.push(this.entryName(row, seen));
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await this.store.get(row.s3Key);
      } catch (error) {
        this.logger.warn(
          `vault archive skipped document ${row.id}: ${error instanceof Error ? error.message : 'unreadable'}`,
        );
        missing.push(this.entryName(row, seen));
        continue;
      }
      sent += 1;
      yield { name: this.entryName(row, seen), bytes, modifiedAt: row.receivedAt };
    }

    // ⚠ A PARTIAL ARCHIVE SAYS SO, INSIDE ITSELF.
    //
    // The headers went out before the first document was read, so a failure
    // part-way through cannot become a status code — and silently handing a
    // client fourteen of their fifteen documents is the shape this lane keeps
    // producing: plausible, quiet, wrong. The note is the only channel left
    // once the response has started, and `POST /v1/exports`'s own
    // `HOW-TO-IMPORT.txt` is the precedent for putting words in the archive.
    //
    // It is NOT written when nothing was missing — a file explaining that
    // nothing went wrong is noise in every archive that is fine.
    if (missing.length > 0) {
      yield {
        name: 'MISSING-DOCUMENTS.txt',
        bytes: Buffer.from(missingNote(sent, missing), 'utf8'),
      };
    }
  }

  /**
   * Refuse the download BEFORE a byte of it is written, when nothing in it
   * could be read.
   *
   * ⚠ **This exists because the alternative shipped and was invisible.** Driven
   * locally on 21 Sep 2026 the archive came back as 22 bytes — a perfectly valid
   * ZIP holding nothing — because every object was missing from storage. Fifteen
   * warnings in the log, a file on the client's disk, and nothing anywhere
   * telling them. The owner ruled on 23 Sep 2026 that it should refuse loudly.
   *
   * It probes the FIRST document only, and the ceiling is stated rather than
   * discovered: reading all of them here would mean fetching the whole archive
   * twice. What this catches is the real case — object storage unreachable,
   * misconfigured, or a bucket whose contents never existed — which fails on
   * the first read as surely as on the fortieth. A store that serves document
   * one and refuses the rest still produces a partial archive, and that is what
   * `MISSING-DOCUMENTS.txt` is for.
   *
   * ⚠ **A client with NO documents is not an error.** They get a valid empty
   * archive and always did: a new client pressing Download has done nothing
   * wrong, and refusing them would be the opposite mistake.
   *
   * ponytail: probes one document. If a partial-store failure ever matters more
   * than the second full read costs, probe every key with a HEAD rather than a
   * GET — `DocumentStore` would need one.
   */
  async assertArchiveReadable(facts: PortalSessionFacts): Promise<void> {
    const rows = await this.documentsFor(facts);
    const first = rows.find((row) => row.s3Key !== null);
    if (first?.s3Key == null) return;

    try {
      await this.store.get(first.s3Key);
    } catch (error) {
      this.logger.error(
        `vault archive refused for business ${facts.businessId}: the store could not serve ${first.s3Key} — ${
          error instanceof Error ? error.message : 'unreadable'
        }`,
      );
      throw new AppException(
        'NT-SRV-001',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Your documents could not be read',
        'We could not read your documents from storage, so the download was stopped rather than handing you an empty file. Nothing is lost — please try again shortly, and tell your accountant if it keeps happening.',
      );
    }
  }

  /** `listVaultExports` — this client's copy-to-Drive runs, newest first. */
  async listExports(facts: PortalSessionFacts, query: { limit: number; cursor?: string }): Promise<Page<VaultExport>> {
    await this.assertEntitled(facts);
    const businessId = this.businessOf(facts);

    const request: PageRequest<VaultExportRow> = {
      sort: CREATED_AT,
      order: 'desc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      query: { businessId, limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);
    const rows = await scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.vaultExport.findMany({
        where: seek.where === undefined ? { businessId } : { AND: [{ businessId }, seek.where] },
        orderBy: seek.orderBy as Prisma.VaultExportOrderByWithRelationInput[],
        take: seek.take,
      }),
    );
    const page = toPage(rows as VaultExportRow[], request);
    return { data: page.data.map(toVaultExport), pageInfo: page.pageInfo };
  }

  /**
   * `createVaultExport` — start a copy into the client's connected drive.
   *
   * ⚠ **One run at a time per business, and the existing one is RETURNED rather
   * than refused.** A client who double-presses must not get two copies of
   * every document in their drive, and a 409 for their own second press reads
   * as a broken button. Returning the run in flight is the same answer the
   * first press got.
   */
  async createExport(facts: PortalSessionFacts, kind: IntegrationKind): Promise<VaultExport> {
    await this.assertEntitled(facts);
    const businessId = this.businessOf(facts);

    const drive = driveFor(kind);
    if (drive === null) {
      throw new AppException(
        'NT-INT-001',
        HttpStatus.CONFLICT,
        'Not a cloud drive',
        'That destination is not a cloud drive the vault can copy to.',
      );
    }

    const { run, started } = await scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const connection = await db.integration.findFirst({
        where: { businessId, kind, isActive: true },
        select: { id: true, tokenRef: true },
      });
      if (connection === null || connection.tokenRef === null) {
        throw new AppException(
          'NT-INT-001',
          HttpStatus.CONFLICT,
          'No drive connected',
          `No ${drive.label} is connected for this business. Connect one from the Vault tab first.`,
        );
      }

      const running = await db.vaultExport.findFirst({
        where: { businessId, state: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { createdAt: 'desc' },
      });
      // Already in flight: hand back the same run rather than starting a second.
      if (running !== null) return { run: toVaultExport(running), started: false };

      const documentCount = await db.document.count({ where: portalVisibleDocuments(facts) });
      const created = await db.vaultExport.create({ data: { businessId, kind, documentCount } });
      return { run: toVaultExport(created), started: true };
    });

    // ⚠ DRIVEN HERE, AFTER THE ROW IS COMMITTED, AND DELIBERATELY NOT AWAITED.
    //
    // Without this the button worked, the row was written QUEUED, and NOTHING
    // ever ran it — the client watched "Waiting to start…" forever. Found on
    // 23 Sep 2026 by pressing it, which is the only way it could have been
    // found: every test passed and the row is exactly what the contract says.
    //
    // Not awaited because copying hundreds of files is minutes and the caller
    // is a phone waiting on a 202. Not lost if this process dies, because the
    // work list is the QUEUED rows themselves — the same re-drivable shape the
    // ledger's follow-up uses, and the same reason moving it to BullMQ later is
    // a worker change with no call-site change.
    if (started && this.runner !== undefined) {
      const ctx = systemScopeFor(facts);
      const documents = await this.documentsFor(facts);
      void this.runner
        .run(ctx, run.id, businessId, documents)
        .catch((error: unknown) =>
          this.logger.error(
            `vault export ${run.id} failed outside its own handler: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          ),
        );
    }

    return run;
  }

  /**
   * The add-on gate for the archive download.
   *
   * ⚠ Public and called SEPARATELY by the controller, because `archiveEntries`
   * is an async generator: its body does not run until the first `next()`, so a
   * `throw` inside it would happen AFTER the 200 and the ZIP headers had already
   * gone out — a payment refusal arriving as a corrupt download. The gate has to
   * be awaited before a single header is written.
   */
  async assertEntitledForArchive(facts: PortalSessionFacts): Promise<void> {
    await this.assertEntitled(facts);
  }

  /** The documents an archive or a copy covers — newest first, one predicate. */
  private async documentsFor(facts: PortalSessionFacts): Promise<DocumentRow[]> {
    return scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.document.findMany({ where: portalVisibleDocuments(facts), orderBy: { receivedAt: 'desc' } }),
    );
  }

  /**
   * A filename a human recognises, unique within the archive.
   *
   * ⚠ Two receipts from the same supplier on the same day is the NORMAL case,
   * not an edge one — a café twice in a day, a fuel stop each way. Without the
   * counter they would collide, and a ZIP with two identical entry names
   * extracts as one file with the other silently gone.
   */
  private entryName(row: DocumentRow, seen: Map<string, number>): string {
    const date = (row.documentDate ?? row.receivedAt).toISOString().slice(0, 10);
    const supplier = safeEntryName(row.supplierName ?? 'Document', 'Document');
    const extension = extensionFor(row.mimeType);
    const stem = `${date} ${supplier}`;
    const count = (seen.get(stem) ?? 0) + 1;
    seen.set(stem, count);
    return count === 1 ? `${stem}${extension}` : `${stem} (${count})${extension}`;
  }

  /** The session's own business. Non-nullable on the facts, which take it from the row. */
  private businessOf(facts: PortalSessionFacts): string {
    return facts.businessId;
  }

  /** The add-on gate. Read through the same `billing` seam every other entitlement check uses. */
  private async assertEntitled(facts: PortalSessionFacts): Promise<void> {
    const businessId = this.businessOf(facts);
    const business = await scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.business.findFirst({
        where: { id: businessId },
        select: { subscriptionStatus: true, vaultAddon: true },
      }),
    );
    if (business === null) {
      throw new AppException('NT-OTP-002', HttpStatus.UNAUTHORIZED, 'Not a session for this', 'No such workspace.');
    }
    assertMayUseVault(business);
  }
}

/**
 * What goes in `MISSING-DOCUMENTS.txt`.
 *
 * Plain English and no jargon: this is read by a client, not by us. It names
 * the count first because that is the question ("did I get everything?"), then
 * the documents, then what to do — which is tell their accountant, because
 * there is nothing they can do about a missing object themselves.
 */
export function missingNote(sent: number, missing: readonly string[]): string {
  const lines = [
    'Some of your documents could not be included in this download.',
    '',
    `Included: ${sent}`,
    `Could not be read: ${missing.length}`,
    '',
    'The ones missing from this ZIP are:',
    ...missing.map((name) => `  - ${name}`),
    '',
    'Nothing has been deleted — these documents are still in your portal, and',
    'your accountant still has them. Please let them know you saw this note.',
    '',
  ];
  // CRLF, not LF: this is a .txt inside a ZIP, and the reader most likely to
  // open it is Windows Notepad, which renders a lone LF as one long line.
  return lines.join('\r\n');
}

/** The drive kinds, as the one list this module filters `integrations` by. */
const DRIVE_KINDS: IntegrationKind[] = ['GOOGLE_DRIVE', 'ONEDRIVE'];

type VaultExportRow = Awaited<ReturnType<PrismaClient['vaultExport']['findFirstOrThrow']>>;

/** `createdAt` is NOT NULL, so it is the non-nullable sort field — see `common/pagination/cursor.ts`. */
const CREATED_AT = dateField<VaultExportRow>('createdAt', (row) => row.createdAt, false);

/**
 * Row → the client-facing projection.
 *
 * ⚠ `failureMessage` travels VERBATIM and is never substituted. A FAILED run
 * with no message is a bug, not a state — the same rule `publish-projection.ts`
 * carries — so the null is served and the defect shows up where a human sees it
 * rather than behind an invented sentence.
 */
export function toVaultExport(row: VaultExportRow): VaultExport {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    documentCount: row.documentCount,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    folderName: row.folderName,
    failureMessage: row.failureMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The file extension for a stored document.
 *
 * ⚠ Derived from the MIME type we recorded at intake, NEVER from a filename a
 * client supplied. The original name is untrusted input and its extension is
 * the part most worth not trusting.
 */
export function extensionFor(mimeType: string | null): string {
  switch (mimeType) {
    case 'application/pdf':
      return '.pdf';
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/heic':
      return '.heic';
    case 'image/webp':
      return '.webp';
    default:
      // No extension rather than a guessed one. An operating system opening a
      // `.pdf` that is a JPEG is worse than one asking what to open.
      return '';
  }
}
