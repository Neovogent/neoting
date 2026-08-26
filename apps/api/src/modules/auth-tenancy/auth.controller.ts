import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import { createSessionBody } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import type { AuthService } from './auth.service.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';
import { AUTH_SERVICE } from './tokens.js';

/**
 * The demo-auth trio (METH Stage 1, issue #118): login, logout, `/me`. One
 * controller with explicit paths because `/me` is not under `/auth` in the
 * contract — the §13.3 context header is its own top-level read.
 *
 * Thin by design: parse with the generated schema, call ONE service method,
 * map the result. The only mapping here is the cookie itself, which is
 * transport, not business logic.
 */
@Controller()
export class AuthController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(AUTH_SERVICE) private readonly service: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('auth/sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  // `async` since launch stage A1: credentials moved into `users.password_hash`,
  // so login reads the user row. It still writes nothing.
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<void> {
    const parsed = parseBoundary(createSessionBody, body, 'request body');
    const session = await this.service.login(parsed);
    res.cookie(SESSION_COOKIE_NAME, session.token, { ...this.cookieOptions(), expires: session.expiresAt });
  }

  @Delete('auth/sessions/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    // Deliberately tolerant: no cookie, or an expired one, still gets a 204 —
    // the caller's goal (not being logged in) is already true (contract).
    res.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions());
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async me() {
    return this.service.me(await this.context.require());
  }

  /**
   * Shared between set and clear — Express only clears a cookie whose options
   * match the ones it was set with. `secure` only in production: the demo runs
   * on plain-http localhost, where a Secure cookie silently never sticks.
   */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.env.NODE_ENV === 'production',
    };
  }
}
