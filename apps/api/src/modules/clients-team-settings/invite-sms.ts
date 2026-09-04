/**
 * The client-invite SMS (4 Sep 2026 — the PM's walkthrough finding 3, built at
 * the owner's direction "behind the seam").
 *
 * Adding a client sends the setup link by EMAIL (the D45 channel this release
 * ships); this additionally sends it by TEXT when two things are true — the
 * intake captured a mobile, and the process is configured with the real SMS
 * wire (`SMS_SENDER=aws`). Under `demo` or `email` the wire is simply absent
 * and nothing is sent: those modes deliver "SMS" through the email transport,
 * and a second copy of the invite email would be noise wearing a feature's
 * name. The day carrier registration clears, the staging flip to
 * `SMS_SENDER=aws` turns this on with no code change — which is the whole
 * point of building it now.
 *
 * ⚠ It rides the chase lane's TRANSPORT (`AwsSmsTransport`), not its
 * `SmsSender` seam. That seam is chase-shaped on purpose — it stamps
 * `chase_messages` rows written by the approved executor — and an invite has
 * no chase, no review and no proposal: intake is `x-nt-side-effect: ingest`,
 * the same class as the invite email beside it. Fabricating chase rows to
 * borrow the seam would put fiction in an audit surface.
 *
 * ## The copy rules it inherits
 *
 * Pure function, like every composer: the words cannot drift between callers.
 * No credential travels — the setup token is the same one the email carries,
 * already the authorisation, and the sign-in code goes separately by email
 * when the client opens the link. D47: no connection is asked for and this
 * copy must never grow one.
 */

import type { AwsSmsTransport } from '../chase/index.js';

/** The wire, structurally — satisfied by `createAwsSmsTransport`. */
export type InviteSmsWire = Pick<AwsSmsTransport, 'sendText'>;

export interface ComposeClientInviteSmsInput {
  /** The practice doing the inviting — the client knows their accountant's name, not ours. */
  readonly practiceName: string;
  /** The full setup link, the same `buildSetupLink` output the email carries. */
  readonly setupLink: string;
}

/**
 * One sentence and the link. Shorter than the email on purpose — an SMS is a
 * tap target, not a letter — and sent in the PRACTICE's name for the
 * `composeClientInvite` reason: the client knows their accountant, not us.
 */
export function composeClientInviteSms(input: ComposeClientInviteSmsInput): string {
  return `${input.practiceName} has invited you to Neo Accounting. Set up your access: ${input.setupLink}`;
}
