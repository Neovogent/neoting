import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_TTL_MS,
  type PlatformAdmin,
  resolvePlatformAdmin,
  signImpersonation,
  verifyImpersonation,
} from '../auth-tenancy/index.js';
import type { PlatformAdminService } from './platform-admin.service.js';
import { ADMIN_PRISMA, PLATFORM_ADMIN_SERVICE } from './tokens.js';

const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const FlagKey = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/);
const SearchQuery = z.object({ q: z.string().max(200).optional() }).strict();
const FlagBody = z.object({ isEnabled: z.boolean(), description: z.string().max(500).optional() }).strict();
const OverrideBody = z.object({ isEnabled: z.boolean().nullable() }).strict();
const ImpersonateBody = z.object({ practiceId: Id }).strict();

/**
 * `/v1/admin/*` — the platform support console (rush/admin). Not in the public
 * contract: an internal surface for platform staff only. Every handler
 * authenticates the caller as staff FIRST (`resolvePlatformAdmin`: session
 * cookie + `PLATFORM_ADMIN_EMAILS` + second factor), and never runs under the
 * request's tenant scope.
 */
@Controller('admin')
export class PlatformAdminController {
  constructor(
    @Inject(PLATFORM_ADMIN_SERVICE) private readonly service: PlatformAdminService,
    @Inject(ADMIN_PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('session')
  async session(@Req() req: Request) {
    const admin = await this.admin(req);
    const impersonation = verifyImpersonation(req.header('cookie'), this.env.SESSION_SECRET);
    return {
      ...admin,
      impersonating:
        impersonation === null
          ? null
          : { practiceId: impersonation.practiceId, expiresAt: new Date(impersonation.expiresAtMs).toISOString() },
    };
  }

  @Get('practices')
  async practices(@Req() req: Request, @Query() query: unknown) {
    await this.admin(req);
    const { q } = parseBoundary(SearchQuery, query, 'query');
    return { data: await this.service.listPractices(q) };
  }

  @Get('practices/:practiceId')
  async practice(@Req() req: Request, @Param('practiceId') practiceId: string) {
    await this.admin(req);
    return this.service.practiceDetail(parseBoundary(Id, practiceId, 'path'));
  }

  @Get('practices/:practiceId/documents/:documentId/events')
  async documentLog(@Req() req: Request, @Param('practiceId') practiceId: string, @Param('documentId') documentId: string) {
    await this.admin(req);
    return this.service.documentLog(parseBoundary(Id, practiceId, 'path'), parseBoundary(Id, documentId, 'path'));
  }

  @Post('practices/:practiceId/invites/:inviteId/resend')
  async resendInvite(@Req() req: Request, @Param('practiceId') practiceId: string, @Param('inviteId') inviteId: string) {
    const admin = await this.admin(req);
    return this.service.resendInvite(admin, parseBoundary(Id, practiceId, 'path'), parseBoundary(Id, inviteId, 'path'));
  }

  @Post('practices/:practiceId/system-actor')
  async backfillSystemActor(@Req() req: Request, @Param('practiceId') practiceId: string) {
    const admin = await this.admin(req);
    return this.service.backfillSystemActor(admin, parseBoundary(Id, practiceId, 'path'));
  }

  @Post('users/:userId/unlock')
  async unlock(@Req() req: Request, @Param('userId') userId: string) {
    const admin = await this.admin(req);
    return this.service.unlockUser(admin, parseBoundary(Id, userId, 'path'));
  }

  @Get('flags')
  async flags(@Req() req: Request) {
    await this.admin(req);
    return { data: await this.service.listFlags() };
  }

  @Put('flags/:key')
  async upsertFlag(@Req() req: Request, @Param('key') key: string, @Body() body: unknown) {
    const admin = await this.admin(req);
    return this.service.upsertFlag(admin, parseBoundary(FlagKey, key, 'path'), parseBoundary(FlagBody, body, 'request body'));
  }

  @Put('practices/:practiceId/flags/:key')
  async override(@Req() req: Request, @Param('practiceId') practiceId: string, @Param('key') key: string, @Body() body: unknown) {
    const admin = await this.admin(req);
    const { isEnabled } = parseBoundary(OverrideBody, body, 'request body');
    return this.service.setPracticeOverride(admin, parseBoundary(Id, practiceId, 'path'), parseBoundary(FlagKey, key, 'path'), isEnabled);
  }

  /** Start a 30-minute read-only "view as" of one practice. */
  @Post('impersonations')
  async impersonate(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const admin = await this.admin(req);
    const { practiceId } = parseBoundary(ImpersonateBody, body, 'request body');
    const practice = await this.service.practiceForImpersonation(practiceId);
    const expiresAtMs = Date.now() + IMPERSONATION_TTL_MS;
    const token = signImpersonation({ adminUserId: admin.userId, adminEmail: admin.email, practiceId, expiresAtMs }, this.env.SESSION_SECRET);
    await this.service.auditImpersonation(admin, practiceId, 'admin.impersonation.started', { practiceId, expiresAtMs });
    res.cookie(IMPERSONATION_COOKIE_NAME, token, { ...this.cookieOptions(), expires: new Date(expiresAtMs) });
    return { practiceId, practiceName: practice.name, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** End it. Tolerant: no cookie still answers 204 — the goal is already true. */
  @Delete('impersonations/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async endImpersonation(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const claims = verifyImpersonation(req.header('cookie'), this.env.SESSION_SECRET);
    res.clearCookie(IMPERSONATION_COOKIE_NAME, this.cookieOptions());
    if (claims !== null) {
      const admin: PlatformAdmin = { userId: claims.adminUserId, email: claims.adminEmail };
      await this.service.auditImpersonation(admin, claims.practiceId, 'admin.impersonation.ended', { practiceId: claims.practiceId });
    }
  }

  private admin(req: Request): Promise<PlatformAdmin> {
    return resolvePlatformAdmin(this.prisma, this.env, req.header('cookie'));
  }

  /** Matches `auth.controller.ts`'s session cookie, so the two live and die alike. */
  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', path: '/', secure: this.env.NODE_ENV === 'production' };
  }
}
