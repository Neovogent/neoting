import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { Integration, IntegrationAuthorisation, IntegrationList } from '@neoting/contracts/model';
import { createIntegrationAuthorisationBody, listIntegrationsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../../common/context/context.module.js';
import type { RequestContext } from '../../../common/context/request-context.js';
import { parseBoundary } from '../../../common/validation/parse-boundary.js';
import type { Env } from '../../../config/env.js';
import { ENV } from '../../../config/env.module.js';
import type { LedgerConnectionsService } from './ledger-connections.service.js';
import { LEDGER_CONNECTIONS_SERVICE } from './tokens.js';
import { vendorForSlug } from './vendors.js';

/**
 * The connection surface (D50). Four contracted operations plus the vendors'
 * redirect target.
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service method, return it. The
 * authority check is the SERVICE's, because it needs an open transaction to
 * resolve the actor's membership — never a role test written here, which
 * `assert-can.ts`'s header is explicit is how the more permissive of two copies
 * wins on the day it matters.
 */
@Controller()
export class LedgerConnectionsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(LEDGER_CONNECTIONS_SERVICE) private readonly service: LedgerConnectionsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('integrations')
  async list(@Query() query: unknown): Promise<IntegrationList> {
    const parsed = parseBoundary(listIntegrationsQueryParams, query, 'query');
    return this.service.list(await this.context.require(), parsed.businessId);
  }

  @Post('integrations/authorisations')
  @HttpCode(HttpStatus.CREATED)
  async authorise(@Body() body: unknown): Promise<IntegrationAuthorisation> {
    const parsed = parseBoundary(createIntegrationAuthorisationBody, body, 'request body');
    return this.service.authorise(await this.context.require(), parsed.businessId, parsed.vendor);
  }

  @Post('integrations/:integrationId/sync')
  @HttpCode(HttpStatus.OK)
  async sync(@Param('integrationId') integrationId: string): Promise<Integration> {
    return this.service.sync(await this.context.require(), integrationId);
  }

  @Post('integrations/:integrationId/disconnection')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Param('integrationId') integrationId: string): Promise<Integration> {
    return this.service.disconnect(await this.context.require(), integrationId);
  }

  /**
   * ⚠ **The vendors' redirect target, and deliberately NOT in the contract.**
   *
   * Xero, Intuit, Sage and FreeAgent hold this URL in their own configuration
   * and send a browser to it; its query string is theirs, versioned on their
   * schedule. That is the same argument `apps/api/CLAUDE.md` makes for the
   * WhatsApp webhook, and it is why no generated client knows this exists.
   *
   * It answers with a **redirect into the web app**, never with JSON and never
   * with a rendered page: the practice is mid-journey in the product, and a
   * bare `{"ok":true}` in the address bar is where a connection journey goes to
   * die. A failure redirects too, carrying a short reason the app renders —
   * because the alternative is a stack trace on screen at the end of somebody's
   * consent flow.
   */
  @Get('integrations/:vendor/callback')
  async callback(
    @Param('vendor') vendorSlug: string,
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const vendor = vendorForSlug(vendorSlug);
    if (vendor === null) {
      res.redirect(this.appUrl(null, 'That connection link is for accounting software this product does not support.'));
      return;
    }
    try {
      const done = await this.service.completeCallback(await this.context.require(), vendor.slug, query ?? {});
      res.redirect(this.appUrl(done.businessId, null));
    } catch (error) {
      // ⚠ Our own sentence or a generic one — never the raw error. This string
      // lands in a URL, which is logged by proxies and lives in browser
      // history, so it may say what to do and nothing about what broke.
      const detail =
        error instanceof Error && error.name === 'AppException'
          ? error.message
          : 'The connection could not be completed. Try again from the client’s Connections screen.';
      res.redirect(this.appUrl(null, detail));
    }
  }

  /** Back into the web app, at the screen the practice started from. */
  private appUrl(businessId: string | null, error: string | null): string {
    const url = new URL('/clients', this.env.APP_ORIGIN);
    if (businessId !== null) url.searchParams.set('client', businessId);
    url.searchParams.set('tab', 'connections');
    if (error !== null) url.searchParams.set('connectionError', error);
    return url.toString();
  }
}
