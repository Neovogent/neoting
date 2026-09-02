import { NtProblemError } from '@neoting/contracts';
import { acceptInvitation, previewInvitation } from '@neoting/contracts/client';
import { acceptInvitationBody, acceptInvitationBodyPasswordMin, previewInvitationBody, previewInvitationResponse } from '@neoting/contracts/zod';
import type { InvitationPreview } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The invited colleague's two calls, over `POST /v1/auth/invitation-preview` and
 * `POST /v1/auth/invitation-acceptance`.
 *
 * A separate module from `api/team.ts` on purpose: that one belongs to the
 * practice's Team screen and this one to `/invite`, a public route an
 * unauthenticated stranger opens. Nothing on the invitee's journey should drag
 * the workspace's team surface down with it, and nothing on the Team screen
 * should carry the acceptance calls.
 *
 * ⚠ **THE TOKEN IS A CREDENTIAL AND IT NEVER TRAVELS IN A URL.** Both operations
 * are `POST` with the token in the BODY — a `GET` would put it in browser
 * history, in every access log on the way, and in the `Referer` of the next
 * outbound link on the page. The screen additionally scrubs it out of the
 * address bar with `replaceState` before the first request, which is M9's rule
 * for `/signup/verify` and applies here for the same reason.
 *
 * ⚠ **ACCEPTANCE RETURNS NO SESSION**, deliberately. The account has no second
 * factor yet and sign-in fails closed without one, so the next step is the same
 * `POST /auth/totp-enrolment` a founder takes — reached with the password the
 * invitee has just chosen. There is nothing here to store and nothing to
 * persist.
 */

/** The contract's own minimum, read from the schema rather than retyped. */
export const INVITE_PASSWORD_MIN_LENGTH = acceptInvitationBodyPasswordMin;

export type { InvitationPreview };

/**
 * What the invitation is for.
 *
 * Unlike `/signup/check-email` this MAY name the practice and the role: the
 * caller holds a token we emailed to the address it names, so every fact in the
 * answer is already in the message they are reading it from.
 */
export async function readInvitation(token: string): Promise<InvitationPreview> {
  const request = previewInvitationBody.parse({ token });
  const body = previewInvitationResponse.parse(unwrapBody(await previewInvitation(request)));
  return body as InvitationPreview;
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * Create the account.
 *
 * Neither the role nor the address is sent: both come from the invitation, so a
 * field for either would let the person accepting decide what an admin already
 * decided for them. The answer is the address the account was created with —
 * everything the enrolment step needs, and nothing else.
 */
export async function acceptInvite(input: AcceptInvitationInput): Promise<{ email: string }> {
  const request = acceptInvitationBody.parse({
    token: input.token,
    password: input.password,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
  });
  const value = unwrapBody(await acceptInvitation(request));
  // orval emits no response schema for this `201`, so the one field the contract
  // requires is pinned by hand rather than an unverified body being reported as
  // a created account.
  if (typeof value !== 'object' || value === null || typeof (value as { email?: unknown }).email !== 'string') {
    throw new Error('The server created the account but answered with a shape this app does not recognise.');
  }
  return { email: (value as { email: string }).email };
}

/**
 * What went wrong, in the shape the screens render — the same three-line
 * contract `api/signup.ts` defines, so the invitee's journey and the founder's
 * render faults identically.
 *
 * `code` is `null` when the request never got an answer at all, which is a real
 * and different thing to tell somebody: "check your connection" is only ever
 * true for `code === null`, and a code means a reply came back over the very
 * connection that sentence would blame.
 */
export interface InvitationFault {
  code: string | null;
}

export function invitationFaultOf(error: unknown): InvitationFault {
  return { code: error instanceof NtProblemError ? error.code : null };
}
