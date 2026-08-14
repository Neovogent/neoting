import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's `X-Hub-Signature-256` over the RAW request body (Governance
 * §11.7; contract `securitySchemes.whatsappSignature`). The header is
 * `sha256=<lowercase hex HMAC-SHA256(rawBody, appSecret)>`. Pure and
 * constant-time — the endpoint's whole security is this function, so it is
 * unit-tested directly, not only through the framework.
 *
 * Every branch fails CLOSED: an unset secret, an absent/empty body, a missing or
 * malformed header all return `false`.
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (appSecret.length === 0) return false; // no secret configured → cannot verify
  if (!rawBody || rawBody.length === 0) return false; // an empty body cannot be signed
  if (!header || !header.startsWith('sha256=')) return false; // ignore the legacy SHA-1 header
  const provided = header.slice('sha256='.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false; // must be SHA-256 hex width

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  // timingSafeEqual throws on unequal length — both are 32 bytes here, but guard anyway.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Constant-time compare of the GET-handshake verify token (a shared string we
 * choose, distinct from the app secret). Fails closed when the token is unset.
 */
export function verifyTokenMatches(candidate: string | undefined, expected: string): boolean {
  if (expected.length === 0 || candidate === undefined) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
