// DEMO-MOCK / demo driver — METH Stage 5 (§7).
//
// Sends a fixture invoice email into MailHog (the local SES stand-in) so the
// email intake beat runs LIVE: the poller (EMAIL_SOURCE=mailhog) lists it,
// resolves the practice from the `doc+<practice>@` plus tag, routes by sender
// identity, sanitises the attachment, and enqueues it through the real pipeline.
//
//   default            FROM owner@americanburger.test  → routes to American Burger
//   --unregistered     FROM stranger@example.test      → the Unrouted beat
//
// Transport is a hand-rolled minimal SMTP client over node:net — MailHog on
// :1025 takes plaintext with no auth (docker-compose). No dependency is added:
// nodemailer is NOT in the tree, so SMTP is spoken directly (RFC 5321 minimal
// subset: HELO / MAIL FROM / RCPT TO / DATA / QUIT).
//
// // DEMO-MOCK: in production a real client's mail hits SES → S3 (EMAIL_SOURCE=s3);
// // this injects the same MIME shape straight into the local MailHog for the demo.

import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';

const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? '1025');

/**
 * The single platform inbox with the practice plus-tag. `MailHogEmailSource`
 * reads the envelope recipient (RCPT TO) as `Raw.To[0]`, and
 * `resolvePracticeFromRecipient` takes the `+prac_ledgerline` tag as the tenancy
 * anchor. `prac_ledgerline` is the EXISTING seed practice id (renamed display to
 * "Neovogent Accounting" in Stage 5; the id is stable — METH_MODE §7).
 */
const RECIPIENT = 'doc+prac_ledgerline@neoting.neovogent.com';

/** The registered sender maps (via a seeded Contact) to American Burger. */
const REGISTERED_FROM = 'owner@americanburger.test';
/** No contact is seeded for this address → the document lands in Unrouted. */
const UNREGISTERED_FROM = 'stranger@example.test';

/**
 * A minimal but genuinely valid PDF (%PDF-1.4 … %%EOF), base64-encoded into the
 * multipart body. It is not a real invoice render — the magic-byte sniffer only
 * needs a well-formed PDF header/trailer to accept it as `application/pdf`.
 * // DEMO-MOCK: a real Google Ads PDF; this is a syntactically-valid stand-in.
 */
const TINY_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
  'xref',
  '0 4',
  '0000000000 65535 f ',
  '0000000009 00000 n ',
  '0000000052 00000 n ',
  '0000000101 00000 n ',
  'trailer<</Size 4/Root 1 0 R>>',
  'startxref',
  '170',
  '%%EOF',
  '',
].join('\n');

const ATTACHMENT_FILENAME = 'google-ads-invoice.pdf';

/** Read one SMTP reply line and assert its 3-digit code starts with `expected`. */
async function expectReply(socket: Socket, buffer: { data: string }, expected: string, step: string): Promise<void> {
  // Reply may already be buffered from a previous chunk; otherwise wait for data.
  while (!/\r?\n/.test(buffer.data)) {
    await once(socket, 'data');
  }
  const line = buffer.data.trimEnd();
  buffer.data = '';
  process.stdout.write(`  S: ${line}\n`);
  if (!line.startsWith(expected)) {
    throw new Error(`SMTP ${step}: expected ${expected}xx, got "${line}"`);
  }
}

/** Send one command line (CRLF-terminated) and log it. */
function sendLine(socket: Socket, line: string): void {
  // Never log the DATA payload verbatim — it is large; log the verb only.
  const shown = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  process.stdout.write(`  C: ${shown}\n`);
  socket.write(`${line}\r\n`);
}

function buildMime(from: string): string {
  const boundary = `nt-demo-boundary-${Date.now().toString(36)}`;
  const attachmentB64 = Buffer.from(TINY_PDF, 'utf8').toString('base64');
  // Wrap base64 at 76 cols (RFC 2045) — MailHog is tolerant, but be well-formed.
  const wrapped = (attachmentB64.match(/.{1,76}/g) ?? []).join('\r\n');
  // Date is the sender's clock and is IGNORED for freshness (the source's
  // observation time wins), but a well-formed header set is still sent.
  const lines = [
    `From: American Burger Accounts <${from}>`,
    `To: <${RECIPIENT}>`,
    // ASCII-only header — the subject is not load-bearing for routing, and a raw
    // UTF-8 em-dash/pound in a header without RFC 2047 encoding renders as mojibake.
    `Subject: Invoice INV-4471 - Google Ads GBP 600.00 (August)`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Hi — please find August's Google Ads invoice attached. Thanks.`,
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${ATTACHMENT_FILENAME}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${ATTACHMENT_FILENAME}"`,
    ``,
    wrapped,
    ``,
    `--${boundary}--`,
    ``,
  ];
  return lines.join('\r\n');
}

/**
 * Dot-stuff the DATA payload (RFC 5321 §4.5.2): a line that begins with '.'
 * gets a second '.' so it is not read as the end-of-data terminator.
 */
function dotStuff(mime: string): string {
  return mime.replace(/\r\n\./g, '\r\n..');
}

async function sendEmail(from: string): Promise<void> {
  process.stdout.write(`\nConnecting to MailHog SMTP at ${SMTP_HOST}:${SMTP_PORT}\n`);
  const socket = createConnection({ host: SMTP_HOST, port: SMTP_PORT });
  socket.setEncoding('utf8');
  const buffer = { data: '' };
  socket.on('data', (chunk: string) => {
    buffer.data += chunk;
  });

  await once(socket, 'connect');
  await expectReply(socket, buffer, '220', 'greeting');

  sendLine(socket, 'HELO neoting-demo.local');
  await expectReply(socket, buffer, '250', 'HELO');

  sendLine(socket, `MAIL FROM:<${from}>`);
  await expectReply(socket, buffer, '250', 'MAIL FROM');

  sendLine(socket, `RCPT TO:<${RECIPIENT}>`);
  await expectReply(socket, buffer, '250', 'RCPT TO');

  sendLine(socket, 'DATA');
  await expectReply(socket, buffer, '354', 'DATA');

  const mime = buildMime(from);
  socket.write(dotStuff(mime));
  socket.write('\r\n.\r\n'); // end-of-data terminator
  process.stdout.write(`  C: <MIME body, ${mime.length} bytes, 1 attachment "${ATTACHMENT_FILENAME}">\n`);
  await expectReply(socket, buffer, '250', 'end-of-data');

  sendLine(socket, 'QUIT');
  await expectReply(socket, buffer, '221', 'QUIT');
  socket.end();
}

async function main(): Promise<void> {
  const unregistered = process.argv.includes('--unregistered');
  const from = unregistered ? UNREGISTERED_FROM : REGISTERED_FROM;

  process.stdout.write('┌────────────────────────────────────────────┐\n');
  process.stdout.write('│  Neoting demo email driver (METH Stage 5)   │\n');
  process.stdout.write('└────────────────────────────────────────────┘\n');
  process.stdout.write(`  FROM:    ${from}${unregistered ? '  (unregistered → Unrouted beat)' : '  (registered → American Burger)'}\n`);
  process.stdout.write(`  TO:      ${RECIPIENT}\n`);
  process.stdout.write(`  Subject: Invoice INV-4471 - Google Ads GBP 600.00 (August)\n`);
  process.stdout.write(`  Attach:  ${ATTACHMENT_FILENAME} (${TINY_PDF.length}-byte %PDF fixture)\n`);

  await sendEmail(from);

  process.stdout.write('\n✅ email delivered to MailHog.\n');
  process.stdout.write('   The poller (EMAIL_SOURCE=mailhog) will pick it up and route by sender.\n');
  process.stdout.write('   Inspect it in the MailHog UI: http://localhost:8025\n');
  if (unregistered) {
    process.stdout.write('   This sender has no seeded contact → expect it in the Unrouted queue.\n');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n❌ demo email FAILED: ${message}\n`);
  process.stderr.write(`   Is MailHog up? \`docker ps\` should list nt-mailhog with :1025 exposed.\n`);
  process.exit(1);
});
