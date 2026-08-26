import { z } from 'zod';

/**
 * The canonical export model — one internal representation, one emitter per
 * target (SoT §24.3). **VT is an emitter, not the architecture.** §21 names
 * scope capture by the first client as a live risk, and the shape of this file
 * is the mitigation: nothing here knows the words `PIN`, `Universal Input
 * Sheet` or `DD/MM/YYYY`. A target's quirks live in its emitter and are not
 * allowed to leak back.
 *
 * **Two record families, deliberately not unified** (§24.3.4). A transaction
 * document (invoice, bill, credit note, receipt) and a bank statement line have
 * irreconcilable shapes; forcing one type over both produces a struct where
 * half the fields are null half the time and every emitter re-derives which
 * half. They share only the identity and provenance block, and that is the
 * whole of what they have in common.
 *
 * **Money is integer pence, signed, everywhere in this file** (R5, Governance
 * §1.7). §24.3.4: *store one signed amount, derive three conventions* — debit
 * positive, credit negative internally, and each emitter derives its target's
 * convention at write time. VT wants unsigned magnitudes because it derives
 * debit and credit from `Type`; that derivation belongs in the VT emitter and
 * nowhere else. **A float never exists in this model.** Pence become a decimal
 * string at the emitter boundary and at no earlier point.
 *
 * **Dates are calendar dates, not instants**, and are held as `YYYY-MM-DD`
 * strings that are never parsed into a `Date`. A period has a first day, not a
 * first microsecond, and a `new Date('2026-08-04')` in a UTC container renders
 * as 3 August the moment anyone formats it in `Europe/London` with the wrong
 * flag. Not constructing the object removes the entire class of bug: the VT
 * emitter rearranges three substrings.
 */

// ---------------------------------------------------------------------------
// Calendar date
// ---------------------------------------------------------------------------

const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Leap-year aware, and entirely integer arithmetic — no `Date` is built. */
function isRealCalendarDate(value: string): boolean {
  const match = ISO_CALENDAR_DATE.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) return false;
  if (day < 1) return false;

  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] ?? 0);
}

/**
 * `YYYY-MM-DD`. Storage and transport order, so it sorts lexicographically and
 * cannot be misread as `MM/DD` by anything downstream. Rendering to UK d/m/y is
 * an emitter's job (rule 8).
 */
export const CalendarDateSchema = z
  .string()
  .refine(isRealCalendarDate, 'Expected a real calendar date as YYYY-MM-DD.');

export type CalendarDate = z.infer<typeof CalendarDateSchema>;

// ---------------------------------------------------------------------------
// The provenance block — and the seam Stage A8 attaches to
// ---------------------------------------------------------------------------

/**
 * ⚠ **THE A8 SEAM.** A8 (`/d/{token}`) has not merged. This is the shape it
 * fills, and the only thing A7 asks of it, so that A8 is an addition rather
 * than a rewrite:
 *
 * - **A8 mints `code`** — a short capability token, and puts nothing else in
 *   this object. The VT emitter writes it into `Entry details` (D43 rung 1).
 * - **A8 builds `url`** — the full `https://…/d/{code}` origin-root link. The
 *   VT emitter writes it into `Transaction notes` (rung 3) with the provenance
 *   tag.
 *
 * Two constraints are enforced here rather than trusted from A8, because both
 * failures are silent in the accountant's software rather than loud in ours:
 *
 * 1. **`code` must contain at least one letter.** VT's `Entry details` column
 *    has a documented history of coercing numeric-looking strings into
 *    2-decimal numbers, so an all-digit code arrives as `123456.00` and
 *    resolves to nothing. The contract's `DocumentLinkCode` parameter carries
 *    the same pattern; this is the second lock on the same door.
 * 2. **`code` is capped at 20 characters.** Reference fields in the export
 *    targets truncate *without warning* — one at 30, another at ~25 — and a
 *    truncated link looks correct and resolves to nothing (SoT §21, §24.3.2).
 *
 * `sourceLink` is nullable only because A8 is not merged. Once it is, a null
 * here is an export that breaks D43, and the VT emitter already says so as an
 * `ExportWarning` rather than shipping a silently linkless file.
 */
export const CanonicalSourceLinkSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(20, 'Capability codes must survive a reference field that truncates at ~25 (§24.3.2).')
    .regex(/[A-Za-z]/, 'A capability code must contain a letter — VT coerces all-digit codes.'),
  url: z.string().min(1),
});

export type CanonicalSourceLink = z.infer<typeof CanonicalSourceLinkSchema>;

/** Identity and provenance — the only block the two record families share. */
const provenance = {
  /** Our document id. Never emitted into a file; it is how a warning names a row. */
  documentId: z.string().min(1),
  businessId: z.string().min(1),
  /** ⚠ A8 fills this. See {@link CanonicalSourceLinkSchema}. */
  sourceLink: CanonicalSourceLinkSchema.nullable(),
};

// ---------------------------------------------------------------------------
// Family 1 — the transaction document
// ---------------------------------------------------------------------------

/**
 * One nominal's worth of a document. A document with more than one of these is
 * exactly the case VT cannot import (§24.3.4: *one nominal per row*), and
 * modelling it honestly here is what lets the VT emitter collapse it **and say
 * so**. Flattening it at extraction time would delete the evidence that
 * anything was flattened.
 */
export const CanonicalAnalysisLineSchema = z.object({
  /**
   * The nominal this value lands in, in canonical form. Emitters decide
   * presentation: VT demands the ledger prefix (`Cost of sales: Purchases`),
   * other targets demand a bare code.
   */
  analysisAccount: z.string().min(1),
  /** Net, signed integer pence. */
  netPence: z.number().int(),
  /** VAT, signed integer pence. VT has no tax codes — the amount is what it stores. */
  vatPence: z.number().int(),
  /** Optional line narrative. Not every target can carry it; three of five cannot. */
  description: z.string().optional(),
});

export type CanonicalAnalysisLine = z.infer<typeof CanonicalAnalysisLineSchema>;

const transactionDocumentShape = z.object({
  family: z.literal('TRANSACTION_DOCUMENT'),
  ...provenance,

  /** Whose ledger the counterparty sits in. With `instrument`, this is the whole of what a target needs to pick its own row type. */
  party: z.enum(['SUPPLIER', 'CUSTOMER']),
  instrument: z.enum(['INVOICE', 'CREDIT_NOTE']),

  date: CalendarDateSchema,

  /**
   * The counterparty's account, as a **name**, with no ledger prefix.
   *
   * ⚠ This string is the highest-leverage detail in the whole export (§24.3.1).
   * VT's Converter maps an incoming account name to a VT account once and saves
   * the mapping in a reusable conversion table. If the string is byte-stable
   * across exports the accountant maps each supplier once and every later
   * import assigns itself; re-deriving, re-casing or re-trimming it silently
   * makes every future export manual again. Emitters must pass it through
   * untouched.
   */
  primaryAccount: z.string().min(1),

  /**
   * A **short** document reference. VT's AutoComplete keys off the field this
   * lands in and VT's own help warns against padding it, so this is the invoice
   * number — not a sentence, and not our document id.
   */
  reference: z.string(),

  /** Gross, signed integer pence. Must equal `netPence + vatPence`. */
  grossPence: z.number().int(),
  /** VAT, signed integer pence. Must equal the sum over `analysis`. */
  vatPence: z.number().int(),
  /** Net, signed integer pence. Must equal the sum over `analysis`. */
  netPence: z.number().int(),

  analysis: z.array(CanonicalAnalysisLineSchema).min(1),
});

// ---------------------------------------------------------------------------
// Family 2 — the bank statement line
// ---------------------------------------------------------------------------

const bankStatementLineShape = z.object({
  family: z.literal('BANK_STATEMENT_LINE'),
  ...provenance,

  /** Money out or money in. With `instrument`, enough for any target's row type. */
  movement: z.enum(['PAYMENT', 'RECEIPT']),
  /** How it moved. `CHEQUE` is a payment-only distinction; the refinement below holds that. */
  instrument: z.enum(['BANK', 'CHEQUE']),

  date: CalendarDateSchema,

  /** The bank account's own name, no ledger prefix — same byte-stability rule as `primaryAccount`. */
  bankAccount: z.string().min(1),
  /** The other side of the entry, canonical form. */
  contraAccount: z.string().min(1),

  /** The statement narrative, as the bank wrote it. */
  description: z.string(),

  grossPence: z.number().int(),
  vatPence: z.number().int(),
  netPence: z.number().int(),
});

// ---------------------------------------------------------------------------
// Arithmetic and sign invariants
// ---------------------------------------------------------------------------

function checkGrossIsNetPlusVat(
  row: { grossPence: number; netPence: number; vatPence: number },
  ctx: z.RefinementCtx,
): void {
  if (row.grossPence !== row.netPence + row.vatPence) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['grossPence'],
      message: `Gross must be net + VAT in integer pence: ${row.grossPence} !== ${row.netPence} + ${row.vatPence}.`,
    });
  }
}

/**
 * All three amounts share one sign, or are zero.
 *
 * A row whose net is positive and whose VAT is negative is not a transaction,
 * it is a parsing accident — and a target that derives its debit/credit from a
 * row type (VT) would emit the magnitudes and post a plausible, wrong entry.
 * Refusing it here is the last place it is cheap to refuse.
 */
function checkSignsAgree(
  row: { grossPence: number; netPence: number; vatPence: number },
  ctx: z.RefinementCtx,
): void {
  const signs = [row.grossPence, row.netPence, row.vatPence]
    .map((pence) => Math.sign(pence))
    .filter((sign) => sign !== 0);

  if (signs.length > 0 && signs.some((sign) => sign !== signs[0])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['grossPence'],
      message:
        'Gross, net and VAT must share one sign (debit positive, credit negative). Mixed signs are a parsing accident, not a transaction.',
    });
  }
}

export const CanonicalTransactionDocumentSchema = transactionDocumentShape.superRefine(
  (row, ctx) => {
    checkGrossIsNetPlusVat(row, ctx);
    checkSignsAgree(row, ctx);

    const analysisNetPence = row.analysis.reduce((sum, line) => sum + line.netPence, 0);
    const analysisVatPence = row.analysis.reduce((sum, line) => sum + line.vatPence, 0);

    if (analysisNetPence !== row.netPence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['analysis'],
        message: `Analysis lines net to ${analysisNetPence}, the document says ${row.netPence}. A row that does not add up becomes a wrong number in someone's books.`,
      });
    }
    if (analysisVatPence !== row.vatPence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['analysis'],
        message: `Analysis lines carry ${analysisVatPence} of VAT, the document says ${row.vatPence}.`,
      });
    }
  },
);

export const CanonicalBankStatementLineSchema = bankStatementLineShape.superRefine((row, ctx) => {
  checkGrossIsNetPlusVat(row, ctx);
  checkSignsAgree(row, ctx);

  if (row.instrument === 'CHEQUE' && row.movement !== 'PAYMENT') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instrument'],
      message: 'A cheque is a payment. A received cheque is a RECEIPT on the BANK instrument.',
    });
  }
});

export type CanonicalTransactionDocument = z.infer<typeof CanonicalTransactionDocumentSchema>;
export type CanonicalBankStatementLine = z.infer<typeof CanonicalBankStatementLineSchema>;

/**
 * The whole canonical model, discriminated on `family`.
 *
 * `z.union` rather than `z.discriminatedUnion` because each member carries a
 * `superRefine` and Zod 3's discriminated union will not accept an effect-
 * wrapped member. The `family` literal still discriminates for TypeScript, and
 * the parse cost of trying two members is nothing next to writing a file.
 */
export const CanonicalRowSchema = z.union([
  CanonicalTransactionDocumentSchema,
  CanonicalBankStatementLineSchema,
]);

export type CanonicalRow = z.infer<typeof CanonicalRowSchema>;

/** The emitter boundary parses with this: rows in, one at a time, named on failure. */
export const CanonicalRowsSchema = z.array(CanonicalRowSchema);
