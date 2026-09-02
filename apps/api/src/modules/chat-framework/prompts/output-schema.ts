import { z } from 'zod';

/**
 * What the model is allowed to say (Governance §9.2: every structured model
 * response is parsed with a Zod schema in `.strict()` mode).
 *
 * This is deliberately NARROWER than the wire contract's `ChatTurn`, and the
 * gap is the whole safety argument:
 *
 * - The model picks an **intent** and writes **words**. It does not pick which
 *   bank transactions get chased or which documents get published — the server
 *   derives those from RLS-scoped rows after the fact. §9.4 forbids the surface
 *   from inventing numbers, and the cheapest way to honour that is to give the
 *   model no field in which a number could be invented.
 * - A rule draft carries a supplier and a **category code**, and the code is
 *   checked against the client's own synced reference list before it becomes a
 *   proposal. A code that is not on that list is not a typo to be forgiven; it
 *   is the model inventing a chart of accounts.
 * - A grounded answer cites **record ids**, and every cited id must appear in
 *   the set the server retrieved and put in front of it. An id that does not is
 *   a fabricated citation, and the turn fails rather than rendering it.
 *
 * `.strict()` everywhere: an unexpected key is a failed parse, not a silently
 * dropped field. On mismatch the caller retries once with the validation error
 * appended, then raises (§9.2) — never a best-effort parse, never a regex.
 */

export const ChatIntentSchema = z.enum([
  'GENERAL',
  'LIVE_MISSING',
  'LIVE_CHASE',
  'LIVE_RULE',
  'LIVE_PUBLISH',
  'SHOW_INBOX',
  // D40's bank input, made reachable (#233). Navigation and nothing else — no
  // field travels with it, so there is no shape here in which a period, a row
  // count or an assurance verdict could be invented. The Bank tab's Statements
  // list reads the real rows from `GET /statements` after the fact, exactly as
  // SHOW_INBOX's screen reads real documents.
  'SHOW_STATEMENTS',
  'REVIEW_DOCUMENT',
  'GROUNDED_ANSWER',
  'SCOPE_REFUSAL',
  // Chat-first: the UI answers this by rendering the intake form in the
  // transcript. The turn itself creates nothing — submission goes through
  // `POST /businesses` with every check that operation already carries.
  'ADD_CLIENT',
]);

export type ChatIntentValue = z.infer<typeof ChatIntentSchema>;

const RuleDraftSchema = z
  .object({
    /**
     * The supplier the rule keys on, spelled as it appears on documents. The
     * single-tier match is case-sensitive against `extraction.supplierName`, so
     * this is compared case-insensitively and then stored in the casing the
     * client's own documents use — never in the casing the accountant typed.
     */
    supplier: z.string().min(1).max(80),
    /** Validated against the client's reference list before use. Never trusted. */
    categoryCode: z.string().min(1).max(64),
    vatTreatment: z.enum(['standard', 'zero', 'exempt']).optional(),
  })
  .strict();

const NavigationSchema = z
  .object({
    /**
     * What the accountant named ("the Currys receipt"), NOT a document id. The
     * model has no way to know a real id and must not guess one — the server
     * resolves this against documents the caller can actually see.
     */
    documentQuery: z.string().min(1).max(120).optional(),
    statusFilter: z.enum(['review', 'ready', 'failed', 'processing', 'unrouted']).optional(),
    /**
     * With ADD_CLIENT only: the company name the accountant said ("add a
     * client called Ananda Group"), for prefilling the intake form. Words,
     * never an id — the same doctrine as `documentQuery`. Nothing exists
     * until the form is submitted through `POST /businesses`.
     */
    clientName: z.string().min(1).max(120).optional(),
  })
  .strict();

const DisplayRequestSchema = z
  .object({
    /**
     * A SHAPE, never data. The model asks for a table or a bar chart of one
     * subject; `display.ts` fills every cell from RLS-scoped rows after the
     * fact. There is deliberately no field here a number could travel in —
     * the same doctrine as `documentQuery` (no ids) and the whole schema
     * (no figures).
     */
    kind: z.enum(['table', 'barChart']),
    subject: z.enum(['documents', 'bankTransactions', 'chases']),
  })
  .strict();

const GroundedAnswerSchema = z
  .object({
    /**
     * Ids of records the answer stood on. Every one is checked against the
     * retrieved set; a citation the server did not supply fails the turn.
     * Empty is legal and means "I could not answer from these records" — the
     * caller then emits §9.4's literal fallback rather than this text.
     */
    citedRecordIds: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();

export const ModelTurnSchema = z
  .object({
    intent: ChatIntentSchema,
    /**
     * The words shown to the accountant. Capped because this is rendered, and
     * an unbounded model string on a screen is a layout bug waiting for a bad
     * day. Sanitised downstream regardless — model output is untrusted input to
     * the next stage (§9.6).
     */
    reply: z.string().min(1).max(1200),
    rule: RuleDraftSchema.optional(),
    navigation: NavigationSchema.optional(),
    grounded: GroundedAnswerSchema.optional(),
    display: DisplayRequestSchema.optional(),
  })
  .strict()
  .superRefine((turn, ctx) => {
    // Intent and payload must agree. A LIVE_RULE with no rule is not a rule,
    // and the graceful fallback says so better than a half-built card would.
    if (turn.intent === 'LIVE_RULE' && turn.rule === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rule'],
        message: 'intent LIVE_RULE requires a rule with a supplier and a categoryCode',
      });
    }
    if (turn.intent !== 'LIVE_RULE' && turn.rule !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rule'],
        message: 'a rule may only accompany intent LIVE_RULE',
      });
    }
    if (turn.intent === 'REVIEW_DOCUMENT' && turn.navigation?.documentQuery === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['navigation', 'documentQuery'],
        message: 'intent REVIEW_DOCUMENT requires navigation.documentQuery naming the document',
      });
    }
    if (turn.intent === 'GROUNDED_ANSWER' && turn.grounded === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grounded'],
        message: 'intent GROUNDED_ANSWER requires grounded.citedRecordIds (possibly empty)',
      });
    }
    if (turn.intent !== 'ADD_CLIENT' && turn.navigation?.clientName !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['navigation', 'clientName'],
        message: 'navigation.clientName may only accompany intent ADD_CLIENT',
      });
    }
    // A display block is a grounded answer's illustration, and only that: the
    // server fills it from the same retrieved records the citations stand on.
    if (turn.intent !== 'GROUNDED_ANSWER' && turn.display !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['display'],
        message: 'display may only accompany intent GROUNDED_ANSWER',
      });
    }
  });

export type ModelTurn = z.infer<typeof ModelTurnSchema>;

/**
 * The same shape as a JSON Schema, for the forced tool call.
 *
 * Structured output here is a **forced single tool** rather than
 * `output_config.format`: the forced-tool path is the one shape verified to
 * work identically on the first-party API and on Bedrock, and §9.1 is explicit
 * that assuming one API shape across providers is the mistake. The Zod parse
 * above is the real gate either way — this schema only makes the model's first
 * attempt likely to pass it.
 *
 * Kept hand-written and adjacent to the Zod above rather than generated from
 * it: a generator would be a dependency for forty lines, and the `superRefine`
 * rules could not be expressed in JSON Schema anyway, so the two would drift in
 * exactly the place the drift would not be caught. The unit test pins them
 * together instead.
 */
export const RESPOND_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'reply'],
  properties: {
    intent: {
      type: 'string',
      enum: ChatIntentSchema.options,
      description: 'What the accountant asked for. GENERAL when nothing else fits.',
    },
    reply: {
      type: 'string',
      description: 'One or two sentences to show the accountant. No markdown, no lists.',
    },
    rule: {
      type: 'object',
      additionalProperties: false,
      required: ['supplier', 'categoryCode'],
      properties: {
        supplier: { type: 'string', description: 'The supplier name the rule keys on.' },
        categoryCode: {
          type: 'string',
          description: 'A category code copied EXACTLY from the reference list supplied above.',
        },
        vatTreatment: { type: 'string', enum: ['standard', 'zero', 'exempt'] },
      },
      description: 'Only with intent LIVE_RULE.',
    },
    navigation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        documentQuery: {
          type: 'string',
          description: 'What the accountant called the document, e.g. "Currys receipt". Never an id.',
        },
        statusFilter: { type: 'string', enum: ['review', 'ready', 'failed', 'processing', 'unrouted'] },
        clientName: {
          type: 'string',
          description:
            'Only with intent ADD_CLIENT: the company name the accountant said, verbatim. Omit if they did not name one.',
        },
      },
    },
    grounded: {
      type: 'object',
      additionalProperties: false,
      required: ['citedRecordIds'],
      properties: {
        citedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Record ids from the supplied records that support the reply. [] if none do.',
        },
      },
      description: 'Only with intent GROUNDED_ANSWER.',
    },
    display: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'subject'],
      properties: {
        kind: { type: 'string', enum: ['table', 'barChart'] },
        subject: { type: 'string', enum: ['documents', 'bankTransactions', 'chases'] },
      },
      description:
        'Only with intent GROUNDED_ANSWER: ask the system to render this client’s records as a table or bar chart beside your reply. You choose the shape; the system fills the data from real records. Use it when the accountant asks to SEE records — a list, a breakdown, "show me".',
    },
  },
} as const;

export const RESPOND_TOOL_NAME = 'respond';
