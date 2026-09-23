import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import type { PortalVault, VaultExport } from '@neoting/contracts/model';

import type { Page } from '../../common/pagination/cursor.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { zipStream } from '../../common/zip/store-zip.js';
import { PORTAL_SESSION_CONTEXT, type PortalSessionContextResolver } from '../portal/index.js';
import type { DriveConnectionsService } from './drive-connections.service.js';
import { DRIVE_CONNECTIONS, VAULT_SERVICE } from './vault.tokens.js';
import type { VaultService } from './vault.service.js';

/**
 * The Document Vault add-on's surface (D51), on the client's own portal.
 *
 * Thin, per `apps/api/CLAUDE.md`: resolve the session, parse the boundary, call
 * ONE service method, map the result. Every route authenticates BEFORE it
 * validates — a caller with no valid bearer learns nothing about which of their
 * parameters we would have objected to, which is the rule the portal controller
 * already follows.
 *
 * ⚠ **The entitlement gate is in the SERVICE, not here.** Same reason
 * `entitlement.ts` gives for staying out of RLS: a gate in the controller is a
 * gate one new route can forget, and the routes that must refuse without the
 * add-on are not the same as the routes that exist.
 */
@Controller('portal/vault')
export class VaultController {
  constructor(
    @Inject(PORTAL_SESSION_CONTEXT) private readonly resolver: PortalSessionContextResolver,
    @Inject(VAULT_SERVICE) private readonly vault: VaultService,
    @Inject(DRIVE_CONNECTIONS) private readonly connections: DriveConnectionsService,
  ) {}

  /**
   * `GET /portal/vault` — what the Vault tab renders itself from.
   *
   * ⚠ **Not gated on the add-on.** Most clients have not bought it, and this is
   * the call that tells the tab to offer it. A 402 here would mean the offer
   * could not be drawn.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async state(@Headers('authorization') authorization: string | undefined): Promise<PortalVault> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    return this.vault.vaultState(facts);
  }

  /**
   * `GET /portal/vault/archive` — every document, as one ZIP.
   *
   * ⚠ **Streamed with `@Res()`, which turns OFF Nest's own serialisation.** That
   * is deliberate and it is the only way to write bytes as they are produced:
   * returning a Buffer would mean building the whole archive in memory first,
   * which is the thing this endpoint is written to avoid.
   *
   * ⚠ **The headers go out BEFORE the first entry is read**, so a failure
   * midway cannot become a 500 with a JSON body — the status is already sent.
   * A read that fails mid-archive therefore ends the response, and the client
   * gets a truncated file their unzipper will reject, which is honest. The
   * alternative — buffering the whole archive so a late failure could still be
   * a clean error — costs the memory this endpoint exists to not spend.
   */
  @Get('archive')
  async archive(@Headers('authorization') authorization: string | undefined, @Res() res: Response): Promise<void> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    await this.vault.assertEntitledForArchive(facts);
    // ⚠ BEFORE a single header. Once the 200 is written the status cannot be
    // taken back, and an unreadable store would otherwise hand the client a
    // valid, empty, silent ZIP — which is exactly what it did on 21 Sep 2026.
    await this.vault.assertArchiveReadable(facts);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    // ⚠ The filename is OURS, not the business's. A business name comes off a
    // signup form and would have to be sanitised into a header — and a header
    // is exactly where an unsanitised newline becomes response splitting.
    res.setHeader('Content-Disposition', `attachment; filename="neo-accounting-documents-${stamp}.zip"`);
    // The length is unknowable before the archive is built, so the response is
    // chunked. Saying so explicitly stops a proxy buffering it to find out.
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of zipStream(this.vault.archiveEntries(facts))) {
      // Back-pressure: if the socket is full, wait for it rather than buffering
      // the rest of the archive in the process.
      if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', () => resolve()));
    }
    res.end();
  }

  /** `GET /portal/vault/exports` — this client's copy-to-Drive runs, newest first. */
  @Get('exports')
  @HttpCode(HttpStatus.OK)
  async listExports(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<Page<VaultExport>> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const parsed = parseBoundary(ExportQuerySchema, coerce(query), 'query parameters');
    // Conditional spread rather than passing `cursor: undefined` —
    // `exactOptionalPropertyTypes` is on, and an explicit undefined is not the
    // same thing as an absent key.
    return this.vault.listExports(facts, {
      limit: parsed.limit,
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    });
  }

  /** `POST /portal/vault/exports` — start a copy into a connected drive. */
  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  async createExport(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<VaultExport> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const request = parseBoundary(ExportRequestSchema, body, 'request body');
    return this.vault.createExport(facts, request.kind);
  }

  /**
   * `POST /portal/vault/connections` — where to send the browser for consent.
   *
   * Returns a URL rather than a 302: the caller is `fetch` from the portal with
   * a bearer, and a redirect would be followed by the fetch rather than by the
   * window, landing the consent page inside an XHR where nobody can see it.
   */
  @Post('connections')
  @HttpCode(HttpStatus.OK)
  async startConnection(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<{ authorizeUrl: string }> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const request = parseBoundary(ConnectRequestSchema, body, 'request body');
    return this.connections.start(facts, request.drive);
  }

  /**
   * `POST /portal/vault/connections/complete` — finish it.
   *
   * ⚠ This exists because a vendor's redirect cannot carry a bearer. The web
   * app receives the redirect and calls this WITH the session, which is what
   * keeps the signed state from being the only thing authorising the write —
   * see `drive-connections.service.ts`.
   */
  @Post('connections/complete')
  @HttpCode(HttpStatus.OK)
  async completeConnection(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<{ connectedAccount: string | null }> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const request = parseBoundary(CompleteRequestSchema, body, 'request body');
    const { label } = await this.connections.complete(facts, request.code, request.state);
    return { connectedAccount: label };
  }

  /** `DELETE /portal/vault/connections/{kind}` — withdraw consent, and the token with it. */
  @Delete('connections/:kind')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @Headers('authorization') authorization: string | undefined,
    @Param('kind') kind: string,
  ): Promise<void> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    await this.connections.disconnect(facts, kind);
  }
}

/**
 * ⚠ Hand-written rather than generated, and only for the shapes orval does not
 * emit a body schema for. Where the contract HAS a generated schema the
 * generated one is used — a second copy of a contracted shape is a second thing
 * to drift.
 */
const ExportRequestSchema = z.object({ kind: z.enum(['GOOGLE_DRIVE', 'ONEDRIVE']) });
const ConnectRequestSchema = z.object({ drive: z.enum(['google-drive', 'onedrive']) });
const CompleteRequestSchema = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(4096) });
const ExportQuerySchema = z.object({ limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional() });

/**
 * Express delivers every query value as a string while the schema types `limit`
 * as a number, so `?limit=25` — the exact shape the portal sends — is otherwise
 * a 400. The same coercion `portal.controller.ts` does, narrowed to the one
 * numeric field this surface has.
 */
function coerce(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query;
  const source = query as Record<string, unknown>;
  const limit = source['limit'];
  return typeof limit === 'string' && limit !== '' ? { ...source, limit: Number(limit) } : source;
}
