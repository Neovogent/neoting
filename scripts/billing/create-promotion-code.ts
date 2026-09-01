// Operational script — mint a Stripe coupon + promotion code, BY HAND ONLY.
//
// There is deliberately no product surface for this (Shakib, 2 Sep 2026:
// "don't make any ui for that, just the backend, only manually"): who gets
// money off is a decision a human takes in front of this script or in the
// Stripe dashboard, never one the product offers. The hosted checkout already
// shows Stripe's own "Add promotion code" field (`allow_promotion_codes: true`
// in `http-stripe-client.ts`), so a code minted here is usable the moment it
// exists, with no deploy.
//
//   STRIPE_SECRET_KEY=rk_… pnpm tsx scripts/billing/create-promotion-code.ts \
//     --code NEOTEST100 [--percent 100] [--duration forever|once|repeating] \
//     [--months N] [--max-redemptions 1] [--expires-days 30]
//
// Defaults are the TEST-SUBSCRIPTION shape: 100% off, duration FOREVER,
// max_redemptions 1. Two of those defaults are safety, not taste:
//
// - **`forever`, not `once`.** `once` discounts only the first invoice; the
//   next monthly invoice charges the real card the full £10.20. A test
//   subscription on a live-mode key (which staging now runs — the secret is
//   `rk_live_…`, whatever older docs say about a sandbox) must never charge,
//   so the discount has to outlive the first month.
// - **100%, not £8.49-off.** The discount applies to the net subtotal and VAT
//   is calculated on what remains, so an £8.49 coupon leaves a ~1p invoice —
//   and Stripe refuses any GBP charge under £0.30. 100% makes the invoice
//   £0.00, which Stripe settles without charging at all.
//
// ⚠ A promotion code is visible to EVERY client at checkout, not only to the
// tester — `http-stripe-client.ts` says so at the `allow_promotion_codes`
// line. That is why max_redemptions defaults to 1 and why --expires-days
// exists. Mint narrow, mint again when needed.
//
// ⚠ The staging task's restricted key may lack the Coupons permission (it was
// scoped to Customers/Checkout/Portal by the runbook's own rule). If this
// script answers 401/403, the fix is in the Stripe dashboard: widen the
// restricted key with "Coupons: Write", or run with a key that has it.

import { STRIPE_API_VERSION, encodeForm } from '../../apps/api/src/modules/billing/http-stripe-client.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

interface Args {
  code: string;
  percent: number;
  duration: 'forever' | 'once' | 'repeating';
  months: number | null;
  maxRedemptions: number;
  expiresDays: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    const value = at === -1 ? undefined : argv[at + 1];
    return value === undefined ? null : value;
  };
  const code = get('--code');
  if (code === null || !/^[A-Z0-9_-]{4,40}$/i.test(code)) {
    throw new Error('--code is required: 4-40 letters/digits/-/_ (what the client will type at checkout)');
  }
  const percent = Number(get('--percent') ?? '100');
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('--percent must be 1-100');
  const duration = (get('--duration') ?? 'forever') as Args['duration'];
  if (!['forever', 'once', 'repeating'].includes(duration)) throw new Error('--duration: forever | once | repeating');
  const months = get('--months');
  if (duration === 'repeating' && months === null) throw new Error('--duration repeating needs --months');
  const maxRedemptions = Number(get('--max-redemptions') ?? '1');
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) throw new Error('--max-redemptions must be a positive integer');
  const expiresDays = get('--expires-days');
  return {
    code,
    percent,
    duration,
    months: months === null ? null : Number(months),
    maxRedemptions,
    expiresDays: expiresDays === null ? null : Number(expiresDays),
  };
}

async function post(key: string, path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${STRIPE_API_BASE}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
    },
    body: encodeForm(params),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = body['error'] as Record<string, unknown> | undefined;
    throw new Error(
      `Stripe ${path} refused: HTTP ${response.status} ${String(error?.['type'] ?? '')}/${String(error?.['code'] ?? '')} — ${String(error?.['message'] ?? '(no message)')}`,
    );
  }
  return body;
}

async function main(): Promise<void> {
  const key = process.env['STRIPE_SECRET_KEY'];
  if (key === undefined || key === '') throw new Error('STRIPE_SECRET_KEY is not set');
  const args = parseArgs(process.argv.slice(2));

  const coupon = await post(key, 'coupons', {
    percent_off: args.percent,
    duration: args.duration,
    ...(args.duration === 'repeating' ? { duration_in_months: args.months } : {}),
    name: `manual ${args.percent}% off (${args.code})`,
  });

  const promo = await post(key, 'promotion_codes', {
    // The pinned STRIPE_API_VERSION (2026-07-29.dahlia) nests this: a bare
    // `coupon` param is "unknown parameter" there. Verified against the live
    // API on 2 Sep 2026 — change it back only with an older pinned version.
    promotion: { type: 'coupon', coupon: coupon['id'] },
    code: args.code.toUpperCase(),
    max_redemptions: args.maxRedemptions,
    ...(args.expiresDays === null
      ? {}
      : { expires_at: Math.floor(Date.now() / 1000) + args.expiresDays * 86_400 }),
  });

  const mode = key.includes('_live_') ? 'LIVE' : 'test';
  console.log(`promotion code ${String(promo['code'])} created (${mode} mode)`);
  console.log(`  coupon ${String(coupon['id'])}: ${args.percent}% off, duration=${args.duration}${args.duration === 'repeating' ? ` months=${args.months}` : ''}`);
  console.log(`  max redemptions: ${args.maxRedemptions}${args.expiresDays === null ? '' : ` · expires in ${args.expiresDays}d`}`);
  console.log('  type it into the "Add promotion code" field on the hosted checkout.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
