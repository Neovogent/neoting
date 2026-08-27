import { type ChaseItem, formatDay, formatGbp } from '../chase/index.js';
import type { SignInCode } from './sign-in-code.js';

/**
 * The three messages, composed. PURE functions of their inputs — no clock, no
 * database, no model — for the same reason `chase/sms-copy.ts` is: the text a
 * reviewer approves must be byte-for-byte the text that sends, and neither the
 * caller nor the transport may re-derive it.
 *
 * Money and dates come from `chase/index.ts` (`formatGbp`, `formatDay`) rather
 * than from a second implementation here. That is not tidiness — it is the
 * repo's most-guarded invariant. `formatGbp` formats integer pence with STRING
 * arithmetic and never divides, so no float touches a monetary value even
 * transiently, and `formatDay` renders a UTC instant in Europe/London so a
 * late-evening timestamp does not name the wrong UK day. A local `£${p / 100}`
 * would be wrong in both ways and would look right.
 *
 * ## The house style, and why every message ends the same way
 *
 * Plain text, one idea per paragraph, wrapped by the reader's client and not by
 * us. No greeting we cannot personalise honestly, no signature block, no
 * marketing. Every message states what it is, what to do, and what happens if
 * you were not expecting it — because a client receiving an unexpected email
 * about their own financial records needs an answer in the message, not a
 * support ticket.
 *
 * ## D42 applies to copy too
 *
 * Nothing here may claim a ledger was written to. *Published* means approved
 * and released for export, and no client-facing sentence may imply otherwise.
 * None of these three messages touches publishing today; the rule is recorded
 * here because this file is where a future "your invoice has been posted" would
 * be written.
 */

/**
 * The display name on the envelope. Product copy, not configuration — a brand
 * that can be changed by editing an ECS task definition is a brand nobody
 * reviews. **M1 (the rename) owns the final word on this string**; it is
 * `PLAN.md`'s own name for the product and is stated once, here.
 */
export const SENDER_DISPLAY_NAME = 'Neo Accounting';

/** A composed message, ready for the transport to put an envelope around. */
export interface ComposedEmail {
  readonly subject: string;
  readonly body: string;
}

// ── 1 · Client invite ──────────────────────────────────────────────────────

export interface ComposeClientInviteInput {
  /** The practice doing the inviting — the client knows their accountant's name, not ours. */
  readonly practiceName: string;
  /** The client business the invite is for. */
  readonly businessName: string;
  /** The signed onboarding link. The token IS the authorisation; nothing else is sent. */
  readonly inviteLink: string;
  /** When the link stops working. Rendered in Europe/London (Governance §12). */
  readonly expiresAt: Date;
}

/**
 * The accountant adds a client; the client gets a link (S2 message 1, SoT §6).
 *
 * Sent FROM the practice's name rather than ours. A cleaning agency has a
 * relationship with their accountant and none at all with us, and an email that
 * opens with a software brand they have never heard of is an email they delete.
 *
 * D47 governs what this may ask for: client onboarding asks for NO connections.
 * There is no "connect your bank", no "link your accounting software", and this
 * copy must never grow one.
 */
export function composeClientInvite(input: ComposeClientInviteInput): ComposedEmail {
  return {
    subject: `${input.practiceName} has invited you to ${SENDER_DISPLAY_NAME}`,
    body: lines(
      `${input.practiceName} uses ${SENDER_DISPLAY_NAME} to collect the receipts and invoices for ${input.businessName}.`,
      '',
      'You can send them a photo, forward an email, or upload a file. There is nothing to install and no password to choose.',
      '',
      'Set up your access here:',
      input.inviteLink,
      '',
      `This link stops working on ${formatDay(input.expiresAt)}. If you were not expecting it, you can ignore this email — nothing happens until you open the link.`,
      '',
      SENDER_DISPLAY_NAME,
    ),
  };
}

// ── 2 · Sign-in code ───────────────────────────────────────────────────────

export interface ComposeSignInCodeInput {
  /** The code. A {@link SignInCode}, not a string — see `sign-in-code.ts`. */
  readonly code: SignInCode;
  /** How long it lasts, in whole minutes. Stated so the client knows to hurry or to ask again. */
  readonly expiresInMinutes: number;
}

/**
 * Six digits, short expiry, single use (S2 message 2).
 *
 * Three rules are load-bearing and each is visible in the code below:
 *
 * 1. **The code is not in the subject.** A subject line is rendered on a lock
 *    screen, in a notification banner and in every mail server's logs along the
 *    way. A credential may appear in none of those.
 * 2. **The code is not in a link.** No "click here to sign in" — a URL carrying
 *    the code lands in browser history, in a `Referer` header and in any
 *    link-scanner the recipient's employer runs, and corporate scanners
 *    routinely FETCH such URLs, which would burn a single-use code before the
 *    client ever saw it.
 * 3. **`code.reveal()` appears exactly once in the codebase, and it is here.**
 *    That is the whole design of `SignInCode`.
 */
export function composeSignInCode(input: ComposeSignInCodeInput): ComposedEmail {
  return {
    subject: `Your ${SENDER_DISPLAY_NAME} sign-in code`,
    body: lines(
      // The one and only `reveal()`.
      `Your sign-in code is ${input.code.reveal()}`,
      '',
      `It expires in ${input.expiresInMinutes} ${input.expiresInMinutes === 1 ? 'minute' : 'minutes'} and can be used once.`,
      '',
      'Nobody from our team will ever ask you for this code. If you did not just try to sign in, ignore this email — the code is useless on its own and no one else has been given access.',
      '',
      SENDER_DISPLAY_NAME,
    ),
  };
}

// ── 3 · Document request ───────────────────────────────────────────────────

export interface ComposeDocumentRequestInput {
  /** The client's own name for themselves — the greeting is "<name> Accounts:" on SMS. */
  readonly businessName: string;
  /** The chased items, GROUPED into one message per client (SoT §4 Stage 8.2). */
  readonly items: readonly ChaseItem[];
  /** The signed portal link — `signPortalLink` output, the same token the SMS carried. */
  readonly portalLink: string;
}

/**
 * The chase, by email instead of SMS (S2 message 3; SoT §4 Stage 8.2, D16).
 *
 * SMS was the chase channel and Initial Delivery cuts it, so this is the whole
 * of the chase's delivery. The SoT rule it inherits, and which the format below
 * exists to honour: **grouped per client, not one message per receipt.** One
 * email covers every outstanding item, and the link is that client's portal
 * grant.
 *
 * Email is not SMS with more room, and the shape changes accordingly: the items
 * become a list a person can tick off rather than a run-on sentence, because
 * this is the message a client reads while standing at a filing cabinet. The
 * facts, the money and the dates are identical to `composeChaseSms` — same
 * formatters, same source — so an accountant reviewing one is reviewing both.
 *
 * ⚠ The wiring is **A14's**, not this stage's, and A14 is on `PLAN.md`'s cut
 * list at hour 22. This composes the message and stops there; nothing in the
 * chase send path calls it yet.
 */
export function composeDocumentRequest(input: ComposeDocumentRequestInput): ComposedEmail {
  const noun = input.items.length === 1 ? 'a receipt' : `${input.items.length} receipts`;
  return {
    subject: `${input.businessName}: we're missing ${noun}`,
    body: lines(
      `We're missing ${input.items.length === 1 ? 'the paperwork' : 'paperwork'} for ${input.items.length === 1 ? 'this payment' : 'these payments'} on the ${input.businessName} account:`,
      '',
      // "- Currys £1,299 on 9 Aug", one per line. The magnitude, not the sign:
      // a payment out is money the client spent, and a minus in front of it in
      // a sentence addressed to them is noise.
      ...input.items.map((item) => `- ${item.supplierLabel} ${formatGbp(item.amountPence)} on ${formatDay(item.bookedAt)}`),
      '',
      'A photo of the receipt is enough. Upload securely here:',
      input.portalLink,
      '',
      'If you have already sent these, ignore this email — it will sort itself out once they are matched.',
      '',
      SENDER_DISPLAY_NAME,
    ),
  };
}

// ── 4 · Verify your email address ───────────────────────────────

export interface ComposeEmailVerificationInput {
  readonly firstName: string;
  readonly practiceName: string;
  /**
   * The whole link, built by the caller.
   *
   * Same split as {@link composeClientInvite}: this module composes words, and
   * the public web origin is a configuration concern belonging to whoever owns
   * the composition root. `auth-tenancy` builds it from the token.
   */
  readonly verifyLink: string;
  readonly expiresAt: Date;
}

/**
 * The mail that turns a `202` into a usable account.
 *
 * ⚠ **This message is the whole of the signup flow’s honesty.** `POST
 * /v1/practices` answers `202` with an empty body whether or not an account was
 * created, because saying otherwise answers *"is this address registered here"*
 * for anyone who asks. The only party who may learn what happened is the person
 * at the address — so if this mail does not arrive, the signup is not merely
 * degraded, it is a permanent silent failure the caller was told nothing about.
 *
 * The link sits on its own line and the expiry is named, because a verification
 * mail that has gone stale is the one a person retries rather than reports.
 */
export function composeEmailVerification(input: ComposeEmailVerificationInput): ComposedEmail {
  return {
    subject: `Confirm your email address for ${SENDER_DISPLAY_NAME}`,
    body: lines(
      `Hello ${input.firstName},`,
      '',
      `You created a ${SENDER_DISPLAY_NAME} account for ${input.practiceName}. Confirm this email address to finish setting it up:`,
      '',
      input.verifyLink,
      '',
      `This link stops working on ${formatDay(input.expiresAt)}. If it has expired by the time you read this, start the signup again and a new one will be sent.`,
      '',
      'If you did not create this account you can ignore this email. Nothing has been set up, and the address cannot be used until the link is opened.',
      '',
      SENDER_DISPLAY_NAME,
    ),
  };
}

// ── 5 · Someone tried to sign up with your address ─────────────────────

/**
 * Sent when a signup names an address that already has an account.
 *
 * ⚠ **Not politeness — this is what makes the uninformative `202` honest.**
 * The API refuses to tell the caller that an address is registered. The account
 * holder is the one party entitled to know a signup was attempted, and their
 * inbox is the one place only they are reading.
 *
 * It therefore says as little as it can: no practice name, no first name, no
 * hint about who tried. Whoever typed the address may not be the account
 * holder, and a message describing the attempt would leak the account straight
 * back to the person doing the probing.
 */
export function composeDuplicateSignupNotice(): ComposedEmail {
  return {
    subject: 'Someone tried to sign up with your email address',
    body: lines(
      `Someone entered this email address when signing up for ${SENDER_DISPLAY_NAME}. It already has an account, so nothing was created and nothing has changed.`,
      '',
      'If that was you, sign in as usual rather than signing up again.',
      '',
      'If it was not you, there is nothing you need to do. Your account is unaffected and no one has gained access to it. If you would like us to look into it, reply to this email.',
      '',
      SENDER_DISPLAY_NAME,
    ),
  };
}

/**
 * Join body lines with `\n`, ending with one.
 *
 * `\n` and not `\r\n`: SES v2's `Content.Simple` takes the body as a JSON
 * string and does its own MIME encoding, so writing CRLF here produces literal
 * `\r` characters inside the encoded part rather than line endings.
 */
function lines(...parts: readonly string[]): string {
  return `${parts.join('\n')}\n`;
}
