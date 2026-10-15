import { connect, type Socket } from 'node:net';

import type { ScanVerdict, VirusScanner } from './virus-scan.js';

/**
 * The REAL virus scanner (Governance §11.4 step 4): a clamd client speaking the
 * daemon's INSTREAM protocol over a plain socket.
 *
 * Zero dependencies on purpose. The protocol is four rules long and every
 * published npm client either pulls in a stream library we do not need or hides
 * the one decision that matters here — what happens when the daemon does not
 * answer — behind a default we would have to audit. Adding a dependency is a
 * stop-and-ask item (CLAUDE.md); 150 lines of `node:net` is not.
 *
 * THE PROTOCOL (clamd(8), "INSTREAM"), with the `z` prefix so every reply is
 * NUL-terminated and the framing is unambiguous:
 *
 *   → "zINSTREAM\0"
 *   → <4-byte big-endian length><chunk>   …repeated…
 *   → <4 zero bytes>                       end of stream
 *   ← "stream: OK\0"                                  clean
 *   ← "stream: <Signature-Name> FOUND\0"              infected
 *   ← "INSTREAM size limit exceeded. ERROR\0"         clamd refused (StreamMaxLength)
 *
 * FAIL CLOSED. This is the property the fixture could not have and the reason
 * the file exists. Any outcome that is not an unambiguous `OK` or `FOUND` —
 * connection refused, timeout, a truncated reply, an `ERROR` line — is thrown
 * as `VirusScanUnavailableError`, never returned as "clean". The pipeline lets
 * that throw propagate, so the ingest job fails, BullMQ retries it, and three
 * failures land it in the DLQ that pages (Governance §7). A scanner that is
 * down must look like a scanner that is down, not like a clean bill of health —
 * clamav.tf's signature-bucket banner names exactly this as "the dangerous
 * failure mode".
 *
 * Also note what this is NOT: it does not mark the document REJECTED. A
 * rejection is a statement about the FILE ("this has a virus"), shown to the
 * submitter. An outage is a statement about US, and telling a client their
 * receipt was refused because our scanner was restarting would be the wrong
 * message to the wrong person.
 */

export interface ClamdOptions {
  /** TCP host of clamd. Ignored when `socketPath` is set. */
  readonly host?: string;
  /** TCP port of clamd; 3310 is the daemon's default. */
  readonly port?: number;
  /** A Unix domain socket path — the alternative to host/port, used locally. */
  readonly socketPath?: string;
  /**
   * Whole-scan deadline, connect included. clamav.tf budgets ~120 s at p99 for a
   * 100 MB archive on 0.5 vCPU; the default sits above that so a slow-but-live
   * daemon is not reported as dead.
   */
  readonly timeoutMs?: number;
  /**
   * Bytes per INSTREAM frame. clamd accepts any size; 64 KiB keeps the socket's
   * write buffer and the loop iterations both small for a 100 MB file.
   */
  readonly chunkBytes?: number;
}

/** The scanner could not produce a verdict. Fail closed — retry, never pass. */
export class VirusScanUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(`virus scan unavailable: ${message}`);
    this.name = 'VirusScanUnavailableError';
    this.cause = cause;
  }
}

export interface ClamdVirusScanner extends VirusScanner {
  /** `zPING` → `PONG`. A liveness probe for boot logs and health checks. */
  ping(): Promise<boolean>;
}

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** `ping` is a round trip of a handful of bytes; a daemon that cannot answer it in 5 s is not up. */
const PING_TIMEOUT_MS = 5_000;

export function createClamdVirusScanner(options: ClamdOptions = {}): ClamdVirusScanner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const target =
    options.socketPath !== undefined
      ? { path: options.socketPath }
      : { host: options.host ?? '127.0.0.1', port: options.port ?? DEFAULT_PORT };

  return {
    async scan(bytes: Buffer): Promise<ScanVerdict> {
      const reply = await exchange(target, timeoutMs, (socket) => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(chunk.length, 0);
          socket.write(header);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4, 0));
      });
      return parseClamdReply(reply);
    },

    async ping(): Promise<boolean> {
      try {
        const reply = await exchange(target, PING_TIMEOUT_MS, (socket) => {
          socket.write('zPING\0');
        });
        return reply === 'PONG';
      } catch {
        return false;
      }
    },
  };
}

/**
 * Exported for the unit tests, and because it is the half of the protocol most
 * likely to be misread: `FOUND` carries the signature, `OK` carries nothing, and
 * everything else is a refusal to produce a verdict.
 */
export function parseClamdReply(reply: string): ScanVerdict {
  // "stream: OK" — clean.
  if (/^stream: OK$/.test(reply)) return { infected: false };

  // "stream: Win.Test.EICAR_HDB-1 FOUND" — the signature name sits between the
  // stream label and the verdict word.
  const found = /^stream: (.+) FOUND$/.exec(reply);
  const signature = found?.[1];
  if (signature !== undefined) return { infected: true, signature };

  // "INSTREAM size limit exceeded. ERROR", "stream: … ERROR", an empty string
  // from a daemon that closed without answering — none of these is a verdict.
  throw new VirusScanUnavailableError(`clamd replied "${reply.slice(0, 120)}"`);
}

type Target = { readonly path: string } | { readonly host: string; readonly port: number };

/**
 * One connection, one command, one NUL-terminated reply, then close. clamd's
 * `z` commands end the reply with `\0`, and the daemon closes the socket after a
 * non-IDSESSION command, so "reply complete" is whichever arrives first. The
 * deadline covers the whole exchange: connecting, streaming, and clamd's scan.
 */
function exchange(target: Target, timeoutMs: number, send: (socket: Socket) => void): Promise<string> {
  return new Promise<string>((resolve, rejectPromise) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const socket = connect(target);
    socket.setNoDelay(true);

    const finish = (outcome: { ok: true; reply: string } | { ok: false; error: VirusScanUnavailableError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (outcome.ok) resolve(outcome.reply);
      else rejectPromise(outcome.error);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: new VirusScanUnavailableError(`no verdict within ${timeoutMs} ms`) });
    }, timeoutMs);

    socket.once('connect', () => {
      try {
        send(socket);
      } catch (error) {
        finish({ ok: false, error: new VirusScanUnavailableError('could not write to clamd', error) });
      }
    });

    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      const joined = Buffer.concat(chunks);
      const nul = joined.indexOf(0);
      if (nul !== -1) finish({ ok: true, reply: joined.toString('utf8', 0, nul) });
    });

    socket.once('error', (error: Error) => {
      finish({ ok: false, error: new VirusScanUnavailableError(error.message, error) });
    });

    // The daemon closed without a terminator: whatever arrived is the reply, and
    // `parseClamdReply` will refuse it unless it is a complete verdict.
    socket.once('close', () => {
      finish({ ok: true, reply: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
