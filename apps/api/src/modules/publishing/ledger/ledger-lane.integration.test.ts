import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import type { PublishBillRequest } from '../ledger-adapter.js';
import { HttpLedgerAdapter } from './http-ledger-adapter.js';
import { LedgerConnectionsService } from './ledger-connections.service.js';
import { type LedgerEnv, vendorConfigForKind } from './ledger-config.js';
import { signState } from '../../../common/oauth/oauth.js';
import { LEDGER_LIST_KINDS, readReferenceList } from './reference-sync.js';
import { LedgerTokenStore } from './token-store.js';
import { parseVaultKey, seal, unseal } from '../../../common/oauth/token-vault.js';

/**
 * The whole ledger lane, against a REAL database and a REAL HTTP vendor
 * (D50) — connect, sync, publish, attach, rotate, revoke.
 *
 * ## ⚠ What this proves, and the one thing it does not
 *
 * The stand-in server speaks FreeAgent's shapes over a real socket, so every
 * line of the shared layer and the adapter is exercised for real: the token
 * exchange, the sealed vault, the `orgRef` probe, reference sync, the
 * conditional rotation write, the money boundary, the attachment, the read-back,
 * and the four failure paths the brief asks to be broken on purpose.
 *
 * **It does not prove FreeAgent accepts our JSON.** Only FreeAgent can answer
 * that, and only through a consent journey that needs a human with a sandbox
 * password. This file is the repeatable half; the vendor screenshot is the other
 * half, and neither substitutes for the other. Saying so here rather than
 * letting a green suite imply otherwise is the point — the same reason
 * `attachmentSent` is a field rather than an assumption.
 *
 * ⚠ Ids are prefixed `led_` — a stem no other suite in this repo shares, in
 * either direction, because Prisma compiles `startsWith` to an UNESCAPED `LIKE`
 * and `_` is a single-character wildcard there (the hazard `vitest.config.ts`
 * documents).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const PRACTICE = 'led_prac';
const BIZ = 'led_biz';
const USER = 'led_user';
const VAULT_KEY = parseVaultKey('c'.repeat(64));

let owner: PrismaClient;
let app: PrismaClient;
let server: Server;
let base = '';

/** What the stand-in was asked, so a test can assert on the request as well as the answer. */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly auth: string | undefined;
}
let seen: Seen[] = [];

/** Knobs a test turns to make the vendor behave badly on purpose. */
const vendor = {
  /** Which refresh token the vendor currently considers live. Rotation replaces it. */
  liveRefresh: 'refresh-1',
  /** Set to make every token call answer `invalid_grant` — a revoked connection. */
  revoked: false,
  /** Set to make `POST /bills` refuse. */
  refuseBill: null as null | { status: number; body: unknown },
  /** Set to make the bill come back with a recalculated total. */
  returnTotal: null as null | string,
  rotations: 0,
};

function reset(): void {
  seen = [];
  vendor.liveRefresh = 'refresh-1';
  vendor.revoked = false;
  vendor.refuseBill = null;
  vendor.returnTotal = null;
  vendor.rotations = 0;
}

/** FreeAgent's shapes, over a real socket. Money is decimal STRINGS, as it is there. */
function standIn(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      let body: unknown = raw;
      try {
        body = raw === '' ? null : raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        /* keep the raw text */
      }
      seen.push({ method: req.method ?? 'GET', path, body, auth: req.headers.authorization });

      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (path === '/v2/token_endpoint') {
        const form = body as Record<string, string>;
        if (vendor.revoked) return json(400, { error: 'invalid_grant', error_description: 'revoked' });
        if (form['grant_type'] === 'refresh_token' && form['refresh_token'] !== vendor.liveRefresh) {
          // ⚠ The rotation trap, faithfully: a retired refresh token is dead.
          return json(400, { error: 'invalid_grant', error_description: 'already used' });
        }
        if (form['grant_type'] === 'refresh_token') {
          vendor.rotations += 1;
          vendor.liveRefresh = `refresh-${vendor.rotations + 1}`;
        }
        return json(200, {
          access_token: `access-${vendor.rotations}`,
          refresh_token: vendor.liveRefresh,
          expires_in: 3600,
          token_type: 'bearer',
        });
      }

      if (path === '/v2/company') return json(200, { company: { url: `${base}/v2/company`, name: 'Stand-in Ltd' } });

      if (path === '/v2/categories') {
        return json(200, {
          admin_expenses_categories: [
            { url: `${base}/v2/categories/285`, description: 'Motor Vehicle Expenses', nominal_code: '285' },
            { url: `${base}/v2/categories/429`, description: 'General Expenses', nominal_code: '429' },
          ],
        });
      }

      if (path === '/v2/contacts' && req.method === 'GET') {
        return json(200, { contacts: [{ url: `${base}/v2/contacts/9`, organisation_name: 'Bidfood', status: 'Active' }] });
      }
      if (path === '/v2/contacts' && req.method === 'POST') {
        return json(201, { contact: { url: `${base}/v2/contacts/99`, organisation_name: 'New Supplier' } });
      }
      if (path === '/v2/bank_accounts') return json(200, { bank_accounts: [] });

      if (vendor.revoked && path !== '/v2/token_endpoint') {
        // A revoked connection whose access token has not yet expired meets
        // THIS, not the refresh refusal — and it is the likelier of the two.
        return json(401, { errors: { error: { message: 'Access denied' } } });
      }

      if (path === '/v2/bills' && req.method === 'POST') {
        if (vendor.refuseBill !== null) return json(vendor.refuseBill.status, vendor.refuseBill.body);
        const sent = (body as { bill: Record<string, unknown> }).bill;
        return json(201, {
          bill: {
            url: `${base}/v2/bills/1001`,
            reference: sent['reference'],
            total_value: vendor.returnTotal ?? sent['total_value'],
            sales_tax_value: sent['sales_tax_value'],
            attachment: sent['attachment'] === undefined ? null : { url: `${base}/v2/attachments/7` },
          },
        });
      }

      json(404, { errors: { error: { message: 'no such stand-in route' } } });
    });
  });
}

function env(): LedgerEnv {
  return {
    LEDGER_ADAPTER: 'http',
    LEDGER_SANDBOX: true,
    INTEGRATION_TOKEN_KEY: 'c'.repeat(64),
    XERO_CLIENT_ID: '',
    XERO_CLIENT_SECRET: '',
    XERO_REDIRECT_URI: '',
    QBO_CLIENT_ID: '',
    QBO_CLIENT_SECRET: '',
    QBO_REDIRECT_URI: '',
    SAGE_CLIENT_ID: '',
    SAGE_CLIENT_SECRET: '',
    SAGE_REDIRECT_URI: '',
    FREEAGENT_CLIENT_ID: 'stand-in-client',
    FREEAGENT_CLIENT_SECRET: 'stand-in-secret',
    FREEAGENT_REDIRECT_URI: 'http://localhost:3000/v1/integrations/freeagent/callback',
  };
}

/**
 * The service, pointed at the stand-in.
 *
 * ⚠ The host swap is done by REWRITING the request URL in a `fetch` wrapper
 * rather than by adding a base-URL environment variable. A production knob that
 * repoints a vendor exists only for tests and is exactly how a staging
 * deployment ends up talking to something that is not Xero.
 */
/**
 * The vendor config this suite's store resolves.
 *
 * ⚠ It goes through `vendorConfigForKind(env(), …)` rather than `vendorForKind`
 * for the reason the production code does: the second returns the STATIC config
 * and therefore the production host, which is the bug this argument exists to
 * make impossible (20 Sep 2026).
 */
const STANDIN_VENDOR = (kind: Parameters<typeof vendorConfigForKind>[1]) => vendorConfigForKind(env(), kind);

function toStandIn(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return fetch(url.replace('https://api.sandbox.freeagent.com', base).replace('https://api.freeagent.com', base), init);
  };
}

function service(): LedgerConnectionsService {
  return new LedgerConnectionsService(app, env(), toStandIn());
}

/**
 * ⚠ **A HUMAN super admin, not a SYSTEM actor, and the first draft of this file
 * got it wrong in a way worth recording.**
 *
 * `completeCallback` calls `assertCan(actor, 'business.integrations.manage')`,
 * which is `mayRelease` — the release role AND the ownership flag (D44's
 * predicate, applied one step earlier because connecting is what decides
 * whether a later Approve reaches real books). A machine actor is
 * `PRACTICE_STANDARD` by construction (`resolve-system-actor.ts`: *"a machine
 * that could release would be a machine that could publish"*), so it can never
 * satisfy it — which is right, and means a connection can only ever be made by
 * a person.
 */
const CTX = ScopeContextSchema.parse({ actorId: USER, practiceId: PRACTICE });

/** The sentence a practice actually reads off a refusal. */
async function detailOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(did not throw)';
  } catch (error) {
    const detail = (error as { publicDetail?: unknown }).publicDetail;
    return typeof detail === 'string' ? detail : String((error as Error).message);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  server = standIn();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'Ledger lane' } });
  await owner.business.create({ data: { id: BIZ, practiceId: PRACTICE, name: 'Ledger lane client' } });
  await owner.user.create({
    data: { id: USER, kind: 'HUMAN', email: 'led@example.test', firstName: 'Lead', lastName: 'Ger', emailVerified: true },
  });
  // ⚠ `isOwner` is load-bearing: connecting a client's books requires the
  // firm's super admin. Without it every connect in this suite refuses
  // `NT-PRM-001`, which is the gate working rather than the fixture being fussy.
  await owner.membership.create({
    data: { id: 'led_mem', userId: USER, practiceId: PRACTICE, role: 'PRACTICE_ADMIN', isOwner: true },
  });
});

beforeEach(async () => {
  if (!enabled) return;
  reset();
  await owner.referenceSync.deleteMany({ where: { integration: { businessId: BIZ } } });
  await owner.publish.deleteMany({ where: { businessId: BIZ } });
  await owner.integration.deleteMany({ where: { businessId: BIZ } });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await owner?.$disconnect();
  await app?.$disconnect();
});

async function cleanup(): Promise<void> {
  await owner.referenceSync.deleteMany({ where: { integration: { businessId: BIZ } } });
  await owner.publish.deleteMany({ where: { businessId: BIZ } });
  await owner.integration.deleteMany({ where: { businessId: BIZ } });
  await owner.membership.deleteMany({ where: { userId: USER } });
  await owner.user.deleteMany({ where: { id: USER } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: PRACTICE } });
}

/** Complete a consent journey: the callback the vendor redirects to. */
async function connect(): Promise<string> {
  const state = signState({ b: BIZ, v: 'freeagent', a: USER }, VAULT_KEY);
  const done = await service().completeCallback(CTX, 'freeagent', { state, code: 'auth-code-1' });
  return done.integrationId;
}

const BILL = (over: Partial<PublishBillRequest> = {}): PublishBillRequest => ({
  documentId: 'led_doc_1',
  attempt: 1,
  target: { integrationId: 'REPLACED', kind: 'FREEAGENT', orgRef: null },
  supplierName: 'Bidfood',
  categoryCode: '285',
  currency: 'GBP',
  // £412.66 gross, £68.78 VAT — the demo's own figures, to the penny.
  totalPence: 41_266,
  taxPence: 6_878,
  documentDate: '2026-08-14',
  reference: 'INV-9001',
  attachment: { s3Key: 'w/led/doc_1', filename: 'receipt.jpg', mimeType: 'image/jpeg' },
  ...over,
});

/** A tiny real JPEG, so `sharp` has something it can genuinely decode. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

function adapter(read: (key: string) => Promise<Buffer> = async () => TINY_JPEG): HttpLedgerAdapter {
  return new HttpLedgerAdapter(
    app,
    CTX,
    new LedgerTokenStore(app, CTX, VAULT_KEY, () => ({
      clientId: 'stand-in-client',
      clientSecret: 'stand-in-secret',
      redirectUri: 'http://localhost:3000/v1/integrations/freeagent/callback',
    }), STANDIN_VENDOR, toStandIn()),
    read,
    toStandIn(),
  );
}

describe.runIf(enabled)('the ledger lane, end to end', () => {
  test('a consent journey stores a SEALED connection and syncs the client’s own lists', async () => {
    const integrationId = await connect();

    const row = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(row.kind).toBe('FREEAGENT');
    expect(row.health).toBe('OK');
    expect(row.isActive).toBe(true);
    expect(row.orgRef).toBe(`${base}/v2/company`);

    // ⚠ THE TOKEN IS NOT READABLE IN THE ROW. This is the whole point of the
    // vault: a database dump is worthless without the platform key.
    expect(row.tokenRef).not.toBeNull();
    expect(row.tokenRef).not.toContain('refresh-1');
    expect(row.tokenRef).not.toContain('access-0');
    expect(unseal(row.tokenRef ?? '', VAULT_KEY).refreshToken).toBe('refresh-1');

    // The first sync ran at connect, so the practice does not meet "no accounts
    // synced" on their first approval.
    const accounts = await scopedDb(app, CTX, (db) => readReferenceList(db, integrationId, LEDGER_LIST_KINDS.accounts));
    expect(accounts?.items.map((a) => a.code)).toEqual(['285', '429']);
    const suppliers = await scopedDb(app, CTX, (db) => readReferenceList(db, integrationId, LEDGER_LIST_KINDS.suppliers));
    expect(suppliers?.items.map((s) => s.name)).toEqual(['Bidfood']);
  });

  test('an approved document becomes a bill with the receipt attached, and the vendor’s reference comes back', async () => {
    const integrationId = await connect();
    const result = await adapter().publishBill({ ...BILL(), target: { integrationId, kind: 'FREEAGENT', orgRef: null } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.externalRef).toBe(`${base}/v2/bills/1001`);
    expect(result.attachmentSent).toBe(true);

    const posted = seen.find((s) => s.path === '/v2/bills' && s.method === 'POST');
    const bill = (posted?.body as { bill: Record<string, unknown> }).bill;

    // ⚠ MONEY, TO THE PENNY, AS A STRING, AND INSIDE `bill_items`. Not
    // `41266/100`, which is where a float would have crept in — and not at the
    // top level, which is where this assertion used to look.
    //
    // ⚠ **This test was stale and green-adjacent until 21 Sep 2026.** It still
    // asserted `bill.total_value` / `bill.sales_tax_value` at the TOP level,
    // the shape that produced a real £0.00 bill in FreeAgent's own screen
    // (fixes 915a464 and 62daf0c). Those fixes moved the money into
    // `bill_items[]` — where FreeAgent actually reads it — and did not bring
    // this file with them, so the suite went red on `main` and stayed red.
    // The lesson is the module's own: a top-level `total_value` is ACCEPTED by
    // FreeAgent, returns a bill URL, and is worth nothing.
    const items = bill['bill_items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    // The GROSS on the item, because FreeAgent reads it as tax-inclusive.
    expect(items[0]?.['total_value']).toBe('412.66');
    // …and the rate describes the VAT already inside that figure: 6878 pence of
    // tax on 34388 pence net is 20%, carried as a percentage string.
    expect(items[0]?.['sales_tax_rate']).toBe('20.0');
    expect(bill['dated_on']).toBe('2026-08-14');
    expect(bill['reference']).toBe('INV-9001');
    // The supplier already existed in the synced list, so no duplicate contact
    // was created — the "republishing creates duplicate vendors" failure.
    expect(bill['contact']).toBe(`${base}/v2/contacts/9`);
    expect(seen.filter((s) => s.path === '/v2/contacts' && s.method === 'POST')).toHaveLength(0);
    // The receipt travelled, on the same request.
    expect((bill['attachment'] as Record<string, unknown>)['file_name']).toBe('receipt.jpg');
  });

  test('a category with no counterpart in the client’s chart REFUSES rather than guessing a nominal', async () => {
    const integrationId = await connect();
    const result = await adapter().publishBill({
      ...BILL({ categoryCode: 'NOT-ON-THEIR-CHART' }),
      target: { integrationId, kind: 'FREEAGENT', orgRef: null },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('does not match any account');
    expect(result.failure.retryable).toBe(false);
    // Nothing was posted. A wrong nominal is found at the year end; a refusal is
    // found today.
    expect(seen.filter((s) => s.path === '/v2/bills')).toHaveLength(0);
  });
});

describe.runIf(enabled)('breaking it on purpose', () => {
  test('a ROTATED refresh token is persisted, and the retired one is never used again', async () => {
    const integrationId = await connect();
    const before = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(unseal(before.tokenRef ?? '', VAULT_KEY).refreshToken).toBe('refresh-1');

    const store = new LedgerTokenStore(app, CTX, VAULT_KEY, () => ({
      clientId: 'stand-in-client',
      clientSecret: 'stand-in-secret',
      redirectUri: 'http://localhost:3000/v1/integrations/freeagent/callback',
    }), STANDIN_VENDOR, toStandIn());

    await store.forceRefresh(integrationId);

    // ⚠ THE ASSERTION THIS WHOLE FEATURE TURNS ON. The vendor retired
    // `refresh-1` the moment it was used; if we had failed to persist the new
    // one, the connection would be dead and nothing would have said so.
    const after = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(unseal(after.tokenRef ?? '', VAULT_KEY).refreshToken).toBe('refresh-2');
    expect(after.tokenRef).not.toBe(before.tokenRef);

    // And it is genuinely usable — proving the stored value is the LIVE one and
    // not an orphan. A second refresh from the stored token succeeds; the same
    // call made from the retired token would be `invalid_grant`.
    await store.forceRefresh(integrationId);
    const twice = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(unseal(twice.tokenRef ?? '', VAULT_KEY).refreshToken).toBe('refresh-3');
  });

  test('a STALE write cannot install a retired token over a live one', async () => {
    const integrationId = await connect();
    const stale = (await owner.integration.findUniqueOrThrow({ where: { id: integrationId } })).tokenRef;

    await new LedgerTokenStore(app, CTX, VAULT_KEY, () => ({
      clientId: 'stand-in-client',
      clientSecret: 'stand-in-secret',
      redirectUri: 'http://localhost:3000/v1/integrations/freeagent/callback',
    }), STANDIN_VENDOR, toStandIn()).forceRefresh(integrationId);

    const live = (await owner.integration.findUniqueOrThrow({ where: { id: integrationId } })).tokenRef;
    expect(live).not.toBe(stale);

    // ⚠ **THE OPTIMISTIC-CONCURRENCY GUARANTEE, ASSERTED DIRECTLY.** This is
    // the exact write `doRefresh` makes, issued from a process that read the
    // row before the refresh above. Postgres compares the whole ciphertext, so
    // it matches nothing — which is what stops a second process installing a
    // token the vendor has already retired. The whole safety of rotation rests
    // on this one `where` clause, and nothing else in the suite can see it.
    const clobber = await scopedDb(app, CTX, (db) =>
      db.integration.updateMany({
        where: { id: integrationId, tokenRef: stale },
        data: { tokenRef: 'v1.a.b.c' },
      }),
    );
    expect(clobber.count).toBe(0);
    expect((await owner.integration.findUniqueOrThrow({ where: { id: integrationId } })).tokenRef).toBe(live);
  });

  test('two refreshes racing on one connection leave a token that still WORKS', async () => {
    const integrationId = await connect();
    const credentials = () => ({
      clientId: 'stand-in-client',
      clientSecret: 'stand-in-secret',
      redirectUri: 'http://localhost:3000/v1/integrations/freeagent/callback',
    });
    // Two stores, as two processes would be. Whichever wins, the invariant is
    // the same and it is the one that matters: the stored token is usable.
    const a = new LedgerTokenStore(app, CTX, VAULT_KEY, credentials, STANDIN_VENDOR, toStandIn());
    const b = new LedgerTokenStore(app, CTX, VAULT_KEY, credentials, STANDIN_VENDOR, toStandIn());
    await Promise.allSettled([a.forceRefresh(integrationId), b.forceRefresh(integrationId)]);

    const row = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(unseal(row.tokenRef ?? '', VAULT_KEY).refreshToken).toBe(vendor.liveRefresh);
    // Proof rather than inference: refreshing again from the stored token is
    // exactly what a dead connection could not do.
    await expect(a.forceRefresh(integrationId)).resolves.toBeUndefined();
  });

  test('a connection REVOKED at the vendor fails with a readable reason, not a stack trace', async () => {
    const integrationId = await connect();
    // ⚠ The likelier shape: the access token is still inside its window, so the
    // first thing that discovers the revocation is the API call itself.
    vendor.revoked = true;

    const result = await adapter().publishBill({ ...BILL(), target: { integrationId, kind: 'FREEAGENT', orgRef: null } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/no longer authorised|no longer valid/i);
    // ⚠ NOT retryable. A revoked connection reported as retryable is a queue
    // that never drains and a practice that is never told to reconnect.
    expect(result.failure.retryable).toBe(false);

    // And the connection says so on the screen, before the next batch of forty.
    const row = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(row.health).toBe('ERROR');
    expect(row.lastErrorMessage).toMatch(/reconnect/i);
  });

  test('a connection revoked while its access token is EXPIRED fails at the refresh, equally readably', async () => {
    const integrationId = await connect();
    // ⚠ `tokenExpiresAt` on the row is a PROJECTION for the screen and the
    // sweep; the store reads the expiry out of the sealed blob, which is the
    // only copy that cannot drift from the token it describes. So the blob is
    // what has to be aged, and re-sealing it here is the honest way to do that.
    const row = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    const aged = unseal(row.tokenRef ?? '', VAULT_KEY);
    await owner.integration.update({
      where: { id: integrationId },
      data: { tokenRef: seal({ ...aged, accessExpiresAt: new Date(Date.now() - 60_000).toISOString() }, VAULT_KEY) },
    });
    vendor.revoked = true;

    const result = await adapter().publishBill({ ...BILL(), target: { integrationId, kind: 'FREEAGENT', orgRef: null } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/no longer valid|disconnected or expired/i);
    expect(result.failure.retryable).toBe(false);
  });

  test('one rejected item does not take the batch down: the others publish', async () => {
    const integrationId = await connect();
    const target = { integrationId, kind: 'FREEAGENT' as const, orgRef: null };
    const ledger = adapter();

    const first = await ledger.publishBill({ ...BILL({ documentId: 'led_doc_a' }), target });
    // Item two is refused by the vendor — a real "no", not an outage.
    vendor.refuseBill = { status: 422, body: { errors: { error: { message: 'Dated on is required' } } } };
    const second = await ledger.publishBill({ ...BILL({ documentId: 'led_doc_b' }), target });
    vendor.refuseBill = null;
    const third = await ledger.publishBill({ ...BILL({ documentId: 'led_doc_c' }), target });

    expect(first.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    // A failure with no reason attached is a bug, not a state.
    expect(second.failure.message).not.toBe('');
    expect(second.failure.message).toContain('Dated on is required');
    expect(second.failure.retryable).toBe(false);
  });

  test('an OVERSIZED attachment reports attachmentSent FALSE honestly, and the bill still lands', async () => {
    const integrationId = await connect();
    // ⚠ A PDF, deliberately: it cannot be downscaled without a rasteriser we do
    // not ship, so this is the case where the honest answer is the only answer.
    // FreeAgent's cap is 5 MB — the tightest of the four.
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0x25);

    const result = await adapter(async () => oversized).publishBill({
      ...BILL({ attachment: { s3Key: 'w/led/big', filename: 'statement.pdf', mimeType: 'application/pdf' } }),
      target: { integrationId, kind: 'FREEAGENT', orgRef: null },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ⚠ The books are right and the evidence is missing, and the row says so.
    // Claiming an attachment that did not travel would make D43 unverifiable.
    expect(result.attachmentSent).toBe(false);
    expect(result.externalRef).toBe(`${base}/v2/bills/1001`);

    const posted = seen.find((s) => s.path === '/v2/bills' && s.method === 'POST');
    expect((posted?.body as { bill: Record<string, unknown> }).bill['attachment']).toBeUndefined();
  });

  test('a PHOTOGRAPH over the cap is downscaled and DOES travel', async () => {
    const integrationId = await connect();
    // The common case: a phone photo past 5 MB. `attachment.ts` re-encodes it
    // rather than reporting a gap, which is why the downscaler exists at all.
    const sharp = (await import('sharp')).default;
    const big = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .png()
      .toBuffer();

    const result = await adapter(async () => big).publishBill({
      ...BILL({ attachment: { s3Key: 'w/led/photo', filename: 'IMG_4021.HEIC', mimeType: 'image/jpeg' } }),
      target: { integrationId, kind: 'FREEAGENT', orgRef: null },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentSent).toBe(true);
  });

  test('a vendor that recalculates the total still records the bill, and the figures are read back', async () => {
    const integrationId = await connect();
    // Several platforms recompute tax server-side. The bill exists either way —
    // refusing after the fact would mark a real transaction as never posted.
    vendor.returnTotal = '412.70';

    const result = await adapter().publishBill({ ...BILL(), target: { integrationId, kind: 'FREEAGENT', orgRef: null } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.externalRef).toBe(`${base}/v2/bills/1001`);
  });

  test('disconnecting destroys the credentials and the synced lists, and keeps nothing usable behind', async () => {
    const integrationId = await connect();
    expect(await owner.referenceSync.count({ where: { integrationId } })).toBeGreaterThan(0);

    await service().disconnect(CTX, integrationId);

    const row = await owner.integration.findUniqueOrThrow({ where: { id: integrationId } });
    // ⚠ DESTROYED, not switched off. A row left holding a live refresh token is
    // a connection that can be reactivated into one the practice believes they
    // revoked.
    expect(row.tokenRef).toBeNull();
    expect(row.isActive).toBe(false);
    expect(await owner.referenceSync.count({ where: { integrationId } })).toBe(0);

    // And a publish against it now refuses rather than throwing the batch away.
    const result = await adapter().publishBill({ ...BILL(), target: { integrationId, kind: 'FREEAGENT', orgRef: null } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/switched off|Reconnect/i);
  });

  test('a callback whose state was not signed by this server is refused', async () => {
    // ⚠ `AppException.message` is the TITLE; the sentence a practice reads is
    // `publicDetail`, which is what these assert on.
    await expect(detailOf(service().completeCallback(CTX, 'freeagent', { state: 'forged.value', code: 'x' })))
      .resolves.toMatch(/not one this server issued/);

    // A state minted for a different vendor cannot complete this callback.
    const wrongVendor = signState({ b: BIZ, v: 'xero', a: USER }, VAULT_KEY);
    await expect(detailOf(service().completeCallback(CTX, 'freeagent', { state: wrongVendor, code: 'x' })))
      .resolves.toMatch(/different accounting package/);

    // Nor a state minted by somebody else — a link captured from a browser
    // history must not complete somebody else's connection.
    const otherActor = signState({ b: BIZ, v: 'freeagent', a: 'led_someone_else' }, VAULT_KEY);
    await expect(detailOf(service().completeCallback(CTX, 'freeagent', { state: otherActor, code: 'x' })))
      .resolves.toMatch(/Sign in as the person who started this/);

    expect(await owner.integration.count({ where: { businessId: BIZ } })).toBe(0);
  });

  test('a practice pressing Cancel at the vendor is not an error of ours', async () => {
    const state = signState({ b: BIZ, v: 'freeagent', a: USER }, VAULT_KEY);
    await expect(detailOf(service().completeCallback(CTX, 'freeagent', { state, error: 'access_denied' })))
      .resolves.toMatch(/Nothing has changed/);
    expect(await owner.integration.count({ where: { businessId: BIZ } })).toBe(0);
  });

  /**
   * ⚠ **The state every environment is in the day this ships.** The lane is off
   * and `INTEGRATION_TOKEN_KEY` is empty — `env.ts` only gates that at boot for
   * `LEDGER_ADAPTER=http`, so this controller still serves, and `parseVaultKey`
   * throws on an empty string. Unguarded that is a 500 on a deployment where
   * nothing is wrong.
   */
  test('with NO sealing key: the tab still renders, and the acts that need one refuse readably', async () => {
    const integrationId = await connect();
    const keyless = new LedgerConnectionsService(app, { ...env(), INTEGRATION_TOKEN_KEY: '' }, toStandIn());

    // ⚠ Reading must still work. A practice has to be able to SEE a client's
    // connections and export destinations on a deployment that has no key, and
    // nothing on that path opens a sealed blob.
    const listed = await keyless.list(CTX, BIZ);
    expect(listed.data.some((row) => row.vendor === 'freeagent')).toBe(true);
    // Nothing is offerable, because no application is configured either.
    expect(listed.connectable).toEqual([]);

    // ⚠ And switching one OFF must work, for the same reason: a practice that
    // wants a connection gone must not be held up by our configuration.
    await expect(keyless.disconnect(CTX, integrationId)).resolves.toMatchObject({ isActive: false });

    // What genuinely needs the key says so, in a sentence that does not blame
    // the client and does not claim their books are broken.
    await expect(detailOf(keyless.sync(CTX, integrationId))).resolves.toMatch(/not set up to connect/i);
    await expect(detailOf(keyless.authorise(CTX, BIZ, 'freeagent'))).resolves.toMatch(/not set up to connect/i);
  });

  test('reconnecting REPLACES the connection rather than colliding with it', async () => {
    const first = await connect();
    // `@@unique([businessId, kind])` — a create here would violate it at exactly
    // the moment somebody is fixing a broken connection.
    const second = await connect();
    expect(second).toBe(first);
    expect(await owner.integration.count({ where: { businessId: BIZ, kind: 'FREEAGENT' } })).toBe(1);
  });
});
