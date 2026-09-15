import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import type { LedgerAdapter, LedgerPublishResult, PublishBillRequest } from '../ledger-adapter.js';
import { type DocumentBytes, prepareAttachment } from './attachment.js';
import { freeAgentLedger } from './freeagent.js';
import { LedgerApiError, VendorApi } from './ledger-http.js';
import { quickBooksLedger } from './quickbooks.js';
import { LEDGER_LIST_KINDS, readReferenceList, type ReferenceItem } from './reference-sync.js';
import { sageLedger } from './sage.js';
import { LedgerConnectionUnavailable, LedgerTokenStore } from './token-store.js';
import { failed, type PublishContext, type VendorLedger } from './vendor-ledger.js';
import type { VendorSlug } from './vendors.js';
import { xeroLedger } from './xero.js';

/**
 * The real `LedgerAdapter` — one implementation, four ledgers (D50).
 *
 * It is a ROUTER, and that is why `LedgerAdapter` did not have to change: the
 * interface takes one bill and a target, the target already carries the vendor's
 * `kind`, and everything that differs between Xero and FreeAgent is behind
 * {@link VendorLedger}. `selectLedgerAdapter(env)` picks this or the demo one,
 * and no call site knows the difference.
 *
 * ## What happens per bill, in order, and why that order
 *
 * 1. **Tokens**, refreshed if due. Per item rather than per batch, because
 *    Sage's access token lasts about five minutes and a 500-item batch outlives
 *    several of them.
 * 2. **Reference lists**, read from `reference_syncs` in one short transaction.
 * 3. **The attachment**, fetched and downscaled — outside every transaction,
 *    because it is megabytes and a bucket round trip.
 * 4. **The vendor call.** Outside every transaction, which is the rule this
 *    whole lane exists under.
 * 5. **Health**, written in its own short transaction.
 *
 * ## ⚠ A per-item failure is a RESULT, not a throw
 *
 * Forty items where item 12 is rejected must publish the other 39. Everything
 * reachable here returns a {@link LedgerPublishResult}; the only throw left is
 * the world being broken — no credentials configured, no connection row — which
 * is the case the interface reserves it for.
 */

const LEDGERS: Readonly<Record<VendorSlug, VendorLedger>> = {
  xero: xeroLedger,
  quickbooks: quickBooksLedger,
  sage: sageLedger,
  freeagent: freeAgentLedger,
};

export class HttpLedgerAdapter implements LedgerAdapter {
  private readonly logger = new Logger(HttpLedgerAdapter.name);

  constructor(
    private readonly prisma: PrismaClient,
    /** The approver's own context. Every read and write below runs under RLS. */
    private readonly ctx: ScopeContext,
    private readonly tokens: LedgerTokenStore,
    private readonly readDocument: DocumentBytes,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async publishBill(request: PublishBillRequest): Promise<LedgerPublishResult> {
    const integrationId = request.target.integrationId;

    let connection;
    try {
      connection = await this.tokens.connection(integrationId);
    } catch (error) {
      if (error instanceof LedgerConnectionUnavailable) {
        // ⚠ NOT a throw. A connection that has been revoked at the vendor is
        // the single most likely real-world failure, and it must land on the
        // Rejected surface with a sentence a practice can act on rather than
        // taking the other 39 items of the batch down with it.
        return failed(`${error.message}. Reconnect it from the client's Connections screen, then publish again.`, false);
      }
      if (error instanceof Error) return failed(error.message, false);
      throw error;
    }

    const ledger = LEDGERS[connection.vendor.slug];
    const api = new VendorApi(connection, this.fetchImpl);

    // One short transaction for everything the database has to say about this
    // item — the lists and the idempotency key, read together so they cannot
    // see two different moments.
    const stored = await scopedDb(this.prisma, this.ctx, async (db) => {
      const [accounts, suppliers, taxRates, bankAccounts, publish] = await Promise.all([
        readReferenceList(db, integrationId, LEDGER_LIST_KINDS.accounts),
        readReferenceList(db, integrationId, LEDGER_LIST_KINDS.suppliers),
        readReferenceList(db, integrationId, LEDGER_LIST_KINDS.taxRates),
        readReferenceList(db, integrationId, LEDGER_LIST_KINDS.bankAccounts),
        db.publish.findFirst({
          where: { documentId: request.documentId, state: 'QUEUED' },
          orderBy: { createdAt: 'desc' },
          select: { idempotencyKey: true },
        }),
      ]);
      return { accounts, suppliers, taxRates, bankAccounts, idempotencyKey: publish?.idempotencyKey ?? null };
    });

    if (stored.accounts === null) {
      return failed(
        `This client's ${connection.vendor.label} accounts have not been synced yet, so there is nothing to code this document against. Open the client's Connections screen and press Sync.`,
        // Retryable: a sync is exactly what would make a fresh attempt work.
        true,
      );
    }

    const context: PublishContext = {
      api,
      connection,
      request,
      attachment: await prepareAttachment(request.attachment, connection.vendor, this.readDocument),
      accounts: stored.accounts.items,
      suppliers: items(stored.suppliers),
      taxRates: items(stored.taxRates),
      bankAccounts: items(stored.bankAccounts),
      docNumber: docNumber(stored.idempotencyKey ?? `${request.documentId}:${request.attempt}`),
    };

    if (!context.attachment.ok) {
      // Logged rather than silent: `attachmentSent: false` on the row says THAT
      // it did not travel, and this says why, which is what a support question
      // about a missing receipt actually needs.
      this.logger.warn(`document ${request.documentId}: no attachment will travel — ${context.attachment.reason}`);
    }

    let result: LedgerPublishResult;
    try {
      // ⚠ THE VENDOR CALL. Outside every transaction, by construction.
      result = await ledger.publish(context);
    } catch (error) {
      // A vendor module that threw anyway. Caught here rather than allowed to
      // kill the batch — the contract is explicit that only the world being
      // broken may throw, and a bug in one adapter is not that.
      this.logger.error(
        `document ${request.documentId}: ${connection.vendor.label} adapter threw — ${error instanceof Error ? error.message : String(error)}`,
      );
      result =
        error instanceof LedgerApiError
          ? failed(error.message, error.retryable)
          : failed(`${connection.vendor.label} could not complete this transaction.`, true);
    }

    // Health, in its own short transaction, after everything.
    if (result.ok) {
      await this.tokens.markHealthy(integrationId);
    } else if (!result.failure.retryable) {
      await this.tokens.markUnhealthy(integrationId, result.failure.message);
    }
    return result;
  }
}

function items(list: { readonly items: readonly ReferenceItem[] } | null): readonly ReferenceItem[] {
  return list?.items ?? [];
}

/**
 * The per-vendor duplicate guard, derived from `publishes.idempotency_key`.
 *
 * ⚠ **It must be SHORT, STABLE and UNIQUE, in that order of difficulty.**
 * QuickBooks caps `DocNumber` at 21 characters and it is the only duplicate
 * guard that platform has; Xero's `InvoiceNumber` is what outlives its
 * six-minute idempotency window. The source is `<proposalId>:<documentId>`,
 * which is already globally unique and already stable across a retry of the
 * same approval — hashing it keeps both properties and makes it fit.
 *
 * Base36 of the first 8 bytes of a SHA-256: 13 characters, plus a `NT-` prefix
 * so a bookkeeper looking at a strange number in their ledger can search for
 * where it came from.
 */
export function docNumber(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest();
  return `NT-${BigInt(`0x${digest.subarray(0, 8).toString('hex')}`).toString(36).toUpperCase().padStart(13, '0')}`;
}
