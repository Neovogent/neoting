import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { parseVaultKey } from '../../common/oauth/token-vault.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { type DocumentStore, selectDocumentStore } from '../ingestion-routing/index.js';
import { PortalModule } from '../portal/index.js';
import { type DriveConnectionConfig, DriveConnectionsService } from './drive-connections.service.js';
import type { DriveSlug } from './drive-vendors.js';
import { VaultController } from './vault.controller.js';
import {
  DOCUMENT_STORE,
  DRIVE_CONNECTION_CONFIG,
  DRIVE_CONNECTIONS,
  DRIVE_FETCH,
  PRISMA,
  VAULT_SERVICE,
} from './vault.tokens.js';
import { VaultService } from './vault.service.js';

/**
 * The Document Vault add-on (D51).
 *
 * ⚠ **It imports `PortalModule` rather than re-resolving portal sessions.**
 * `PORTAL_SESSION_CONTEXT` is on the portal's public seam precisely so a second
 * module can inject the ONE resolver instead of building a second one that
 * would eventually disagree with it about what a valid bearer is.
 */

@Module({
  imports: [PortalModule],
  controllers: [VaultController],
  providers: [
    { provide: PRISMA, useFactory: (): PrismaClient => getPrismaClient() },
    { provide: DOCUMENT_STORE, useFactory: (env: Env): DocumentStore => selectDocumentStore(env), inject: [ENV] },
    { provide: DRIVE_FETCH, useValue: globalThis.fetch },
    {
      provide: DRIVE_CONNECTION_CONFIG,
      useFactory: (env: Env): DriveConnectionConfig => ({
        credentials: (slug) => driveCredentials(env, slug),
        // ⚠ The SAME key the ledger seals its tokens with. One platform key, one
        // `v1` blob format, one rotation story — two keys would mean two
        // reconnect-everything events on the day either is rotated.
        //
        // Empty is tolerated so a deployment that sells no vault still boots:
        // `parseVaultKey` would throw, so the zero buffer stands in and every
        // connect refuses at `driveCredentials` long before a seal is attempted.
        vaultKey: env.INTEGRATION_TOKEN_KEY === '' ? Buffer.alloc(32) : parseVaultKey(env.INTEGRATION_TOKEN_KEY),
      }),
      inject: [ENV],
    },
    {
      provide: VAULT_SERVICE,
      useFactory: (prisma: PrismaClient, store: DocumentStore) => new VaultService(prisma, store),
      inject: [PRISMA, DOCUMENT_STORE],
    },
    {
      provide: DRIVE_CONNECTIONS,
      useFactory: (prisma: PrismaClient, config: DriveConnectionConfig, fetchImpl: typeof fetch) =>
        new DriveConnectionsService(prisma, config, fetchImpl),
      inject: [PRISMA, DRIVE_CONNECTION_CONFIG, DRIVE_FETCH],
    },
  ],
  exports: [VAULT_SERVICE, DRIVE_CONNECTIONS],
})
export class ArchiveVaultSearchModule {}

/**
 * Our app registration per drive, from config.
 *
 * ⚠ Returns null rather than throwing on a missing registration, and the whole
 * connection surface is built around that: a deployment with no Google
 * registration must still boot, still serve every other client, and refuse only
 * the Google connect — with a sentence naming which drive is unavailable.
 * Throwing here would make a missing optional credential a boot failure.
 */
function driveCredentials(
  env: Env,
  slug: DriveSlug,
): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const [id, secret, redirect] =
    slug === 'google-drive'
      ? [env.GOOGLE_DRIVE_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_SECRET, env.GOOGLE_DRIVE_REDIRECT_URI]
      : [env.ONEDRIVE_CLIENT_ID, env.ONEDRIVE_CLIENT_SECRET, env.ONEDRIVE_REDIRECT_URI];
  if (id === '' || secret === '' || redirect === '') return null;
  return { clientId: id, clientSecret: secret, redirectUri: redirect };
}
