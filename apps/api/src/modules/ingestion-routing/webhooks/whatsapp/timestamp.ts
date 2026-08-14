const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * ±5-minute freshness check (Governance §11.7). WhatsApp carries a per-message
 * Unix-SECONDS timestamp; a delivery outside the window is stale or replayed and
 * the contract returns 401 for it. Guards both past- and future-dated values.
 */
export function withinTolerance(
  messageTsSeconds: number,
  nowMs: number,
  toleranceMs: number = FIVE_MINUTES_MS,
): boolean {
  if (!Number.isFinite(messageTsSeconds)) return false;
  return Math.abs(nowMs - messageTsSeconds * 1000) <= toleranceMs;
}

/**
 * Strictly parse a WhatsApp Unix-seconds timestamp string — decimal digits
 * only. Returns null for anything else (empty, whitespace, `1e10`, `NaN`) so a
 * malformed value is rejected explicitly rather than silently coerced by
 * `Number()` (which would turn `''` into 0 = 1970).
 */
export function parseUnixSeconds(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}
