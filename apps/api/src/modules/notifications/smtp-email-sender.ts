import { createConnection, type Socket } from 'node:net';

import type { EmailAddress } from './email-address.js';
import type { EmailSender, OutboundEmail, SentEmail } from './email-sender.js';

/**
 * The local SMTP sender — the one that makes a sign-in code actually arrive.
 *
 * ## Why this exists
 *
 * `DemoEmailSender` "sends" into a private in-memory array. Nothing is logged
 * and nothing is exposed, so on a laptop the OTP a client needs in order to
 * sign in to the portal is unreadable: the journey the product is built around
 * cannot be walked end to end. `docker-compose` has run **MailHog** all along
 * for exactly this, and `.env` has carried `SMTP_HOST`/`SMTP_PORT` pointing at
 * it — there was simply no sender that spoke SMTP.
 *
 * ## Why it is hand-written rather than nodemailer
 *
 * Adding a dependency is on the root `CLAUDE.md`'s stop-and-ask list, and the
 * repo's own precedent is the hand-written QR encoder in `views/signup/qr.ts`:
 * a small, well-specified protocol used at one call site is cheaper to own than
 * to depend on. This speaks the minimum of RFC 5321 — `EHLO`, `MAIL FROM`,
 * `RCPT TO`, `DATA`, `.`, `QUIT` — which is the whole conversation a local sink
 * needs.
 *
 * ## ⚠ It is a DEVELOPMENT transport, and `config/env.ts` refuses it in production
 *
 * There is **no authentication and no TLS** here, because MailHog offers
 * neither. That is safe against a sink on `localhost` and unsafe against
 * anything else — credentials and client financial correspondence would cross
 * the network in clear text. `smtp` therefore joins `demo` in the boot refusal
 * under `NODE_ENV=production`. The real transport is `ses`, and this is not a
 * fallback for it: `select-email-sender.ts` explains at length why a sender
 * that degrades on failure reports delivered mail that no human receives. A
 * failed send here throws, exactly as SES does.
 */

export interface SmtpEmailSenderConfig {
  readonly host: string;
  readonly port: number;
  readonly fromAddress: string;
  /**
   * The address a reply should go to, or `''` for none — mirroring
   * `SesEmailSender`, which reads the same `EMAIL_REPLY_TO_ADDRESS`. It was
   * silently dropped here while SES honoured it, so the two transports composed
   * different messages from one configuration and a reply typed on a laptop
   * went to `no-reply@` — the address `email-copy.ts` exists to keep mail OUT
   * of. Empty omits the header rather than writing an empty one.
   */
  readonly replyToAddress?: string;
  /**
   * ⚠ **An IDLE timeout, not a ceiling on the whole conversation.**
   * `socket.setTimeout` measures inactivity: the clock restarts on every reply,
   * so a server that answers each step just inside the window can keep the
   * exchange open indefinitely. What it does guarantee is the thing this
   * transport actually needs — a sink that stops answering fails the send
   * rather than hanging the request that is waiting on it. A true
   * whole-conversation deadline would be a second timer, and is not worth one
   * against a `localhost` sink that `config/env.ts` refuses in production.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** The id shape, deliberately unlike an SES message id so a log line is unambiguous. */
const SMTP_PROVIDER_PREFIX = 'smtp-local';

/**
 * SMTP terminates lines with CRLF, and a line that is a single `.` ends the
 * DATA block. A body line that happens to be "." would therefore end the
 * message early — the classic injection. Dot-stuffing (RFC 5321 §4.5.2) is the
 * specified defence: any line beginning with `.` gets a second one, which the
 * receiver strips.
 */
function toDataBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * Headers are `\r\n`-separated and must not carry a bare newline from a value —
 * that is header injection, and a subject is attacker-adjacent input (it can
 * carry a supplier's name). Newlines are stripped rather than escaped: there is
 * no legitimate newline in any header this sender writes.
 */
function headerValue(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * The same defence one layer down, where the reader is a COMMAND parser.
 *
 * `MAIL FROM:<…>` and `RCPT TO:<…>` are CRLF-terminated command lines, so a CR
 * or LF inside the address would end the command and begin another — header
 * injection's sibling, and the more dangerous of the two, because the injected
 * line is a verb rather than a field. Angle brackets close the reverse-path
 * early and are dropped for the same reason.
 *
 * ⚠ **Nothing reachable trips this today** — both values are addresses
 * `email-address.ts` has already parsed and which it refuses CR/LF in. It exists
 * because the file was ASYMMETRIC: headers were stripped, the DATA block was
 * dot-stuffed, and the commands interpolated raw. An asymmetry is a thing the
 * next reader has to re-derive the safety of, every time.
 */
function commandAddress(raw: string): string {
  const value = raw.replace(/[\r\n<>]/g, '').trim();
  if (value === '') throw new Error('SMTP address is empty once CR/LF and angle brackets are removed');
  return value;
}

export class SmtpEmailSender implements EmailSender {
  readonly #config: Required<SmtpEmailSenderConfig>;

  constructor(config: SmtpEmailSenderConfig) {
    this.#config = { timeoutMs: DEFAULT_TIMEOUT_MS, replyToAddress: '', ...config };
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    const message = this.#compose(email);
    await this.#converse(email.to, message);
    return {
      kind: email.kind,
      providerMessageId: `${SMTP_PROVIDER_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  /**
   * A MIME multipart/alternative when a rendering exists, plain text otherwise.
   * The text part is always present and always first — `email-html.ts` derives
   * the HTML from it, and a client that shows only text must still get the
   * whole message (the sign-in code included).
   */
  #compose(email: OutboundEmail): string {
    const to = String(email.to);
    const subject = headerValue(email.subject);
    const base = [
      `From: ${headerValue(this.#config.fromAddress)}`,
      `To: ${headerValue(to)}`,
      // Omitted when unset, the shape `SesEmailSender` uses — an empty
      // `Reply-To:` is a header some clients honour as "reply nowhere".
      ...(this.#config.replyToAddress === '' ? [] : [`Reply-To: ${headerValue(this.#config.replyToAddress)}`]),
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      // The kind rides as a header so MailHog's UI can be filtered by journey.
      `X-Neoting-Kind: ${headerValue(email.kind)}`,
    ];

    if (email.html === undefined) {
      return [...base, 'Content-Type: text/plain; charset=utf-8', '', toDataBlock(email.body)].join('\r\n');
    }

    const boundary = `nt-${Math.random().toString(36).slice(2, 12)}`;
    return [
      ...base,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      toDataBlock(email.body),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      toDataBlock(email.html),
      `--${boundary}--`,
    ].join('\r\n');
  }

  /**
   * The conversation. Each step waits for a reply whose first digit says how it
   * went: 2xx and 3xx continue, anything else is a failed send and throws with
   * the server's own line — the caller decides what a failure means, and the
   * notifications service already treats a throw as "not delivered".
   */
  #converse(to: EmailAddress, message: string): Promise<void> {
    const { host, port, fromAddress, timeoutMs } = this.#config;
    // Sanitised BEFORE the socket exists, so a refusal cannot leak a connection.
    const reversePath = commandAddress(fromAddress);
    const forwardPath = commandAddress(String(to));

    return new Promise<void>((resolve, reject) => {
      const socket: Socket = createConnection({ host, port });
      socket.setEncoding('utf8');
      // Idle, not total — see `timeoutMs` on the config interface.
      socket.setTimeout(timeoutMs);

      const steps = [
        `EHLO neoting.local`,
        `MAIL FROM:<${reversePath}>`,
        `RCPT TO:<${forwardPath}>`,
        'DATA',
        `${message}\r\n.`,
        'QUIT',
      ];
      let step = -1; // -1 is the server greeting, which arrives unprompted
      let buffer = '';
      let settled = false;

      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`SMTP send to ${host}:${port} failed — ${reason}`));
      };

      socket.on('error', (error) => fail(error.message));
      socket.on('timeout', () => fail(`no reply within ${timeoutMs}ms`));
      socket.on('close', () => {
        if (!settled) {
          settled = true;
          // Closing after QUIT is the normal end of the conversation.
          step >= steps.length - 1 ? resolve() : reject(new Error('SMTP connection closed mid-conversation'));
        }
      });

      socket.on('data', (chunk: string) => {
        buffer += chunk;
        // A reply may span lines; the last one is `NNN ` (space, not hyphen).
        const lines = buffer.split('\r\n').filter((l) => l.length > 0);
        const last = lines[lines.length - 1];
        if (last === undefined || /^\d{3}-/.test(last)) return;
        buffer = '';

        if (!/^[23]/.test(last)) return fail(last);

        step += 1;
        const next = steps[step];
        if (next === undefined) {
          if (settled) return;
          settled = true;
          socket.end();
          return resolve();
        }
        socket.write(`${next}\r\n`);
      });
    });
  }
}
