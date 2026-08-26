import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentTraceId } from '../../../common/trace/trace-context.js';

import type { CapabilityLinkService } from './capability-link.service.js';
import { CAPABILITY_LINK_SERVICE } from './tokens.js';

/**
 * ============================================================================
 *  ⚠  `GET /d/{code}` — UNAUTHENTICATED BY DESIGN. THE TOKEN IS THE
 *     AUTHORISATION. THIS IS THE ONE ROUTE OUTSIDE THE SESSION WALL.
 * ============================================================================
 *
 * Every other controller in this API resolves a `ScopeContext` before it does
 * anything. **This one cannot, and must not be "fixed" to.** An accountant
 * reads a capability code out of a CSV column inside VT Transaction+ and types
 * or pastes it into a browser; no session of ours can exist inside someone
 * else's accounting software, which is why D43 is written on the outcome rather
 * than the mechanism. `capability-link.service.ts`'s header carries the full
 * account of what makes that safe — read it before changing a line here.
 *
 * Three things about the route itself:
 *
 * 1. **It is served at the ORIGIN ROOT, not under `/v1`.** `config/routing.ts`
 *    carries the exclusion (`{ path: 'd/:code', method: RequestMethod.GET }`)
 *    and `routing.test.ts` couples it to this `@Controller` path, so renaming
 *    one without the other fails a test rather than silently moving the URL an
 *    accountant already has. The three characters are the point: this link has
 *    to survive a reference field that truncates silently.
 * 2. **No client is generated for it.** `orval.config.ts` excludes the
 *    `capability-links` tag, because `ntFetch` puts `/v1` in its base URL and a
 *    generated caller would request `/v1/d/{code}` — a URL nothing serves.
 *    Nothing in `apps/web` should call this.
 * 3. **It answers `302`, never bytes.** The same stance as
 *    `GET /documents/{id}/original`: the API hands back a short-lived,
 *    object-scoped URL and never becomes a file server. There is no content
 *    negotiation, because the caller is a person with a browser.
 */
@Controller('d')
export class CapabilityLinkController {
  constructor(@Inject(CAPABILITY_LINK_SERVICE) private readonly service: CapabilityLinkService) {}

  @Get(':code')
  async resolve(@Param('code') code: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    const redirect = await this.service.resolve({
      code,
      // Express's own resolution, so this becomes the real client address the
      // moment `main.ts` sets `trust proxy` — see the warning in
      // `link-rate-limit.ts`. Reading `X-Forwarded-For` by hand instead would
      // be worse than useless: an unvalidated header an attacker rotates at
      // will defeats the per-IP ceiling completely.
      ip: request.ip,
      traceId: currentTraceId(),
    });

    // `no-store` because the 302 is a one-shot capability exchange: a cached
    // redirect would hand a stale presigned URL to the next person on that
    // browser, and skip the access log while doing it.
    response.setHeader('Cache-Control', 'no-store');
    // The `Location` is a presigned URL carrying its own signature in the query
    // string. Without this, following the redirect to a document that itself
    // links out leaks that signature in a `Referer`.
    response.setHeader('Referrer-Policy', 'no-referrer');
    // Non-negotiable on a route that returns a URL to somebody else's file: no
    // proxy, no browser, and no crawler should be inferring a type here.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Nothing on this route should ever be indexed, and it is the one URL of
    // ours that gets pasted into places crawlers read.
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');

    response.redirect(302, redirect.url);
  }
}
