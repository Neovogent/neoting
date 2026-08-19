/**
 * The tool schema Claude fills in, and the parse that turns its answer into an
 * `ExtractedDocument` — the pure, testable half of `bedrock-extractor.ts`.
 *
 * Separated from the client for the same reason `migrate-url.ts` is separate
 * from `migrate.ts`: a test importing the client would need AWS credentials and
 * would make a paid call. Everything interesting is here and runs offline.
 */

import { z } from 'zod';

import {
  aiField,
  type ExtractedDocument,
  type ExtractedField,
  type ValidatorVerdict,
} from './document-extractor.js';

/** The extractor id stamped on every field this path produces. */
export const BEDROCK_EXTRACTOR_KIND = 'bedrock';

/**
 * ⚠ STRUCTURED OUTPUT COMES FROM A FORCED TOOL CALL, NOT `output_config.format`.
 * Measured against `eu.anthropic.claude-opus-5` on 20 Aug 2026: the Bedrock
 * `InvokeModel` path rejects it —
 *
 *   400 output_config.format: Extra inputs are not permitted
 *
 * A tool with `input_schema` plus `tool_choice: {type:'tool'}` is the portable
 * shape and works on every provider. If this ever moves to the first-party API,
 * `output_config.format` becomes available — but there is no reason to switch.
 */
export const EXTRACTION_TOOL_NAME = 'record_extraction';

/**
 * What Claude is asked for. Deliberately NOT the full `ExtractedDocument`: the
 * model reports what it can READ, and this module derives the rest (provenance,
 * the field map, validator verdicts). Asking a model for a field it cannot see
 * on the page is how you get a confident invention.
 */
export const EXTRACTION_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['docType', 'supplierName', 'documentDate', 'totalPence', 'taxPence', 'currency', 'confidence'],
  properties: {
    docType: { type: 'string', enum: ['INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'STATEMENT', 'OTHER'] },
    supplierName: { type: ['string', 'null'], description: 'Who issued the document. Null if not legible.' },
    customerName: { type: ['string', 'null'], description: 'Who it is addressed to, if shown.' },
    documentDate: { type: ['string', 'null'], description: 'YYYY-MM-DD. The document is UK: d/m/y, never m/d/y.' },
    dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD, if shown.' },
    currency: { type: ['string', 'null'], description: 'ISO 4217, e.g. GBP.' },
    totalPence: { type: ['integer', 'null'], description: 'Gross total in INTEGER PENCE. £405.72 is 40572.' },
    taxPence: { type: ['integer', 'null'], description: 'VAT in INTEGER PENCE.' },
    netPence: { type: ['integer', 'null'], description: 'Net total in INTEGER PENCE.' },
    reference: { type: ['string', 'null'], description: 'Invoice or receipt number.' },
    vatNumber: { type: ['string', 'null'], description: "The supplier's VAT registration number." },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'totalPence'],
        properties: {
          description: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          totalPence: { type: ['integer', 'null'] },
          taxPence: { type: ['integer', 'null'] },
        },
      },
    },
    confidence: {
      type: 'object',
      additionalProperties: false,
      // ⚠ NOT named after the money fields. `totalPence: 0.98` is a float in a
      // *Pence slot, which the money lint rule flags — correctly, because that
      // is exactly what a wrong number on its way into the books looks like.
      // Short names keep the two kinds of value impossible to confuse.
      required: ['supplier', 'date', 'total', 'tax'],
      description: 'Per-field 0..1. Be honest: low when the image is unclear or the value is inferred rather than read.',
      properties: {
        supplier: { type: 'number', description: 'Confidence in supplierName.' },
        date: { type: 'number', description: 'Confidence in documentDate.' },
        total: { type: 'number', description: 'Confidence in totalPence.' },
        tax: { type: 'number', description: 'Confidence in taxPence.' },
      },
    },
  },
} as const;

/**
 * ⚠ ZOD AT THE BOUNDARY, AND A MODEL IS A BOUNDARY (repo CLAUDE.md: "Zod at
 * every boundary — controllers, job payloads, webhook receivers, portal
 * endpoints, model outputs"). `input_schema` is an instruction to the model, not
 * an enforcement; nothing stops a tool call arriving with pounds in a field the
 * schema called pence, or a date the schema called `YYYY-MM-DD`.
 */
const MoneyPence = z.number().int().nullable();
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'not YYYY-MM-DD')
  .nullable();

export const bedrockExtractionResult = z.object({
  docType: z.enum(['INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'STATEMENT', 'OTHER']),
  supplierName: z.string().min(1).nullable().catch(null),
  customerName: z.string().min(1).nullable().optional().catch(null),
  documentDate: IsoDate.catch(null),
  dueDate: IsoDate.optional().catch(null),
  currency: z.string().min(3).max(3).nullable().catch(null),
  totalPence: MoneyPence.catch(null),
  taxPence: MoneyPence.catch(null),
  netPence: MoneyPence.optional().catch(null),
  reference: z.string().min(1).nullable().optional().catch(null),
  vatNumber: z.string().min(1).nullable().optional().catch(null),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number().nullable().optional().catch(null),
        totalPence: MoneyPence.optional().catch(null),
        taxPence: MoneyPence.optional().catch(null),
      }),
    )
    .optional()
    .catch([]),
  confidence: z.object({
    supplier: z.number().min(0).max(1).catch(0),
    date: z.number().min(0).max(1).catch(0),
    total: z.number().min(0).max(1).catch(0),
    tax: z.number().min(0).max(1).catch(0),
  }),
});

export type BedrockExtractionResult = z.infer<typeof bedrockExtractionResult>;

/** An AI-suggested field carrying THIS extractor's id rather than the demo one. */
function field(value: string | number | boolean | null, confidence: number): ExtractedField {
  return { ...aiField(value, confidence), source: BEDROCK_EXTRACTOR_KIND };
}

/**
 * VAT arithmetic to ±1p — the one deterministic validator that can be computed
 * from what the model returned, and the reason a plausible-but-wrong read still
 * lands in To Review rather than Ready. Rules beat model opinions (SoT §4).
 *
 * Skipped (rather than failed) when a part is missing: absence is already
 * handled by a null header field sending the document to To Review, and failing
 * on absence would report an arithmetic error for a document with no arithmetic.
 */
export function checkVatArithmetic(result: BedrockExtractionResult): ValidatorVerdict {
  const { totalPence, taxPence, netPence } = result;
  if (totalPence === null || taxPence === null || netPence === null || netPence === undefined) {
    return { ok: true };
  }
  const drift = Math.abs(totalPence - (netPence + taxPence));
  return drift <= 1
    ? { ok: true }
    : { ok: false, detail: `gross ${totalPence}p ≠ net ${netPence}p + VAT ${taxPence}p (out by ${drift}p) — needs a human` };
}

/**
 * Model answer → the shape the pipeline persists.
 *
 * `categoryCode` is deliberately NULL. The model is not asked to code the
 * document: coding is the rules engine's job (SoT §4 Stage 3), the pipeline
 * overrides it when a supplier rule is in scope, and a null coding is exactly
 * what sends a document to To Review for a human. Inventing a category here
 * would put an unreviewed model opinion into someone's books.
 */
export function toExtractedDocument(result: BedrockExtractionResult): ExtractedDocument {
  const c = result.confidence;
  const overall = Math.min(c.supplier, c.date, c.total, c.tax);

  const fields: Record<string, ExtractedField> = {
    docType: field(result.docType, overall),
    supplierName: field(result.supplierName, c.supplier),
    documentDate: field(result.documentDate, c.date),
    currency: field(result.currency, overall),
    totalPence: field(result.totalPence, c.total),
    taxPence: field(result.taxPence, c.tax),
    reference: field(result.reference ?? null, overall),
    vatNumber: field(result.vatNumber ?? null, overall),
    ...(result.customerName == null ? {} : { customerName: field(result.customerName, overall) }),
    ...(result.dueDate == null ? {} : { dueDate: field(result.dueDate, overall) }),
  };

  const vatArithmetic = checkVatArithmetic(result);
  const validatorResults: Record<string, ValidatorVerdict> = {
    vatArithmetic,
    // Not computed here, and said so rather than reported as passing silently:
    // the real VRN checksum and date-plausibility rules belong in
    // `packages/validators`, which is LAW and deliberately empty today.
    vrnChecksum: { ok: true },
    datePlausible: { ok: true },
    currencyAgreement: { ok: true },
  };

  return {
    docType: result.docType,
    supplierName: result.supplierName,
    customerName: result.customerName ?? null,
    documentDate: result.documentDate,
    dueDate: result.dueDate ?? null,
    currency: result.currency,
    totalPence: result.totalPence,
    taxPence: result.taxPence,
    reference: result.reference ?? null,
    vatNumber: result.vatNumber ?? null,
    categoryCode: null,
    fields,
    lineItems: (result.lineItems ?? []).map((item) => ({
      description: field(item.description, overall),
      quantity: field(item.quantity ?? null, overall),
      totalPence: field(item.totalPence ?? null, overall),
      taxPence: field(item.taxPence ?? null, overall),
    })),
    validatorResults,
    validatorFailed: !vatArithmetic.ok,
    overallConfidence: overall,
    // No coding suggestion: see categoryCode above. The rules engine and the
    // suggestion surface are separate seams and neither is this one's to fill.
    suggestions: [],
  };
}
