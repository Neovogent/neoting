import { z } from 'zod';
import { NtTransportError } from '@neoting/contracts';
import {
  completeDocumentUpload,
  createPortalSession,
  createPortalSignInCode,
  createPortalUpload,
  getPortalContext,
} from '@neoting/contracts/client';
import {
  completeDocumentUploadBody,
  createPortalSessionBody,
  createPortalSignInCodeBody,
  createPortalUploadBody,
  getPortalContextResponse,
} from '@neoting/contracts/zod';
import type { DocumentUpload, PortalSession, PortalUploadRequest } from '@neoting/contracts/model';
import { fromIsoDate, fromPence } from './documents';
// The transport half — the 201 shape, the raw PUT and the hash — is shared
// with the practice upload (`uploads.ts`) via its own module, so neither
// surface has to import the other's journey. The rules about the PUT (no /v1,
// no credential, headers verbatim) live on `putBytes` there.
import { documentUploadShape, putBytes, sha256Hex } from './upload-transport';

/**
 * The OTP portal, read from the API.
 *
 * The client-facing half of METH Stage 9: an SMS link plus six digits become a
 * short-lived session that may see exactly the chased items and upload against
 * them. Three contracted operations, in the order the journey uses them:
 *
 *   POST /portal/sessions   linkToken + otp  → the bearer
 *   GET  /portal/context    the items this session may see
 *   POST /portal/uploads    an upload intent, completed through
 *                           POST /document-uploads/{id}/complete
 *
 * ⚠ THE CREDENTIAL IS A BEARER, NOT A COOKIE. `METH_MODE.md` Stage 9 says
 * "issue portal cookie"; `openapi.yaml` declares
 * `portalSession: {type: http, scheme: bearer}` and puts both authenticated
 * portal operations under it. The contract is LAW (G7), so it wins, and the
 * token travels in `Authorization`. Nothing here reads or writes a cookie.
 *
 * ⚠ THE TOKEN IS NEVER PERSISTED. It is passed in as an argument by the caller,
 * which holds it in React state, so it dies with the tab. It is a *delegated*
 * grant — the holder is not a user, has no password to re-prove anything with,
 * and the whole point of the design is that the link and the code together are
 * what authorise the session. Putting it in `localStorage` would leave a
 * standing upload credential for someone else's books on a phone that gets
 * handed round the till, surviving every close of the browser, with no sign-out
 * anywhere in the product that could clear it. There is deliberately no store
 * in this module for it to leak into.
 *
 * Two conversions happen here and nowhere else, as in `documents.ts`:
 * integer pence become pounds, and ISO instants become the "9 Aug 2026" the
 * screens render.
 */

/** The contract's own pattern: `^[0-9]{6}$`. */
export const OTP_LENGTH = 6;

/**
 * ⚠ THE GENERATED CLIENT'S RESPONSE TYPE IS AN ENVELOPE THAT DOES NOT EXIST AT
 * RUNTIME.
 *
 * orval's fetch client declares every operation as `Promise<{data, status}>`,
 * but the mutator every call goes through — `ntFetch` in
 * `packages/contracts/src/http-client.ts` — returns `await response.json()`,
 * which is the body itself. So `.data` typechecks and is `undefined` at run
 * time. Reading the awaited value as `unknown` and handing it to the schema is
 * the honest move: the Zod parse is what decides the shape, which is the rule
 * anyway (never trust a type for a value that came off a socket).
 */
const responseBody = async (call: Promise<unknown>): Promise<unknown> => await call;

/** `Authorization: Bearer …`, the only thing that authenticates a portal call. */
const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/**
 * A failure of the ONE call in the journey that does not go to the Neoting API.
 *
 * ⚠ **`NtTransportError` with no status is thrown by two different things** —
 * the generated client when it cannot reach OUR API (`http-client.ts:174`), and
 * `putBytes` when it cannot reach STORAGE — and the client-facing sentence is
 * not the same. A cross-origin `fetch` failure is opaque by design (the browser
 * withholds the status so a page cannot probe another origin), so the stage is
 * the only thing left to tell them apart, and it is recorded at the call site
 * rather than inferred from an error message downstream.
 *
 * It is a SUBCLASS, so every existing `instanceof NtTransportError` check —
 * the chase portal's included — goes on matching unchanged.
 */
export class PortalStorageError extends NtTransportError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'PortalStorageError';
  }
}

/**
 * The 201 responses have no generated Zod schema — orval emits response
 * schemas for `200` only, so `getPortalContextResponse` exists and the two
 * created-resource shapes do not. They are written out here instead of skipped,
 * because "parse, don't trust" does not get an exemption for the convenient
 * cases. The contract's own type is the return annotation on each function, so
 * a spec change that renames a field fails `tsc` here rather than rendering as
 * `undefined` three components deep.
 */
const portalSessionShape = z
  .object({
    token: z.string().min(1),
    expiresAt: z.string(),
  })
  .strict();


/* ── ① the session ────────────────────────────────────────────────────────── */

/**
 * Open a portal session. Every verification failure — unknown link, expired
 * link, wrong code — comes back as one `401 NT-OTP-001`, deliberately: telling
 * them apart would tell a guesser which links exist.
 */
export async function openPortalSession(linkToken: string, otp: string): Promise<PortalSession> {
  // The outbound boundary, parsed by the contract's own schema: the six-digit
  // pattern is checked here rather than trusted from a caller's input handler.
  const request = createPortalSessionBody.parse({ linkToken, otp });
  return portalSessionShape.parse(await responseBody(createPortalSession(request)));
}

/**
 * Ask for the six-digit code — it goes to the chase's REGISTERED recipient,
 * never to an address typed here (the link is forwardable; the registered
 * contact is the identity D45 gates on). The answer is a `202` whatever
 * happened, so there is nothing to parse and nothing to show but "check the
 * registered email".
 */
export async function requestPortalCode(linkToken: string): Promise<void> {
  // Parse validates the boundary; the literal travels (the parsed value's
  // optional keys are `string | undefined`, which exactOptionalPropertyTypes
  // rightly refuses to hand to a model whose absent keys must be absent).
  createPortalSignInCodeBody.parse({ linkToken });
  await responseBody(createPortalSignInCode({ linkToken }));
}

/* ── ② what the session may see ───────────────────────────────────────────── */

/** One chased item, in the shape the portal renders rather than the wire's. */
export interface PortalItem {
  transactionId: string;
  /**
   * The merchant if the feed named one, else the client's own bank descriptor,
   * else nothing — the screen says "payment" rather than inventing a name.
   */
  label: string | null;
  /** Pounds. Signed as the feed records it: negative is money out. */
  amount: number;
  /** "09 Aug 2026" — what every screen in this app renders. */
  date: string;
  received: boolean;
}

/** A bank statement the accountant has asked for (engine (c), Phase 5). */
export interface PortalStatementRequest {
  /** `YYYY-MM` — the view formats it into the client's own month name. */
  period: string;
  received: boolean;
}

export interface PortalView {
  businessName: string;
  items: PortalItem[];
  /** Statement requests ride beside items — a statement is not a transaction. */
  statementRequests: PortalStatementRequest[];
  /** ISO — the session's own expiry, shown so the client knows the clock runs. */
  expiresAt: string;
}

type ContextItem = z.infer<typeof getPortalContextResponse>['items'][number];

/** Wire item → screen item. The one place pence become pounds for the portal. */
export function toPortalItem(row: ContextItem): PortalItem {
  return {
    transactionId: row.transactionId,
    label: row.merchantName ?? row.descriptionRaw ?? null,
    amount: fromPence(row.amountPence),
    date: fromIsoDate(row.bookedAt),
    received: row.received,
  };
}

export async function fetchPortalView(token: string): Promise<PortalView> {
  const parsed = getPortalContextResponse.parse(await responseBody(getPortalContext(bearer(token))));
  return {
    businessName: parsed.businessName,
    items: parsed.items.map(toPortalItem),
    statementRequests: (parsed.statementRequests ?? []).map((r) => ({ period: r.period, received: r.received })),
    expiresAt: parsed.expiresAt,
  };
}

/* ── ③ the upload, which is three calls and only one of them is ours ──────── */

export interface PortalUploadFile {
  filename: string;
  mimeType: string;
  bytes: Blob;
}

/** Step one: the intent. The API hands back a presigned `PUT`, never bytes. */
async function startPortalUpload(
  token: string,
  file: PortalUploadFile,
  transactionId: string | null,
  note: string | null,
): Promise<DocumentUpload> {
  const request: PortalUploadRequest = {
    filename: file.filename,
    mimeType: file.mimeType,
    byteSize: file.bytes.size,
    transactionId,
    // The client's own name for the document (5 Sep 2026, review item 11).
    // Server-side it becomes the display filename and a provenance record;
    // null and omitted both mean "none".
    note,
  };
  // Parsed on the way out as well as in: the contract's own schema is what
  // decides that 255 characters and a byte count of at least 1 are the rules,
  // and a request that would be refused is better caught before the network.
  createPortalUploadBody.parse(request);
  return documentUploadShape.parse(await responseBody(createPortalUpload(request, bearer(token))));
}

/**
 * The whole upload: intent → bytes → complete.
 *
 * Completion is `POST /document-uploads/{uploadId}/complete`, the *same*
 * endpoint the practice web upload uses — the contract accepts the portal
 * bearer there for exactly this reason. One completion path at two trust
 * levels, no second door; the delegated RLS policies keep this session inside
 * the document it was just granted.
 *
 * ⚠ **The middle call is re-thrown as `PortalStorageError`, and that is not
 * tidying.** All three calls fail as `NtTransportError` with no status when the
 * network is against them, but only one of them goes to the object store — and
 * "we could not reach storage" and "we could not reach Neo Accounting" send the
 * client to different places. Nothing but the call site knows which stage threw,
 * so the stage is recorded here rather than guessed at downstream. The class is
 * a SUBCLASS of `NtTransportError`, so the chase portal's existing handling is
 * unchanged.
 */
export async function sendPortalUpload(
  token: string,
  file: PortalUploadFile,
  transactionId: string | null,
  note: string | null = null,
): Promise<{ uploadId: string }> {
  const intent = await startPortalUpload(token, file, transactionId, note);
  try {
    await putBytes(intent, file.bytes);
  } catch (cause) {
    // The status is carried across when there is one: a non-2xx from storage
    // is a different fact from a `fetch` that never got an answer at all.
    throw new PortalStorageError(
      cause instanceof Error ? cause.message : 'Upload failed',
      cause instanceof NtTransportError ? cause.status : undefined,
    );
  }
  const request = completeDocumentUploadBody.parse({ byteHash: await sha256Hex(file.bytes) });
  await completeDocumentUpload(intent.uploadId, request, bearer(token));
  return { uploadId: intent.uploadId };
}
