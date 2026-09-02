import { useMemo } from 'react';
import {
  approveActionProposal,
  createActionProposal,
  getGetDocumentQueryKey,
  getListDocumentEventsQueryKey,
  getListDocumentsQueryKey,
  reviewActionProposal,
  useGetDocument,
  useGetDocumentOriginal,
  useListDocumentEvents,
} from '@neoting/contracts/client';
import {
  createActionProposalBody,
  getDocumentOriginalResponse,
  getDocumentResponse,
  listDocumentEventsResponse,
} from '@neoting/contracts/zod';
import { DocumentType, type UpdateCodingPayload } from '@neoting/contracts/model';
import type { QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { ExtractedField as LocalExtractedField, FieldBoundingBox, LineItem as LocalLineItem } from '../lib/types';
import { fromIsoDate } from './documents';
import { currency } from '../lib/resolver';
import { unwrapBody } from './envelope';

/**
 * Pounds back to integer pence, for the values that leave the app. Rounded,
 * never truncated: 0.1 + 0.2 is 0.30000000000000004 pounds, and a truncating
 * conversion books 29 pence. Canonical here rather than in `documents.ts` for
 * a bundle reason: that module ships on every route's floor and nothing there
 * converts in this direction — the MSW fixtures import it from here.
 */
export const toPence = (pounds: number): number => Math.round(pounds * 100);

/**
 * The document detail, read from the API (METH S7): the accepted extraction
 * with per-field confidence and provenance (SoT §13.3), the presigned link to
 * the immutable original, and the per-document processing log.
 *
 * Deliberately NOT part of `documents.ts`: that module is imported by
 * `AppContext` and therefore ships on every route's shared floor, which has
 * ~1 kB of budget headroom (apps/web/CLAUDE.md, Bundle). This one is imported
 * only by the document screens, so its weight lands on their chunks.
 *
 * Everything crossing the wire is parsed by the generated Zod schemas — the
 * generated *types* describe an envelope that does not exist at runtime (see
 * `unwrapBody` in documents.ts), so every body is read as `unknown` first.
 */

type WireDocument = z.infer<typeof getDocumentResponse>;

/**
 * ⚠ `getDocumentResponse` REFUSES EVERY VALID DOCUMENT, and this is the
 * documented generator gap — not a drifted server.
 *
 * `Document` is `allOf: [DocumentSummary, {…}]`. orval emits that as a Zod
 * INTERSECTION of two `.strict()` halves, and each half rejects the other's
 * keys, so the composed parse can never succeed:
 *
 *   Unrecognized key(s): 'mimeType', 'byteSize', 'byteHash', … ;
 *   byteHash: Invalid; acceptedExtraction: Invalid input
 *
 * — one half complaining about the other half's fields, on a body that is
 * perfectly correct. `packages/contracts/CLAUDE.md` records the gap and names
 * the two consumers already working around it; `api/chases.ts` does exactly
 * this for `getChaseResponse`.
 *
 * The symptom was not a visible error: the detail parse failed, so the document
 * screen rendered "No fields extracted" over a document whose fields the server
 * had sent in full.
 *
 * The halves are unwrapped from the intersection and `.strip()`ped, so each
 * validates its own fields and ignores the other's. **When orval fixes the
 * generation this whole block deletes** — the test pins the gap so that shows
 * up as a failure rather than as a mystery.
 */
interface StrictHalf {
  readonly shape: Record<string, unknown>;
  strip(): { safeParse(value: unknown): { success: boolean; data?: unknown; error?: z.ZodError } };
}

const documentHalves = (getDocumentResponse as unknown as { _def: { left: StrictHalf; right: StrictHalf } })._def;
/** The detail half is the one carrying `byteHash`; the summary half is the other. */
const detailIsRight = documentHalves.right !== undefined && 'byteHash' in documentHalves.right.shape;
const summaryHalf = (detailIsRight ? documentHalves.left : documentHalves.right).strip();
const detailHalf = (detailIsRight ? documentHalves.right : documentHalves.left).strip();

export type DocumentDetailParse =
  | { ok: true; value: WireDocument }
  | { ok: false; detail: string };

/** A `GET /documents/{id}` body → a contract `Document`, or the reason it is not one. */
export function parseDocumentDetail(body: unknown): DocumentDetailParse {
  const summary = summaryHalf.safeParse(body);
  const detail = detailHalf.safeParse(body);
  if (!summary.success || !detail.success) {
    const error = (summary.success ? detail.error : summary.error) as z.ZodError | undefined;
    return { ok: false, detail: error === undefined ? 'response: did not match the contract' : firstIssues(error) };
  }
  return { ok: true, value: { ...(summary.data as object), ...(detail.data as object) } as WireDocument };
}
type WireExtraction = NonNullable<WireDocument['acceptedExtraction']>;
type WireField = WireExtraction['fields'][string];

/* ── the field presentation table ─────────────────────────────────────────── */

export type DraftKind = 'text' | 'money' | 'date' | 'currency' | 'docType';

interface FieldPresentation {
  /** The extraction key on the wire. */
  readonly key: string;
  /**
   * What the row is called on screen. These are data, not catalogue copy — the
   * synthetic seeds carry the identical strings, and the readiness rules
   * (`lib/selectors.ts`, `mandatoryFields`) compare against them by value, so
   * they must be byte-identical across both data sources and never vary by
   * locale.
   */
  readonly label: string;
  /** The `UpdateCodingPayload.fields` key a correction writes, or null when the contract has none. */
  readonly coding: keyof UpdateCodingPayload['fields'] | null;
  readonly kind: DraftKind;
}

/** Wire key → label/editability, in the order an accountant reads a document. */
export const FIELD_PRESENTATION: readonly FieldPresentation[] = [
  { key: 'supplierName', label: 'Supplier', coding: 'supplierName', kind: 'text' },
  { key: 'customerName', label: 'Customer', coding: 'customerName', kind: 'text' },
  { key: 'documentDate', label: 'Document date', coding: 'documentDate', kind: 'date' },
  { key: 'dueDate', label: 'Due date', coding: 'dueDate', kind: 'date' },
  { key: 'reference', label: 'Invoice number', coding: 'reference', kind: 'text' },
  { key: 'totalPence', label: 'Total', coding: 'totalPence', kind: 'money' },
  { key: 'taxPence', label: 'Tax amount', coding: 'taxPence', kind: 'money' },
  { key: 'currency', label: 'Currency', coding: 'currency', kind: 'currency' },
  { key: 'categoryCode', label: 'Category', coding: 'categoryCode', kind: 'text' },
  { key: 'vatNumber', label: 'VAT number', coding: null, kind: 'text' },
  { key: 'docType', label: 'Type', coding: 'docType', kind: 'docType' },
];

const PRESENTATION_BY_LABEL = new Map(FIELD_PRESENTATION.map((p) => [p.label, p]));

/**
 * The Category row's label, named once.
 *
 * It is the row a coding suggestion is about, and `BASE_MANDATORY` matches on
 * the same string by value — so a caller reaching for that row must not type
 * the word again. Read off the table rather than written out, which is what
 * makes it impossible for this constant and the table to disagree.
 */
export const CATEGORY_LABEL: string = FIELD_PRESENTATION.find((p) => p.coding === 'categoryCode')?.label ?? 'Category';

/**
 * Money on a field row, in the DOCUMENT'S OWN currency.
 *
 * ⚠ This was a second, £-only formatter living beside `lib/resolver.ts`'s, and
 * it is how a USD invoice still read `£54,352.51` on its own detail panel after
 * the shared helper was fixed. The extraction carries a `currency` field (it is
 * in `FIELD_PRESENTATION` and rendered as its own row), so the symbol is a fact
 * we hold, never an assumption. Falls back to GBP only when the extraction
 * genuinely has no currency.
 */
const moneyDisplay = (pence: number, code: string): string => currency(pence / 100, code);

function renderValue(kind: DraftKind, value: WireField['value'], code: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'money' && typeof value === 'number') return moneyDisplay(value, code);
  if (kind === 'date') return fromIsoDate(String(value));
  return String(value);
}

/**
 * The wire boundingBox as a usable box, or undefined. The generated schema
 * types every member optional (the spec has no `required` list on the box), so
 * the one honest reading is all-or-nothing: a box missing any coordinate — or
 * with no area — positions nothing, and the preview falls back to framing the
 * whole original. Exported for the projection test.
 */
export function usableBoundingBox(box: WireField['boundingBox']): FieldBoundingBox | undefined {
  if (box === null || box === undefined) return undefined;
  const { page, x, y, width, height } = box;
  if (page === undefined || x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (!(width > 0) || !(height > 0)) return undefined;
  return { page, x, y, width, height };
}

/**
 * The provenance line under a value — the §13.3 class as a person reads it.
 * Free text like the seeds' (this is data beside the value, not a message id),
 * citing the source the contract carried.
 */
function provenanceText(field: WireField): string {
  if (field.provenance === 'HUMAN_CONFIRMED') {
    return field.wasCorrected ? 'human confirmed — corrected in review' : 'human confirmed';
  }
  if (field.provenance === 'DETERMINISTIC') {
    return field.source ? `deterministic: ${field.source}` : 'deterministic';
  }
  return field.source ? `AI suggested: ${field.source}` : 'AI suggested';
}

/* ── wire → screen mapping (pure, tested) ─────────────────────────────────── */

export interface DetailEvent {
  id: string;
  stage: string;
  outcome: string;
  durationMs: number | null;
  at: string;
}

/**
 * What the coding ladder worked out for a document nothing coded — **an
 * opinion, never a coding** (`CodingSuggestion` in the contract).
 *
 * The screen shape is deliberately the wire shape with the nullables settled,
 * because there is nothing to translate: every sentence on it is composed
 * server-side by the engine that took the decision. `note` is the rendered
 * sentence — one of ten escalation prompts, or "Suggested — not applied — as
 * X, on <rule>", with any advisories already appended. **Do not write UK tax
 * copy here**: a second wording of "the licence term is not stated on this
 * document" would be a second opinion, authored by someone who did not read
 * the document.
 */
export interface CodingSuggestionView {
  outcome: 'SUGGEST' | 'ESCALATE';
  /** The named rule behind the answer — §13.3's "show the working". */
  basis: string;
  /** The engine's own sentence. Rendered verbatim; never re-worded here. */
  note: string;
  categoryCode: string | null;
  analysisAccount: string | null;
  /** ⚠ For display only (§13.3). Nothing in this app may branch on the value. */
  confidence: number | null;
  escalationReason: string | null;
  /** The codes the lines pointed at when they pointed at several. */
  candidateCategoryCodes: string[];
}

/**
 * The accepted extraction's suggestion, or `null`.
 *
 * ⚠ **A suggestion is dropped for a document something already coded.** The
 * pipeline does not produce one in that case, so this is belt-and-braces for a
 * row an older release wrote — but the rule matters more than the likelihood:
 * a suggestion shown beside an accountant's own rule is not extra information,
 * it is pressure to second-guess an explicit instruction.
 */
export function toCodingSuggestion(doc: WireDocument): CodingSuggestionView | null {
  const wire = doc.acceptedExtraction?.codingSuggestion;
  if (wire === null || wire === undefined) return null;
  if (doc.categoryCode !== null && doc.categoryCode !== undefined) return null;
  return {
    outcome: wire.outcome,
    basis: wire.basis,
    note: wire.note,
    categoryCode: wire.categoryCode ?? null,
    analysisAccount: wire.analysisAccount ?? null,
    confidence: wire.confidence ?? null,
    escalationReason: wire.escalationReason ?? null,
    candidateCategoryCodes: [...(wire.candidateCategoryCodes ?? [])],
  };
}

export interface DocumentDetailData {
  fields: LocalExtractedField[];
  lineItems: LocalLineItem[];
  state: string;
  businessId: string;
  /** The ladder's opinion about an uncoded document, or null. Never a coding. */
  codingSuggestion: CodingSuggestionView | null;
}

/**
 * The accepted extraction in the shape every screen already renders. Category
 * needs its own answer: until a human corrects it, the category is not an
 * extraction field at all — it is the denormalised header value the pipeline
 * coded, and when a supplier rule set it the extract event says so
 * (`detail.sourceRuleId`), which is the honest provenance to show.
 */
export function toDetailData(doc: WireDocument, ruleId: string | null): DocumentDetailData {
  const extraction = doc.acceptedExtraction;
  const codingSuggestion = toCodingSuggestion(doc);
  const wireFields: Record<string, WireField> = extraction?.fields ?? {};
  const fields: LocalExtractedField[] = [];
  // The document's own currency, read once and used for every money row on it.
  const rawCurrency = wireFields['currency']?.value;
  const docCurrency = typeof rawCurrency === 'string' && /^[A-Za-z]{3}$/.test(rawCurrency)
    ? rawCurrency.toUpperCase()
    : 'GBP';

  for (const p of FIELD_PRESENTATION) {
    const field = wireFields[p.key];
    if (field !== undefined) {
      const boundingBox = usableBoundingBox(field.boundingBox);
      fields.push({
        label: p.label,
        value: renderValue(p.kind, field.value, docCurrency),
        // The contract pairs confidence with AI_SUGGESTED and nulls it
        // otherwise — a human answer is not a probability. 1 renders that
        // certainty in the existing confidence UI without a special case.
        confidence: field.confidence ?? 1,
        provenance: provenanceText(field),
        // Omitted, never explicit-undefined: exactOptionalPropertyTypes makes
        // those two different keys, and the seeds omit it.
        ...(boundingBox === undefined ? {} : { boundingBox }),
      });
    } else if (p.key === 'categoryCode' && extraction) {
      // ⚠ **The VALUE stays the em dash when nothing coded the document, even
      // when there is a suggestion, and that is the whole safety of this row.**
      // `DocumentPreview`'s Path-to-Ready panel decides what is missing by
      // testing `value === '—'` against the server's own mandatory set (Total +
      // Supplier + Category). Writing a suggested code in here would make the
      // screen say a document is one field from Ready when nothing has coded
      // it, and the accountant would be reading an opinion as a fact. The
      // suggestion is rendered as a suggestion, beside the row, and becomes a
      // value only when an approved `document.update-coding` says so.
      fields.push({
        label: p.label,
        value: doc.categoryCode ?? '—',
        confidence:
          ruleId !== null
            ? 1
            : codingSuggestion !== null
              // Display only. `ESCALATE` carries no confidence because there is
              // no coding to be confident about — zero is the honest number and
              // it renders the row amber, which is where the eye should go.
              ? (codingSuggestion.confidence ?? 0)
              : (extraction.overallConfidence ?? 1),
        provenance:
          ruleId !== null
            ? `supplier rule: ${ruleId}`
            : // The engine's own sentence, so the band caption explains the
              // empty field instead of claiming the extractor suggested
              // something it never produced.
              (codingSuggestion?.note ?? `AI suggested: ${extraction.modelVersion ?? 'extraction'}`),
      });
    }
  }

  const lineItems: LocalLineItem[] = (extraction?.lineItems ?? []).map((item) => ({
    description: String(item.description?.value ?? '—'),
    quantity: typeof item.quantity?.value === 'number' ? item.quantity.value : 1,
    total: typeof item.totalPence?.value === 'number' ? item.totalPence.value / 100 : 0,
    tax: typeof item.taxPence?.value === 'number' ? item.taxPence.value / 100 : 0,
  }));

  return { fields, lineItems, state: doc.state, businessId: doc.businessId, codingSuggestion };
}

/** The extract stage's recorded rule, if one coded this document. */
export function ruleIdFromEvents(events: ReadonlyArray<{ stage: string; detail?: Record<string, unknown> | null | undefined }>): string | null {
  const extract = events.find((e) => e.stage === 'extract');
  const ruleId = extract?.detail?.['sourceRuleId'];
  return typeof ruleId === 'string' ? ruleId : null;
}

/* ── the hook ─────────────────────────────────────────────────────────────── */

export interface UseDocumentDetailOptions {
  documentId: string;
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
  /** Poll while the pipeline is still working, so Processing becomes Ready on screen. */
  poll?: boolean;
}

export interface DocumentDetail extends DocumentDetailData {
  isLoading: boolean;
  /** Set when a server answer did not match the contract. */
  contractError: string | null;
  image: { url: string; mimeType: string; filename: string | null } | null;
  events: DetailEvent[];
}

const EMPTY: DocumentDetailData = { fields: [], lineItems: [], state: '', businessId: '', codingSuggestion: null };

const firstIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
    .join('; ');

export function useDocumentDetail({ documentId, enabled, poll = false }: UseDocumentDetailOptions): DocumentDetail {
  const interval = poll ? 2_500 : (false as const);
  const docQuery = useGetDocument(documentId, { query: { enabled, refetchInterval: interval } });
  // The presigned URL is bearer authority with a five-minute life; hold it
  // fresh enough not to re-sign on every hover, short enough never to hand an
  // <img> a dead link.
  const originalQuery = useGetDocumentOriginal(documentId, { query: { enabled, staleTime: 4 * 60_000 } });
  const eventsQuery = useListDocumentEvents(documentId, undefined, { query: { enabled, refetchInterval: interval } });

  return useMemo(() => {
    const failures: string[] = [];

    let events: DetailEvent[] = [];
    let ruleId: string | null = null;
    if (eventsQuery.data !== undefined) {
      const parsed = listDocumentEventsResponse.safeParse(unwrapBody(eventsQuery.data));
      if (parsed.success) {
        events = parsed.data.data.map((e) => ({
          id: e.id,
          stage: e.stage,
          outcome: e.outcome,
          durationMs: e.durationMs ?? null,
          at: e.createdAt,
        }));
        ruleId = ruleIdFromEvents(parsed.data.data);
      } else {
        failures.push(firstIssues(parsed.error));
      }
    }

    let data = EMPTY;
    if (docQuery.data !== undefined) {
      const parsed = parseDocumentDetail(unwrapBody(docQuery.data));
      if (parsed.ok) data = toDetailData(parsed.value, ruleId);
      else failures.push(parsed.detail);
    }

    let image: DocumentDetail['image'] = null;
    if (originalQuery.data !== undefined) {
      const parsed = getDocumentOriginalResponse.safeParse(unwrapBody(originalQuery.data));
      if (parsed.success) {
        image = { url: parsed.data.url, mimeType: parsed.data.mimeType, filename: parsed.data.filename ?? null };
      } else {
        failures.push(firstIssues(parsed.error));
      }
    }

    return {
      ...data,
      events,
      image,
      isLoading: docQuery.isLoading || eventsQuery.isLoading,
      contractError: failures.length > 0 ? failures.join(' · ') : null,
    };
  }, [docQuery.data, docQuery.isLoading, originalQuery.data, eventsQuery.data, eventsQuery.isLoading]);
}

/* ── corrections: draft → contract payload ────────────────────────────────── */

export type DraftProblem = 'empty' | 'not-money' | 'not-date' | 'not-currency' | 'not-doc-type' | 'not-editable';

export type DraftResult =
  | { ok: true; coding: keyof UpdateCodingPayload['fields']; fields: UpdateCodingPayload['fields']; display: string }
  | { ok: false; problem: DraftProblem };

const MONTH_BY_NAME: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Accepts the contract's `2026-08-09` or the screen's own `9 Aug 2026`. */
function draftToIsoDate(draft: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(draft)) return draft;
  const parts = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(draft);
  if (!parts) return null;
  const month = MONTH_BY_NAME[(parts[2] ?? '').toLowerCase()];
  if (month === undefined) return null;
  return `${parts[3]}-${String(month).padStart(2, '0')}-${String(parts[1]).padStart(2, '0')}`;
}

/**
 * A typed-in correction, turned into the exact `UpdateCodingPayload.fields`
 * the proposal carries — or a named refusal the component translates. Money is
 * the boundary that matters: the draft is pounds as a person writes them
 * (`1299`, `£1,299.00`), the payload is integer pence, and the conversion
 * happens exactly once, here.
 */
export function parseCodingDraft(label: string, draft: string, docCurrency = 'GBP'): DraftResult {
  const presentation = PRESENTATION_BY_LABEL.get(label);
  if (!presentation || presentation.coding === null) return { ok: false, problem: 'not-editable' };

  const value = draft.trim();
  if (value === '' || value === '—') return { ok: false, problem: 'empty' };
  const coding = presentation.coding;

  if (presentation.kind === 'money') {
    // Strip whatever symbol the row was rendered with, not £ alone — a
    // corrected USD total arrives as "$1,299.00" and must not be refused as
    // "not money" because the symbol was not sterling.
    const bare = value.replace(/[^\d.]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(bare)) return { ok: false, problem: 'not-money' };
    const pence = toPence(Number(bare));
    // Echoed back in the document's own currency, so the confirmation matches
    // the row the accountant just edited.
    return { ok: true, coding, fields: { [coding]: pence }, display: moneyDisplay(pence, docCurrency) };
  }
  if (presentation.kind === 'date') {
    const iso = draftToIsoDate(value);
    if (iso === null) return { ok: false, problem: 'not-date' };
    return { ok: true, coding, fields: { [coding]: iso }, display: fromIsoDate(iso) };
  }
  if (presentation.kind === 'currency') {
    if (!/^[A-Za-z]{3}$/.test(value)) return { ok: false, problem: 'not-currency' };
    const iso = value.toUpperCase();
    return { ok: true, coding, fields: { [coding]: iso }, display: iso };
  }
  if (presentation.kind === 'docType') {
    const upper = value.toUpperCase().replace(/[\s-]+/g, '_');
    if (!Object.values(DocumentType).includes(upper as DocumentType)) return { ok: false, problem: 'not-doc-type' };
    return { ok: true, coding, fields: { [coding]: upper }, display: upper };
  }
  return { ok: true, coding, fields: { [coding]: value }, display: value };
}

/** Whether a row's value can be corrected through `document.update-coding` at all. */
export function isEditableLabel(label: string): boolean {
  return (PRESENTATION_BY_LABEL.get(label)?.coding ?? null) !== null;
}

/* ── the proposal ─────────────────────────────────────────────────────────── */

export interface UpdateCodingRequest {
  businessId: string;
  documentId: string;
  fields: UpdateCodingPayload['fields'];
}

/**
 * Correct a document's coding — **through Review → Approve, because there is
 * no other door** (Governance §10; SoT §8.2 names confirming coding as a state
 * change). Three calls in the one order the server permits: create, open the
 * review, approve echoing back the review's `renderedSummaryHash`. The hash is
 * never recomputed here — a client that computed its own hash would be
 * attesting to its own render. Same shape as `bank.ts`'s
 * `confirmMatchProposal`; the duplication is the two payloads, not the rule.
 */
export async function updateCodingProposal(request: UpdateCodingRequest): Promise<void> {
  const body = {
    kind: 'document.update-coding' as const,
    businessId: request.businessId,
    payload: { documentId: request.documentId, fields: request.fields },
  };
  // The outbound boundary, checked by the contract's own schema before the
  // network — a pence value that is not an integer is refused right here.
  createActionProposalBody.parse(body);

  const created = unwrapBody(await createActionProposal(body)) as { id?: string };
  if (typeof created.id !== 'string') throw new Error('the proposal was created without an id');

  const reviewed = unwrapBody(await reviewActionProposal(created.id)) as { renderedSummaryHash?: string };
  if (typeof reviewed.renderedSummaryHash !== 'string') throw new Error('the review returned no summary hash to echo');

  await approveActionProposal(created.id, { renderedSummaryHash: reviewed.renderedSummaryHash });
}

/** Server truth replaces the optimistic render: list, detail and log together. */
export async function refreshDocument(queryClient: QueryClient, documentId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getGetDocumentQueryKey(documentId) }),
    queryClient.invalidateQueries({ queryKey: getListDocumentEventsQueryKey(documentId) }),
  ]);
}
