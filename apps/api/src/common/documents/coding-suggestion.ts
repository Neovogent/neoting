import { z } from 'zod';

/**
 * **Where a coding suggestion lives between the pipeline that produces it and
 * the screen that renders it — and the parse that stands between them.**
 *
 * ## Why there is no column
 *
 * A suggestion is a *read* of one extraction run: it is produced from the same
 * document, by the same pass, at the same moment as the fields, and it is
 * superseded wholesale by the next run. That is the `extractions` row's own
 * lifetime, and the row already carries per-value `provenance` and `confidence`
 * for exactly the same §13.3 reason. So it rides **inside `extractions.fields`**
 * under a reserved key, the way `lineItems` already does (METH S4; the pipeline
 * writes it, `document-response.ts` separates it again on the read projection).
 *
 * A `documents.coding_suggestion` column would have been a second place a
 * document's coding is written down, one that survives a re-extraction it no
 * longer describes — and `prisma/` is LAW (G7), so it would also have been a
 * contract-change issue for a value that has a correct home already.
 *
 * ⚠ **The key MUST be stripped from `fields` on the way out.** The contract
 * types `Extraction.fields` as a map of `ExtractedField` and the generated
 * client parses it strictly, so anything else left under that key fails every
 * `GET /documents/{id}` in the browser the moment a document has been read.
 * That is not hypothetical: it is precisely the bug `lineItems` caused (#137).
 *
 * ## Why it is parsed rather than cast
 *
 * `fields` is a `Json` column, so what comes back is whatever was written — by
 * this release, by an older one, or by a hand edit. A database is a boundary
 * exactly as a request body is (Governance: Zod at every boundary, including the
 * database). A payload that does not parse is dropped, and the Category row
 * falls back to the em dash it showed before — never a half-rendered opinion.
 */

/**
 * The reserved key inside `extractions.fields`.
 *
 * ⚠ It can never collide with a real extracted field: the header field list is
 * closed (`bedrock-extraction-schema.ts`) and no field on it is named for a
 * judgement about the document as a whole.
 */
export const CODING_SUGGESTION_KEY = 'codingSuggestion';

const SecondChoiceSchema = z.object({
  categoryCode: z.string().min(1),
  analysisAccount: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/**
 * The stored shape — deliberately **identical to the contract's
 * `CodingSuggestion`**, so the read projection is a parse and not a translation.
 * Every property is present and nullable rather than optional: an absent key and
 * an explicit null are different things under `exactOptionalPropertyTypes`, and
 * a suggestion that omitted `escalationReason` would be indistinguishable from
 * one written by a release that did not have the concept.
 */
export const StoredCodingSuggestionSchema = z.object({
  outcome: z.enum(['SUGGEST', 'ESCALATE']),
  /** Always `AI_SUGGESTED`. A suggestion that claimed to be deterministic would be a coding. */
  provenance: z.literal('AI_SUGGESTED'),
  basis: z.string().min(1),
  /** The rendered sentence. Never a JSON blob, never a quoted line description. */
  note: z.string().min(1),
  categoryCode: z.string().nullable(),
  analysisAccount: z.string().nullable(),
  /** ⚠ For display only. No branch in this repository may compare it to a number. */
  confidence: z.number().min(0).max(1).nullable(),
  treatment: z.enum(['CAPITAL', 'REVENUE']).nullable(),
  secondChoice: SecondChoiceSchema.nullable(),
  escalationReason: z.string().nullable(),
  candidateCategoryCodes: z.array(z.string()),
  advisories: z.array(z.string()),
});

export type StoredCodingSuggestion = z.infer<typeof StoredCodingSuggestionSchema>;

/**
 * A smuggled `fields.codingSuggestion` value → the shape the contract carries,
 * or `null` when it is not one.
 *
 * `null` is the honest answer for every failure here — a suggestion is an
 * optional extra on a document that renders perfectly well without one, so a
 * malformed payload must degrade to "no suggestion" rather than to a 500 on the
 * document detail.
 */
export function readStoredCodingSuggestion(value: unknown): StoredCodingSuggestion | null {
  if (value === undefined || value === null) return null;
  const parsed = StoredCodingSuggestionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
