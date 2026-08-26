import type { CanonicalSourceLink } from '../canonical/canonical-row.js';

import { CapabilityCodeSchema } from './capability-code.js';

/**
 * Where a capability code becomes a URL — D43 rung 2, and the only place in the
 * codebase that knows the shape of that link.
 *
 * ## `/d/{code}`, at the ORIGIN ROOT, and the three characters are the point
 *
 * `apps/api/src/config/routing.ts` excludes `d/:code` from the global `/v1`
 * prefix, and `packages/contracts/openapi.yaml` declares the path outside the
 * versioned server block. Neither is tidiness. This URL has to survive a
 * reference field that truncates **silently** at 30 characters in one target
 * and ~25 in another (SoT §21), and `https://` plus a host has already spent
 * most of that budget — `/v1/` would spend an eighth of what is left on a
 * version segment no human will ever type.
 *
 * ⚠ **Even so, the full URL does not fit a 25- or 30-character field, and it
 * never could.** `https://neoacc.neovogent.com/d/` is 31 characters before the
 * code. That is not a defect in this file; it is why D43 is a *ladder*. The
 * bare **code** goes in `Entry details` (rung 1, 8 characters, fits anything),
 * the **URL** goes in `Transaction notes` (rung 3, which VT documents as
 * unlimited), and the **manifest + bundle** (rung 4) work when neither does.
 * A10 measures which rungs VT actually honours; nothing here assumes.
 */

/**
 * The origin capability URLs are minted against.
 *
 * ⚠ **A DEPLOY-TIME DECISION LIVING IN CODE, and it is the one thing in this
 * file that should move.** `packages/contracts/openapi.yaml` declares exactly
 * these two servers for `/d/{code}` — `http://localhost:3000` and
 * `https://neoacc.neovogent.com` — so the value is contracted rather than
 * invented, and it is a public hostname, not a secret. But its right home is
 * `config/env.ts` (`CAPABILITY_LINK_ORIGIN`), which is outside stage A8's
 * owned paths. Until that env key exists, the composition root passes an
 * override and this is the default it falls back to.
 *
 * Getting it wrong is expensive in a specific way: a code minted against the
 * wrong origin is already inside a customer's ledger file by the time anyone
 * notices, and the fix is a re-export, not a config change.
 */
export const CAPABILITY_LINK_ORIGIN = 'https://neoacc.neovogent.com';

/** The path segment. One character, deliberately (see the header). */
export const CAPABILITY_LINK_PATH = '/d/';

export class CapabilityUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityUrlError';
  }
}

/**
 * `origin` + `/d/` + `code`, with both halves checked.
 *
 * The origin is validated rather than trusted because it arrives from
 * configuration and ends up inside a file we cannot recall: a trailing slash
 * would produce `//d/CODE`, and an origin carrying a path or a query would
 * produce a link that resolves somewhere else entirely. `http` is admitted only
 * for `localhost` — a capability URL over plaintext on any other host is a
 * client's financial document handed to whoever is on the wire.
 */
export function capabilityLinkUrl(origin: string, code: string): string {
  const parsed = CapabilityCodeSchema.safeParse(code);
  if (!parsed.success) {
    throw new CapabilityUrlError(`"${code}" is not a capability code: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return `${assertCapabilityOrigin(origin)}${CAPABILITY_LINK_PATH}${parsed.data}`;
}

/** The origin check, exported so the composition root can fail at boot rather than at export time. */
export function assertCapabilityOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new CapabilityUrlError(`capability link origin "${origin}" is not a URL`);
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    throw new CapabilityUrlError(
      `capability link origin "${origin}" must be https — the link resolves to a client's financial document and travels through software we do not control`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new CapabilityUrlError(
      `capability link origin "${origin}" must be a bare origin — a path, query or fragment here silently changes where every exported link points`,
    );
  }

  // `url.origin` normalises away a trailing slash and the default port, so
  // `https://neoacc.neovogent.com/` and `https://neoacc.neovogent.com` mint the
  // identical link. Byte-stability across exports is the property §24.3.1 calls
  // the highest-leverage detail in the whole export.
  return url.origin;
}

/**
 * The A7 seam, filled. `code` → `Entry details`, `url` → `Transaction notes`.
 *
 * Built here rather than in the emitter so there is exactly one place that
 * decides what an exported row's link looks like — the emitter receives a
 * finished pair and writes it into two cells.
 */
export function toCanonicalSourceLink(origin: string, code: string): CanonicalSourceLink {
  return { code, url: capabilityLinkUrl(origin, code) };
}
