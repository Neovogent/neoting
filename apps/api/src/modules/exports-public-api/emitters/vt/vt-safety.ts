/**
 * The two things in VT's own changelog that will crash or corrupt a real
 * import, and the guards against them.
 *
 * Both are in this file, together, because both are the same kind of hazard:
 * **they are invisible in our output and only fail inside somebody else's
 * software, on their machine, with their client's books open.** Neither
 * produces a stack trace we would ever see. That is why they are guarded
 * mechanically rather than remembered.
 */

/** Every emitted cell passes through the {@link ExportTarget}-agnostic guards below. */
export class VtEmitterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VtEmitterError';
  }
}

// ---------------------------------------------------------------------------
// LANDMINE 1 — the 16-digit crash
// ---------------------------------------------------------------------------

/**
 * VT builds older than May 2025 **crash on any numeric token longer than 16
 * digits**, wherever it appears — a reference, a note, or the digits inside a
 * URL. Not a rejected row: a crash of the application the accountant is
 * importing into.
 *
 * We cannot know which build the client runs, and the pre-May-2025 population
 * is exactly the population a long-lived desktop product has most of. So the
 * rule is absolute: **no emitted cell contains a run of 17 or more digits.**
 */
export const MAX_VT_NUMERIC_TOKEN_DIGITS = 16;

const LONG_NUMERIC_TOKEN = new RegExp(`\\d{${MAX_VT_NUMERIC_TOKEN_DIGITS + 1},}`);
const LONG_NUMERIC_TOKEN_GLOBAL = new RegExp(LONG_NUMERIC_TOKEN.source, 'g');

/** Does this string carry a digit run long enough to crash VT? The tests assert on this. */
export function containsLongNumericToken(value: string): boolean {
  return LONG_NUMERIC_TOKEN.test(value);
}

/**
 * Break any over-long digit run into 16-digit groups separated by a space.
 *
 * **Break rather than truncate, and break rather than refuse.** The values that
 * can hit this are free text we did not author — an OCR'd invoice number, a
 * payment reference on a statement narrative — and the three available answers
 * rank clearly:
 *
 * - *Truncate*: loses digits, and the result still looks like a reference.
 * - *Refuse the export*: one unusual supplier reference blocks a whole month.
 * - *Break*: every digit survives, the change is visibly a formatting artefact,
 *   and the accountant is told which document it happened to.
 *
 * The caller turns `changed` into an `ExportWarning`. A silent break would be
 * the same failure class as silent flattening (§24.3.4).
 */
export function breakLongNumericTokens(value: string): { value: string; changed: boolean } {
  if (!containsLongNumericToken(value)) return { value, changed: false };

  const broken = value.replaceAll(LONG_NUMERIC_TOKEN_GLOBAL, (run) => {
    const groups = run.match(new RegExp(`\\d{1,${MAX_VT_NUMERIC_TOKEN_DIGITS}}`, 'g')) ?? [run];
    return groups.join(' ');
  });

  return { value: broken, changed: true };
}

// ---------------------------------------------------------------------------
// LANDMINE 2 — Entry details coerces numeric-looking strings
// ---------------------------------------------------------------------------

const CONTAINS_A_LETTER = /[A-Za-z]/;

/**
 * VT's **`Entry details`** column has a documented history of **coercing
 * numeric-looking strings into 2-decimal numbers**. `123456` arrives as
 * `123456.00`.
 *
 * That column is where D43 rung 1 puts the source-document capability code, so
 * the coercion is not cosmetic: it destroys the link the whole release's
 * acceptance test rests on (SoT §24.7 — *click through from a VT entry to the
 * source document*), and it destroys it **silently**, in a file that looks
 * correct.
 *
 * So: **anything written to `Entry details` must contain at least one letter.**
 *
 * This **throws** rather than repairing, and that is the deliberate choice. The
 * only thing that goes in this column is a capability code we mint ourselves;
 * a letterless one is a defect in the minting (A8), not data from a customer.
 * Repairing it would change the code and break the link just as thoroughly,
 * only without telling anyone. An empty cell is allowed — there is nothing
 * there to coerce.
 */
export function assertVtEntryDetailsSafe(value: string): string {
  if (value.length > 0 && !CONTAINS_A_LETTER.test(value)) {
    throw new VtEmitterError(
      `Entry details must contain a letter, got "${value}". VT coerces numeric-looking strings there into 2-decimal numbers, which silently destroys the source-document link (D43 rung 1).`,
    );
  }
  return value;
}
