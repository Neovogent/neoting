/**
 * An injectable clock so time-based logic is deterministic in tests.
 *
 * A second copy of the WhatsApp lane's three-line clock rather than a shared
 * one: `no-cross-module-internals` would need that module to widen its public
 * seam for a type this small, and a `common/` home for it is a change every
 * module then has to be re-read against. Copied deliberately, noted here.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
