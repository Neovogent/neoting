import { HttpStatus } from '@nestjs/common';

import { AppException } from '../../common/problem/problem.js';

/**
 * `successUrl`, `cancelUrl` and `returnUrl` are caller-supplied on
 * AUTHENTICATED endpoints, which makes an unvalidated one an open redirect
 * with a session attached to it. The contract says so on both billing
 * operations; this is where it is true.
 *
 * **Origin equality, not prefix matching.** `startsWith(allowed)` is the
 * classic hole here: `https://app.neoting.neovogent.com` also prefixes
 * `https://app.neoting.neovogent.com.attacker.example`, and both read fine in
 * review. Parsing the URL and comparing `origin` — scheme, host AND port —
 * makes that impossible rather than unlikely.
 */

/** Parse the comma-separated `BILLING_RETURN_ORIGINS` into a set of normalised origins. */
export function parseAllowedOrigins(raw: string): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    try {
      // `new URL(...).origin` normalises: case, a default port, a trailing
      // slash and any path the operator pasted by accident all collapse to the
      // same string the check below compares against.
      origins.add(new URL(trimmed).origin);
    } catch {
      // A malformed entry is DROPPED, not thrown on. This runs at composition
      // time; throwing would take /healthz down for a typo in one of several
      // origins, and dropping fails closed — that origin simply is not allowed.
      continue;
    }
  }
  return origins;
}

/**
 * Return the URL unchanged if its origin is allowed, or throw 400.
 *
 * `NT-VAL-001` rather than a billing code: from the caller's side this is a
 * request-body field that failed validation, and it names the field so a
 * frontend developer can fix it. The URL is NOT echoed back — it is
 * caller-submitted content, and this module's rule is the same one web upload
 * follows: name the field, never quote the value.
 */
export function assertAllowedReturnUrl(url: string, allowed: ReadonlySet<string>, field: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw refuse(field);
  }
  // `new URL('mailto:x')` parses and yields the origin `null` — a string, not
  // the value null — so a non-http scheme could otherwise sail through if
  // someone ever put a literal "null" in the allowlist. Reject it here.
  if (origin === 'null' || !allowed.has(origin)) throw refuse(field);
  return url;
}

function refuse(field: string): AppException {
  return new AppException(
    'NT-VAL-001',
    HttpStatus.BAD_REQUEST,
    'Validation failed',
    'The return URL is not one of this deployment’s own origins.',
    [{ field, message: 'Must be an absolute URL on an allowed origin.' }],
  );
}
