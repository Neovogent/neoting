import { z } from 'zod';
import { inviteBusinessMember } from '@neoting/contracts/client';
import { unwrapBody } from './envelope';

/**
 * Re-sending a client's setup link (5 Sep 2026, staging finding).
 *
 * There is deliberately no "resend" operation in the contract, and none is
 * needed: `POST /businesses/{businessId}/members` with the primary contact's
 * own address mints a fresh invite row and emails a fresh setup link, and the
 * server's create-if-absent contact rule means re-inviting the same person
 * accumulates nothing (team.service.ts carries the argument). A new invite IS
 * the re-send — the client follows whichever link arrived last.
 *
 * `BUSINESS_ADMIN` matches the authority the primary contact already holds by
 * default (`portal-people-authority.ts`: a primary contact with no explicit
 * `portal_role` is the workspace's owner), so the re-send changes nobody's
 * standing.
 *
 * A rate-limited send is the contract's own `429 NT-RATE-001`, propagated as
 * `NtProblemError` for the panel to show honestly — the invite row was still
 * recorded, and the copy must not claim an email left.
 *
 * This module must stay OFF the bundle floor: imported only by the lazy
 * ClientDetailView chunk, plain generated function, no hook machinery — the
 * businesses client module is already floor-resident, so the marginal cost is
 * per-export (apps/web/CLAUDE.md, Bundle).
 */

/**
 * The success screen stands on the sent instant alone, so only that is pinned;
 * the rest of `Invite` passes through rather than being re-declared here.
 */
const inviteCreated = z.object({ createdAt: z.string().min(1) }).passthrough();

export async function resendClientSetupLink(businessId: string, email: string): Promise<{ sentAt: string }> {
  const body = unwrapBody(await inviteBusinessMember(businessId, { email, role: 'BUSINESS_ADMIN' }));
  const parsed = inviteCreated.safeParse(body);
  if (!parsed.success) {
    throw new Error('inviteBusinessMember answered off-contract — createdAt missing');
  }
  return { sentAt: parsed.data.createdAt };
}
