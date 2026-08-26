// DEMO-MOCK / demo driver — METH Stage 14 (§6 beat 7, the portal entry).
//
// Prints a WORKING OTP-portal link (`/p/<token>`) for a chase, because no
// outbox SMS carries one yet: the `chase.send` executor creates the chase row
// with a fresh id AFTER composition, so a compose-time token can never name it
// (the known gap flagged in apps/api/src/modules/chase/CLAUDE.md; the fix is
// the engine-side compose seam — stop-and-ask, post-demo). Until that seam
// exists, this driver is how beat 7 is entered: approve the chase, run this,
// open the printed URL in a phone-sized window.
//
//   pnpm demo:portal-link             → the newest open chase (SENT/REMINDED/ESCALATED)
//   pnpm demo:portal-link <chaseId>   → that chase
//
// Signing uses the SAME `PORTAL_LINK_SECRET` (from .env, via tsx --env-file)
// and the SAME `signPortalLink` the API verifies with — this mints nothing the
// product would not have minted itself. The chase lookup shells to psql in the
// compose container, the reset.ts way: an operational script, not app code.

import { execSync } from 'node:child_process';
import { signPortalLink } from '../../apps/api/src/modules/chase/portal-link.js';

const POSTGRES_CONTAINER = 'nt-postgres';
/** Where the web app serves `/p/<token>` — the Vite dev server for the demo. */
const WEB_ORIGIN = process.env.DEMO_WEB_ORIGIN ?? 'http://localhost:5173';

/** The newest chase a client could still act on — the one just approved, in the demo. */
function latestOpenChaseId(): string {
  const sql =
    "select id from chases where state in ('SENT','REMINDED','ESCALATED') order by created_at desc limit 1";
  const out = execSync(`docker exec ${POSTGRES_CONTAINER} psql -U neoting -d neoting -t -A -c "${sql}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  if (out === '') {
    throw new Error(
      'No open chase found — approve one first (chat: "Chase American Burger for the missing receipts").',
    );
  }
  return out;
}

function main(): void {
  const secret = process.env.PORTAL_LINK_SECRET ?? '';
  if (secret === '') {
    // Fail closed, the portal-link.ts stance: a link signed with nothing is a link anyone could mint.
    throw new Error('PORTAL_LINK_SECRET is empty — set it in .env; it must match the API process.');
  }

  const chaseId = process.argv[2] ?? latestOpenChaseId();
  const token = signPortalLink({ chaseId }, secret);

  process.stdout.write(`\nChase:  ${chaseId}\n`);
  process.stdout.write(`Portal: ${WEB_ORIGIN}/p/${token}\n\n`);
  process.stdout.write('Open it in a phone-sized window — the OTP is 000000 (OTP_MODE=demo).\n');
}

main();
