// DEMO-MOCK / demo driver — METH Stage 5 (§7).
//
// Posts a correctly-HMAC-signed WhatsApp Cloud API webhook envelope to the real
// unversioned endpoint, so the WhatsApp intake beat runs LIVE end-to-end:
// signature guard → envelope parse → replay dedupe → enqueue → worker fetches
// the (fixture) media by id → sanitise → persist to the practice inbox. The
// WhatsApp lane routes to the practice (Unrouted queue), and the accountant
// routes it to American Burger with one click (the Stage-12 beat) — the WhatsApp
// sender→business map is out of Stage 5 scope (PRD: WhatsApp ingest is DONE).
//
// One image message:
//   from            +447700900001  (the seeded American Burger contact mobile)
//   image.id        demo-media-currys  (the fixture media id the worker resolves)
//   phone_number_id WHATSAPP_DEMO_PHONE_NUMBER_ID (must map to prac_ledgerline)
//
// The raw JSON body is HMAC-SHA256-signed with META_APP_SECRET and sent as
// `X-Hub-Signature-256: sha256=<hex>` — the EXACT scheme the guard verifies
// (createHmac over the raw bytes, lowercase hex). Signing and POST use only
// node:crypto and node:http — no dependency is added.
//
// // DEMO-MOCK: a real WhatsApp message arrives from Meta's Cloud API; this
// // reproduces the same signed envelope Meta would deliver, against local :3000.

import { createHmac } from 'node:crypto';
import { request } from 'node:http';

/**
 * ⚠ MUST MATCH `DEMO_WHATSAPP_MEDIA_ID` in
 * apps/api/src/modules/ingestion-routing/queue/media-fetcher.ts.
 * The fixture fetcher (`seedDemoMedia`) only holds bytes for THIS id; any other
 * id dead-letters with `not_found`, which is the opposite of the demo beat.
 * Hardcoded (not imported) so the script stays a dependency-light operational
 * tool that runs under a cold `tsx` with no contracts build.
 */
const DEMO_WHATSAPP_MEDIA_ID = 'demo-media-currys';

/** The seeded American Burger contact mobile (E.164 without the leading +, as Meta sends `from`). */
const SENDER_WA_ID = '447700900001';

/**
 * The WABA number that RECEIVED the message. `WHATSAPP_PRACTICE_MAP` must map
 * this id → `prac_ledgerline` or the worker refuses to anchor the document and
 * it dead-letters (fail-closed by design). Defaults to the same placeholder the
 * .env.example example uses.
 */
const PHONE_NUMBER_ID = process.env.WHATSAPP_DEMO_PHONE_NUMBER_ID ?? '123456789012345';

/** The unversioned webhook endpoint — NOT under /v1 (routing.ts UNVERSIONED_ROUTES). */
const WEBHOOK_HOST = process.env.DEMO_API_HOST ?? 'localhost';
const WEBHOOK_PORT = Number(process.env.DEMO_API_PORT ?? '3000');
const WEBHOOK_PATH = '/webhooks/whatsapp';

/** A fresh wamid each run so the replay store never treats it as a duplicate. */
function freshWamid(): string {
  return `wamid.demo.${Date.now()}`;
}

/**
 * Render an error legibly. A Node socket error (ECONNREFUSED) often has an empty
 * `.message` but a meaningful `.code`, so a bare message would print a blank line.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    const base = error.message.length > 0 ? error.message : error.name;
    return code !== undefined ? `${base} (${code})` : base;
  }
  return String(error);
}

/** Build the Meta Cloud API envelope for one inbound image message. */
function buildEnvelope(): unknown {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'demo-waba-entry',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '447700900900',
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [{ wa_id: SENDER_WA_ID, profile: { name: 'American Burger' } }],
              messages: [
                {
                  id: freshWamid(),
                  from: SENDER_WA_ID,
                  timestamp: String(nowSeconds),
                  type: 'image',
                  image: {
                    id: DEMO_WHATSAPP_MEDIA_ID,
                    mime_type: 'image/jpeg',
                    caption: 'Currys receipt',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function postWebhook(rawBody: string, signatureHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: WEBHOOK_HOST,
        port: WEBHOOK_PORT,
        path: WEBHOOK_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'X-Hub-Signature-256': signatureHeader,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

async function main(): Promise<void> {
  process.stdout.write('┌────────────────────────────────────────────┐\n');
  process.stdout.write('│  Neoting demo WhatsApp driver (METH Stage 5)│\n');
  process.stdout.write('└────────────────────────────────────────────┘\n');

  const secret = process.env.META_APP_SECRET ?? '';
  // The signature is computed over the EXACT bytes sent, so serialise once.
  const rawBody = JSON.stringify(buildEnvelope());

  if (secret.length === 0) {
    process.stdout.write('\n⚠  META_APP_SECRET is empty.\n');
    process.stdout.write('   The signature guard fails CLOSED — the API will 401 this webhook.\n');
    process.stdout.write('   Set META_APP_SECRET in .env (and restart the API) to make it verify.\n');
    process.stdout.write('   Also set WHATSAPP_PRACTICE_MAP so the phone_number_id anchors to a practice, e.g.\n');
    process.stdout.write(`     WHATSAPP_PRACTICE_MAP={"${PHONE_NUMBER_ID}":"prac_ledgerline"}\n`);
    process.stdout.write('   Sending anyway to show the 401 behaviour...\n');
  }

  // sha256=<lowercase hex HMAC-SHA256(rawBody, secret)> — signature.ts verifies this.
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const signatureHeader = `sha256=${hex}`;

  process.stdout.write(`\n  POST http://${WEBHOOK_HOST}:${WEBHOOK_PORT}${WEBHOOK_PATH}  (unversioned — not /v1)\n`);
  process.stdout.write(`  from:            +${SENDER_WA_ID}\n`);
  process.stdout.write(`  image.id:        ${DEMO_WHATSAPP_MEDIA_ID}\n`);
  process.stdout.write(`  phone_number_id: ${PHONE_NUMBER_ID}\n`);
  process.stdout.write(`  X-Hub-Signature-256: ${signatureHeader.slice(0, 22)}…\n`);

  const { status, body } = await postWebhook(rawBody, signatureHeader);

  process.stdout.write(`\n  ← HTTP ${status}${body.length > 0 ? ` ${body}` : ''}\n`);
  if (status === 200) {
    process.stdout.write('\n✅ webhook accepted. The worker will fetch the fixture media and persist it.\n');
    process.stdout.write('   The document lands in the practice inbox (Neovogent Accounting), in the\n');
    process.stdout.write('   UNROUTED queue — the WhatsApp lane routes to the practice, and the\n');
    process.stdout.write('   accountant routes it to American Burger with one click (the Stage-12 beat).\n');
    process.stdout.write('   (Requires the API + worker running, and WHATSAPP_PRACTICE_MAP anchoring\n');
    process.stdout.write(`    "${PHONE_NUMBER_ID}" → "prac_ledgerline", or the job dead-letters.)\n`);
  } else if (status === 401) {
    process.stdout.write('\n❌ 401 — the signature did not verify.\n');
    process.stdout.write('   The META_APP_SECRET used here must match the one the API booted with.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`\n⚠  unexpected status ${status}. Is the API running on :${WEBHOOK_PORT}?\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n❌ demo whatsapp FAILED: ${describeError(error)}\n`);
  process.stderr.write(`   Is the API up on :${WEBHOOK_PORT}? \`pnpm dev\` (or the api process) must be running.\n`);
  process.exit(1);
});
