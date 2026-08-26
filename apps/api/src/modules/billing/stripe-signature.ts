import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Stripe's `Stripe-Signature` over the RAW request body (contract:
 * `securitySchemes.stripeSignature`).
 *
 * The header is a comma-separated list of `key=value` pairs:
 *
 *     t=1724680000,v1=<hex HMAC-SHA256>,v1=<another>,v0=<ignored>
 *
 * and the signed payload is `${t}.${rawBody}` — the timestamp is INSIDE the
 * MAC, which is what makes a replay detectable at all. Three details are
 * load-bearing:
 *
 * 1. **Raw bytes.** A framework that has already JSON-parsed and re-serialised
 *    the body computes a different HMAC over the same event, and the failure
 *    looks nothing like its cause. `main.ts` sets `rawBody: true` for exactly
 *    this; do not set `bodyParser: false`, which drops `req.rawBody`.
 * 2. **More than one `v1` is normal**, during a signing-secret rotation. Any
 *    one matching is a pass, so a rotation does not drop events on the floor.
 * 3. **The timestamp tolerance is part of verification, not a nicety.** Without
 *    it a captured request stays valid forever, and Stripe deliberately signs
 *    the timestamp so that we can refuse an old one.
 *
 * Pure and constant-time, and unit-tested directly rather than only through
 * the framework — the endpoint's whole security is this function. Every branch
 * fails CLOSED: an unset secret, an absent body, a missing, malformed or stale
 * header all return `false`.
 */

/** Stripe's own default. A replay outside it is refused. */
export const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  webhookSecret: string,
  nowMs: number,
  toleranceSeconds: number = STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  if (webhookSecret.length === 0) return false; // no secret configured → cannot verify
  if (!rawBody || rawBody.length === 0) return false; // an empty body cannot be signed
  if (!header) return false;

  const parsed = parseSignatureHeader(header);
  if (parsed === null) return false;

  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);
  if (ageSeconds > toleranceSeconds) return false;

  // `${t}.${payload}` as BYTES. Concatenating the buffer rather than
  // stringifying it keeps any non-UTF-8 byte in the body exactly as Stripe
  // signed it — `rawBody.toString()` would silently replace one.
  const signed = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, 'utf8'), rawBody]);
  const expected = createHmac('sha256', webhookSecret).update(signed).digest();

  // `.some` over every v1: during a secret rotation Stripe sends two, and only
  // one of them is ours.
  return parsed.signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'hex');
    // timingSafeEqual throws on unequal length — both are 32 bytes here, but guard anyway.
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

interface ParsedSignature {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

/** Exported for its test: the header grammar is where a lenient parser becomes a bypass. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    // `split('=', 2)` would DROP everything after the second `=` rather than
    // keep it, so the index is taken by hand. No value here legitimately
    // contains one, but a parser that silently truncates is the kind that
    // turns into a bypass later.
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      // Integer seconds only. `Number('1e9')` is a number and `parseInt('12abc')`
      // is 12; neither is a timestamp Stripe sent.
      if (!/^[0-9]{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      // Must be SHA-256 hex width, lower-case as Stripe emits it. A short or
      // odd-length hex string would become a shorter Buffer and be rejected by
      // the length check anyway — refusing it here keeps the failure legible.
      if (/^[0-9a-f]{64}$/.test(value)) signatures.push(value);
    }
    // v0 and any future scheme are ignored, not rejected: an unknown scheme
    // alongside a valid v1 is a Stripe rollout, not an attack.
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}
