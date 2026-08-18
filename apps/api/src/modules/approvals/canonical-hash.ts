import { createHash } from 'node:crypto';

/**
 * Canonical JSON + SHA-256 — what `payload_hash`, `rendered_summary_hash` and
 * the audit chain are computed over (Governance §10.4: "SHA-256 over the
 * canonical payload").
 *
 * Canonical means: object keys sorted, `undefined` members dropped, arrays in
 * order. The property being bought is that the SAME logical value always
 * produces the SAME hash regardless of key insertion order — without it, a
 * replayed payload could hash differently and `NT-PRP-004` would fire on
 * nothing. Same shape as `common/pagination`'s cursor fingerprint, but that
 * one is a truncated identity check and this one is a full digest people will
 * verify chains against — so it is not shared.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Lower-case hex, 64 chars — the shape the contract's hash patterns pin. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The one call sites actually make: hash the canonical form of a value. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
