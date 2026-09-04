import { createChatTurn } from '@neoting/contracts/client';
import { createChatTurnResponse } from '@neoting/contracts/zod';
import type { ChatTurn, ChatTurnRequest } from '@neoting/contracts/model';
import { NtProblemError } from '@neoting/contracts';
import { unwrapBody } from './envelope';
import type { DocStatus, MessagePayload } from '../lib/types';

/**
 * The AI workspace's wire (Governance §9).
 *
 * Deliberately a plain async function rather than a `useMutation` hook: the
 * caller is inside `InputRow`'s submit handler, which is already an async
 * sequence that adds a user message, awaits an answer and adds an assistant
 * message. Wrapping that in a mutation hook would put the same await behind a
 * second state machine and buy nothing.
 *
 * Also deliberately NOT in `AppContext`: this module is imported by the chat
 * input only, which keeps the generated chat client off the bundle floor —
 * the same placement rule METH S12 used for `chases.ts` and `proposals.ts`,
 * and for the same reason.
 *
 * **The model is not trusted here either.** The response is parsed through the
 * generated Zod schema before anything renders it. §9.6 is explicit that model
 * output is untrusted input to the next stage, and "the next stage" is a React
 * tree in the accountant's browser.
 */

export type { ChatTurn };

/** What went wrong, in words the chat can show as an assistant message. */
export interface ChatTurnFailure {
  readonly kind: 'failure';
  /** Already user-facing — the API's problem+json detail, with its NT- code. */
  readonly message: string;
  /** True when a retry is the sensible next move (§9.3's honest error). */
  readonly retryable: boolean;
}

export type ChatTurnResult = ({ kind: 'ok' } & ChatTurn) | ChatTurnFailure;

/** The `NT-MDL-*` family plus rate limiting — everything a retry might fix. */
const RETRYABLE = new Set(['NT-MDL-001', 'NT-MDL-003', 'NT-MDL-004', 'NT-RATE-001', 'NT-SRV-001']);

export async function requestChatTurn(request: ChatTurnRequest): Promise<ChatTurnResult> {
  try {
    const raw = await createChatTurn(request);
    const parsed = createChatTurnResponse.safeParse(unwrapBody(raw));

    if (!parsed.success) {
      // A contract drift, not a model failure. Named as such so nobody spends
      // an afternoon looking at prompts when the response shape moved.
      return {
        kind: 'failure',
        retryable: false,
        message: `The assistant answered in an unexpected shape (${parsed.error.issues[0]?.path.join('.') || 'response'}).`,
      };
    }

    return { kind: 'ok', ...(parsed.data as ChatTurn) };
  } catch (error) {
    if (error instanceof NtProblemError) {
      return {
        kind: 'failure',
        retryable: RETRYABLE.has(error.code),
        // The code stays in front of the words — a bug report, a log line and
        // the screen then have one string in common (the frontend ten, item 5).
        message: `${error.code} — ${error.detail ?? error.title}`,
      };
    }
    return {
      kind: 'failure',
      retryable: true,
      message: error instanceof Error ? error.message : 'The assistant could not be reached.',
    };
  }
}

/**
 * The server's status vocabulary → the app's `DocStatus`.
 *
 * They are not the same set and should not be forced to be: the API knows
 * `unrouted` and `failed` as document states, while the inbox table's filter is
 * a display concept. An unrouted document is not in the list at all — it is held
 * back by InboxesView's `clientId !== ''` filter until a `document.route`
 * proposal gives it a client. (It used to sit in a dedicated Unrouted queue;
 * D45 removed that surface, but not the holding-back.) `unrouted` therefore maps
 * to no filter rather than to a lie, and `failed` maps to the `rejected` bucket
 * the table actually renders.
 */
const STATUS_FILTER_TO_APP: Record<string, DocStatus | undefined> = {
  review: 'review',
  ready: 'ready',
  processing: 'processing',
  failed: 'rejected',
  unrouted: undefined,
};

/**
 * `ChatTurn` → the message payload the dynamic cards render from.
 *
 * The rule draft is unpacked into the card's shape here rather than the card
 * being taught the proposal shape, because the card also serves the synthetic
 * path and must not grow a dependency on the wire contract to do it.
 *
 * `categoryName` carries the CODE, deliberately. The human-readable name is
 * what the server renders at Read review, composed from the client's own
 * reference list; a prettier label invented in the browser would be a second
 * description of the same rule, and the two could disagree.
 */
export function mapTurnToPayload(
  turn: ChatTurn,
  businesses: readonly { id: string; name: string }[],
  utterance: string,
): Partial<MessagePayload> {
  const businessId = turn.navigation?.businessId;
  const businessName = businessId === undefined ? undefined : businesses.find((b) => b.id === businessId)?.name;
  const statusFilter =
    turn.navigation?.statusFilter === undefined ? undefined : STATUS_FILTER_TO_APP[turn.navigation.statusFilter];

  const draft = turn.draft as
    | { kind?: string; payload?: { scopeKey?: string; sets?: { categoryCode?: string; vatTreatment?: string } } }
    | undefined;

  const ruleDraft =
    draft?.kind === 'rule.create' && draft.payload?.scopeKey !== undefined && draft.payload.sets?.categoryCode !== undefined
      ? {
          scopeKey: draft.payload.scopeKey,
          categoryCode: draft.payload.sets.categoryCode,
          categoryName: draft.payload.sets.categoryCode,
          vatTreatment: draft.payload.sets.vatTreatment,
        }
      : undefined;

  return {
    query: utterance,
    ...(businessId === undefined ? {} : { businessId }),
    ...(businessName === undefined ? {} : { businessName }),
    ...(turn.navigation?.documentId === undefined ? {} : { documentId: turn.navigation.documentId }),
    ...(statusFilter === undefined ? {} : { statusFilter }),
    ...(ruleDraft === undefined ? {} : { ruleDraft }),
    // ADD_CLIENT's prefill — IntentRenderer hands it to ClientIntakeForm.
    ...(turn.navigation?.clientName === undefined ? {} : { clientName: turn.navigation.clientName }),
  };
}

/**
 * The server's intent vocabulary → the app's. Near-identity by design: the
 * contract enum was chosen to match the names the LIVE cards already render,
 * so this is a total function with no defaulting cleverness. A server intent
 * with no mapping is a contract change that should break the build here rather
 * than silently render a GENERAL card.
 */
export const SERVER_INTENT_TO_APP = {
  GENERAL: 'GENERAL',
  LIVE_MISSING: 'LIVE_MISSING',
  LIVE_CHASE: 'LIVE_CHASE',
  LIVE_RULE: 'LIVE_RULE',
  LIVE_PUBLISH: 'LIVE_PUBLISH',
  SHOW_INBOX: 'SHOW_INBOX',
  // D40's bank input, reachable from chat since #233. Navigation, like
  // SHOW_INBOX: the card is a way into the Bank tab's Statements list, which
  // reads `GET /statements` itself. Nothing about a statement — period, row
  // count, assurance — travels through the model to get here.
  SHOW_STATEMENTS: 'SHOW_STATEMENTS',
  REVIEW_DOCUMENT: 'REVIEW_DOCUMENT',
  // Both grounded shapes render as plain assistant text — the answer IS the
  // card. References ride along in the payload for the reference chips.
  GROUNDED_ANSWER: 'GENERAL',
  SCOPE_REFUSAL: 'GENERAL',
  // Chat-first: renders ClientIntakeForm in the transcript (IntentRenderer).
  ADD_CLIENT: 'ADD_CLIENT',
} as const satisfies Record<ChatTurn['intent'], string>;
