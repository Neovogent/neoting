import { type ChaseItem, formatDay, formatGbp } from '../chase/index.js';
import { renderEmailHtml } from './email-html.js';
import type { SignInCode } from './sign-in-code.js';

/**
 * The messages, composed (three at S2, six now). PURE functions of their inputs — no clock, no
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
  /** The designed rendering of `body` — derived from it here, never written separately (email-html.ts). */
  readonly html: string;
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
  const subject = `${input.practiceName} has invited you to ${SENDER_DISPLAY_NAME}`;
  const body = lines(
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
  );
  return { subject, body, html: renderEmailHtml({ subject, body, linkLabels: { [input.inviteLink]: 'Set up your access' } }) };
}

// ── 1b · Team invite — a COLLEAGUE, not a client ───────────────────────────

export interface ComposeTeamInviteInput {
  /** The firm the invitee is being asked to join. */
  readonly practiceName: string;
  /**
   * Who invited them, when the invitation records it. Null is a real answer —
   * an inviter since removed — and the copy simply drops the clause rather than
   * writing "someone at".
   */
  readonly inviterName: string | null;
  /** The link carrying the invitation token. The token IS the authorisation. */
  readonly inviteLink: string;
  /** When the link stops working. Rendered in Europe/London (Governance §12). */
  readonly expiresAt: Date;
}

/**
 * An admin invites a colleague into the practice.
 *
 * ⚠ **THIS CANNOT REUSE {@link composeClientInvite}, AND THE REASON IS ONE
 * SENTENCE IN IT.** That message says *"There is nothing to install and no
 * password to choose"*, which is true of a client — they sign in with an emailed
 * six-digit code and never hold a password — and precisely false of a colleague,
 * whose whole next action is to choose one. A shared composer would have told
 * every new member of staff not to do the thing the link exists for. The two
 * messages also differ in what they are ABOUT: the client one names a business
 * and describes sending receipts; this one names an employer and a role.
 *
 * What it keeps from the client invite, because those parts were right: it is
 * sent in the PRACTICE's name rather than ours, the link sits on its own line so
 * a mail client wrapping a long line cannot break it, the expiry is stated as a
 * date, and it tells an unexpecting reader what to do — which for this message
 * matters more than most, because an invitation to work somewhere is a plausible
 * shape for a phishing mail.
 *
 * **The role is deliberately not in the copy.** The screen the link opens states
 * it, read from the invitation itself, so the words a person sees cannot drift
 * from the grant the server will actually make.
 */
export function composeTeamInvite(input: ComposeTeamInviteInput): ComposedEmail {
  const subject = `${input.practiceName} has invited you to join their team on ${SENDER_DISPLAY_NAME}`;
  const body = lines(
      input.inviterName === null
        ? `You have been invited to join ${input.practiceName} on ${SENDER_DISPLAY_NAME}, the software they use to collect and code their clients' paperwork.`
        : `${input.inviterName} has invited you to join ${input.practiceName} on ${SENDER_DISPLAY_NAME}, the software they use to collect and code their clients' paperwork.`,
      '',
      'Open the link below to choose a password and set up an authenticator app. It takes a couple of minutes, and you will need your phone for the second step.',
      '',
      input.inviteLink,
      '',
      `This link stops working on ${formatDay(input.expiresAt)}. If it has expired by the time you read this, ask whoever invited you to send another one.`,
      '',
      'If you were not expecting this, you can ignore this email — no account is created until the link is opened.',
      '',
      SENDER_DISPLAY_NAME,
  );
  return { subject, body, html: renderEmailHtml({ subject, body, linkLabels: { [input.inviteLink]: 'Set up your account' } }) };
}

// ── 1c · A BUSINESS invites its own staff ──────────────────────────────────

export interface ComposeBusinessPeopleInviteInput {
  /** The employer. **Not the practice** — see the header below. */
  readonly businessName: string;
  /**
   * Who added them, when the business recorded a name for that person. Null is a
   * real answer — an inviter since removed, or a `contacts` row with no name —
   * and the copy drops the clause rather than writing "someone at".
   */
  readonly inviterName: string | null;
  /**
   * The portal's own front door, carrying no token.
   *
   * ⚠ That absence is the design. See the composer's header.
   */
  readonly portalLink: string;
}

/**
 * A client business adds one of its own people — the THIRD invitation
 * relationship in the product.
 *
 * ⚠ **IT CANNOT REUSE EITHER OF THE OTHER TWO, AND EACH REFUSAL IS ONE
 * SENTENCE.**
 *
 * - {@link composeTeamInvite} says *"Open the link below to choose a password
 *   and set up an authenticator app"*, which is right for a colleague joining a
 *   firm and flatly wrong here: **portal people have no password.** They sign in
 *   with a six-digit code emailed to the address this message went to, and
 *   telling a new starter to choose a password would send them looking for a
 *   screen that does not exist.
 * - {@link composeClientInvite} gets the password half right and the
 *   RELATIONSHIP wrong. It is sent in the PRACTICE's name — correct, because a
 *   client knows their accountant — and this one is not from the accountant at
 *   all. The person receiving it works for the business; naming an accounting
 *   firm they may never have heard of, in the subject line, is how a legitimate
 *   invitation reads as a phishing attempt. So the employer is named and the
 *   practice is not mentioned.
 *
 * **There is no token in the link, and that is deliberate rather than
 * unfinished.** The invitation's whole effect is a `contacts` row, and the
 * portal's tokenless sign-in (`resolveByAddress`) resolves an address to exactly
 * one business off that row — so the address the mail arrived at is already
 * everything the sign-in needs. A setup token would add three things nobody
 * asked for: a seven-day expiry on a relationship that has none, a second
 * credential travelling by email, and the CLIENT-ONBOARDING journey (company
 * details, then subscribe), which belongs to the owner and not to somebody hired
 * to photograph receipts.
 *
 * **No enumeration oracle.** This message is only ever sent to an address the
 * caller typed into their own workspace's People screen, and it says nothing
 * about whether that address was already known to the product. The API's answer
 * to the caller is the same whether or not it was.
 */
export function composeBusinessPeopleInvite(input: ComposeBusinessPeopleInviteInput): ComposedEmail {
  const subject = `${input.businessName} has added you on ${SENDER_DISPLAY_NAME}`;
  const body = lines(
      input.inviterName === null
        ? `You have been added to ${input.businessName}'s account on ${SENDER_DISPLAY_NAME}, which they use to send receipts and invoices to their accountant.`
        : `${input.inviterName} has added you to ${input.businessName}'s account on ${SENDER_DISPLAY_NAME}, which they use to send receipts and invoices to their accountant.`,
      '',
      // The two sentences that make the journey work. The address is the
      // credential channel, so it is named as such — a person who reads "sign in
      // with this email" knows which of their addresses to type.
      'You can send a photo, forward an email, or upload a file. There is nothing to install and no password to choose.',
      '',
      'Sign in here with this email address, and a six-digit code will be sent to you:',
      input.portalLink,
      '',
      `If you were not expecting this, you can ignore this email — or tell ${input.businessName}, who can remove you.`,
      '',
      SENDER_DISPLAY_NAME,
  );
  return { subject, body, html: renderEmailHtml({ subject, body, linkLabels: { [input.portalLink]: 'Sign in' } }) };
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
  // The one and only `reveal()` — held in a local so the HTML render styles
  // the same six digits rather than calling for them twice.
  const code = input.code.reveal();
  const subject = `Your ${SENDER_DISPLAY_NAME} sign-in code`;
  const body = lines(
      `Your sign-in code is ${code}`,
      '',
      `It expires in ${input.expiresInMinutes} ${input.expiresInMinutes === 1 ? 'minute' : 'minutes'} and can be used once.`,
      '',
      'Nobody from our team will ever ask you for this code. If you did not just try to sign in, ignore this email — the code is useless on its own and no one else has been given access.',
      '',
      SENDER_DISPLAY_NAME,
  );
  return { subject, body, html: renderEmailHtml({ subject, body, highlight: code }) };
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
  const subject = `${input.businessName}: we're missing ${noun}`;
  const body = lines(
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
  );
  return { subject, body, html: renderEmailHtml({ subject, body, linkLabels: { [input.portalLink]: 'Upload securely' } }) };
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
  const subject = `Confirm your email address for ${SENDER_DISPLAY_NAME}`;
  const body = lines(
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
  );
  return { subject, body, html: renderEmailHtml({ subject, body, linkLabels: { [input.verifyLink]: 'Confirm email address' } }) };
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
  const subject = 'Someone tried to sign up with your email address';
  const body = lines(
      `Someone entered this email address when signing up for ${SENDER_DISPLAY_NAME}. It already has an account, so nothing was created and nothing has changed.`,
      '',
      'If that was you, sign in as usual rather than signing up again.',
      '',
      'If it was not you, there is nothing you need to do. Your account is unaffected and no one has gained access to it. If you would like us to look into it, reply to this email.',
      '',
      SENDER_DISPLAY_NAME,
  );
  return { subject, body, html: renderEmailHtml({ subject, body }) };
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
