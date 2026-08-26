/**
 * A CSV serialiser, written here rather than installed.
 *
 * It is a few lines, and a dependency in the one file that produces the
 * product's only egress is not worth the supply-chain surface or the review
 * (Governance: adding a dependency is a stop-and-ask). What it must get right
 * is narrow and testable: **a supplier name may contain a comma and an accented
 * character at the same time**, and that single case is what breaks hand-rolled
 * serialisers.
 *
 * RFC 4180, with two deliberate choices:
 *
 * - **CRLF line endings.** The consumer is a Windows desktop application.
 * - **Bytes are somebody else's decision.** This returns a `string`;
 *   `encoding.ts` is the one place it becomes bytes, so A10 can change the
 *   encoding without reading this file.
 */

const NEEDS_QUOTING = /[",\r\n]/;

/**
 * ⚠ **On CSV formula injection, and why nothing is prefixed here.**
 *
 * The usual hardening for a CSV is to prefix a field beginning `=`, `+`, `-` or
 * `@` so a spreadsheet does not evaluate it as a formula. This file
 * deliberately does not, and the reason is specific rather than lazy: the
 * consumer of this file is **VT's Universal Input Sheet importer, not Excel**,
 * and the `Primary account` string is the key VT's Converter saves a supplier
 * mapping against (§24.3.1). Prefixing it would change that key on every export
 * and turn a one-time supplier mapping back into manual work for ever — the
 * exact failure §24.3.1 identifies as the highest-leverage detail in the export.
 *
 * The residual risk is an accountant opening the file in Excel first. It is
 * recorded here rather than mitigated silently, and it is a decision worth
 * revisiting the day this file feeds anything a spreadsheet opens by default.
 */
function serialiseField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Rows of already-stringified cells to one CSV document.
 *
 * Every cell arrives as a `string` because the emitter above has already made
 * every formatting decision — a number reaching this function would be a number
 * this function had to decide how to render, and that decision belongs where
 * the target's rules are written down.
 */
export function serialiseCsv(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  return rows.map((row) => row.map(serialiseField).join(',')).join('\r\n') + '\r\n';
}
