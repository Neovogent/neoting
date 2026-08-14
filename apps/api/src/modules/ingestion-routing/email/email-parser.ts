import type { ParsedEmail } from './parsed-email.js';

/**
 * Parses raw RFC 5322 / MIME bytes into a {@link ParsedEmail}.
 *
 * MIME parsing of hostile input must not be hand-rolled (issue #14). The
 * concrete parser is a dependency awaiting Shakib's approval on the issue; this
 * interface is the seam it drops in behind — the same interface + fixture
 * pattern as the sanitisation `VirusScanner`. Every consumer takes this
 * interface, so no call site changes when the real parser lands.
 */
export interface EmailParser {
  parse(raw: Buffer): Promise<ParsedEmail>;
}
