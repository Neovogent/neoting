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

    for (const row of rows) {
      if (row.s3Key === null) continue;
      let bytes: Buffer;
      try {
        bytes = await this.store.get(row.s3Key);
      } catch (error) {
        this.logger.warn(
          `vault archive skipped document ${row.id}: ${error instanceof Error ? error.message : 'unreadable'}`,
        );
        continue;
      }
      yield { name: this.entryName(row, seen), bytes, modifiedAt: row.receivedAt };
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

    return scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
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
      if (running !== null) return toVaultExport(running);

      const documentCount = await db.document.count({ where: portalVisibleDocuments(facts) });
      const created = await db.vaultExport.create({ data: { businessId, kind, documentCount } });
      return toVaultExport(created);
    });
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
