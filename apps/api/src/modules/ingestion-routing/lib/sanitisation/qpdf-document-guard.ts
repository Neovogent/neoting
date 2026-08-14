import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AcceptedFormat } from './formats.js';
import { type DocumentGuard, type DocumentGuardResult, passwordProtectedRejection } from './guards.js';
import { reject } from './reasons.js';

/**
 * The real PDF guard (issue #22), backed by `qpdf` (Apache-2.0, approved on #7).
 *
 * qpdf runs as a SUBPROCESS, and that is a security decision rather than a
 * packaging one. This is the code path that parses bytes a stranger emailed us,
 * and PDF parsers are a rich source of memory-corruption bugs. In a child
 * process with a timeout, a malicious PDF costs one failed document; in-process,
 * it costs the worker and every job in flight with it.
 */

export interface QpdfOutcome {
  /** qpdf's exit code. Non-zero is DATA here, not an error — see the constants below. */
  readonly code: number;
  readonly stderr: string;
  /** The rewritten document, when the operation produced one. */
  readonly output?: Buffer;
}

/**
 * The seam is drawn around the whole operation — process AND its temp files —
 * rather than around "run these arguments".
 *
 * That matters for testability: a runner faked at the argument level cannot
 * produce the output file the guard would then read, so the success path could
 * only ever be exercised where the binary is installed. Bytes in, bytes out
 * keeps the policy in this file testable everywhere and confines the messy part
 * to one implementation.
 */
export interface QpdfRunner {
  isEncrypted(pdf: Buffer): Promise<QpdfOutcome>;
  stripActiveContent(pdf: Buffer): Promise<QpdfOutcome>;
}

export interface QpdfGuardOptions {
  readonly runner?: QpdfRunner;
  readonly timeoutMs?: number;
  readonly binary?: string;
}

/** qpdf's documented contract, verified against 11.9.1. */
const ENCRYPTED = 0;
const NOT_ENCRYPTED = 2;
/** "Operation succeeded with warnings" — the normal outcome for real-world PDFs. */
const WARNINGS = 3;

export function createQpdfDocumentGuard(options: QpdfGuardOptions = {}): DocumentGuard {
  const runner = options.runner ?? execFileQpdfRunner(options.binary ?? 'qpdf', options.timeoutMs ?? 20_000);

  return {
    async inspect(bytes: Buffer, format: AcceptedFormat): Promise<DocumentGuardResult> {
      // PDFs only. Encrypted Office documents are a different container with a
      // different scheme, and qpdf knows nothing about them — running it over a
      // .docx would report clean because it never looked, which is worse than
      // admitting the gap.
      if (format !== 'pdf') return { ok: true, bytes };

      try {
        // 1 · Encryption. This is the bug the issue exists for. The dependency-
        // free shim greps the first and last 8 KB for `/Encrypt`, which misses a
        // mid-file trailer in an incrementally-updated PDF — anything signed,
        // form-filled or annotated, i.e. much of real accounting paperwork.
        // Those passed as clean and then failed in extraction looking corrupt
        // rather than locked, so the client was told the wrong thing. qpdf walks
        // the xref chain properly.
        const encrypted = await runner.isEncrypted(bytes);
        if (encrypted.code === ENCRYPTED) return { ok: false, rejection: passwordProtectedRejection() };
        if (encrypted.code !== NOT_ENCRYPTED) return { ok: false, rejection: unreadable(encrypted.stderr) };

        // 2 · Strip active content.
        const stripped = await runner.stripActiveContent(bytes);
        if (stripped.code !== 0 && stripped.code !== WARNINGS) {
          return { ok: false, rejection: unreadable(stripped.stderr) };
        }
        if (stripped.output === undefined) return { ok: false, rejection: unreadable('qpdf produced no output') };

        return { ok: true, bytes: stripped.output };
      } catch (error) {
        // A timeout lands here. Never rethrow: one document fails visibly rather
        // than the worker dying and taking the rest of the batch with it.
        return { ok: false, rejection: unreadable(error instanceof Error ? error.message : 'unknown') };
      }
    },
  };
}

function unreadable(detail: string) {
  return reject(
    'format_not_processable',
    'We could not read this PDF. It may be damaged — please try resending it, or export it again from the original program.',
    // qpdf's stderr derives from attacker-controlled bytes. Kept for OUR logs;
    // never shown to a submitter and never handed to a model.
    { reason: detail.slice(0, 200) },
  );
}

export function execFileQpdfRunner(binary: string, timeoutMs: number): QpdfRunner {
  return {
    async isEncrypted(pdf: Buffer): Promise<QpdfOutcome> {
      return withTempFile(pdf, async (input) => run(binary, ['--is-encrypted', input], timeoutMs));
    },

    async stripActiveContent(pdf: Buffer): Promise<QpdfOutcome> {
      return withTempFile(pdf, async (input, dir) => {
        const output = join(dir, `${randomBytes(8).toString('hex')}.out.pdf`);
        // `--empty` IS THE WHOLE MECHANISM, and leaving it out is a silent
        // no-op. qpdf is a *content-preserving* transformer by design: given an
        // input document it keeps that document's catalog, so
        // `qpdf in.pdf --pages . 1-z -- out.pdf` copies the JavaScript name
        // tree, OpenAction and embedded files straight through. Verified
        // against qpdf 11.9.1 — a fixture carrying two JavaScript actions and an
        // embedded `payload.exe` came out with all of them intact.
        //
        // `--empty` starts from a BLANK document and pulls only pages into it,
        // so everything hanging off the source catalog is left behind. Same
        // fixture, `--empty` added: JavaScript, OpenAction and EmbeddedFiles all
        // gone, both pages preserved.
        //
        // `1-z` is every page. `1` would keep only the first and quietly
        // truncate every multi-page invoice.
        const outcome = await run(binary, stripArgs(input, output), timeoutMs);
        if (outcome.code !== 0 && outcome.code !== WARNINGS) return outcome;
        return { ...outcome, output: await readFile(output) };
      });
    },
  };
}

/**
 * The strip invocation, exported so it can be asserted directly rather than
 * inferred from behaviour that only appears where the binary is installed.
 */
export function stripArgs(input: string, output: string): readonly string[] {
  return ['--empty', '--pages', input, '1-z', '--', output];
}

async function withTempFile<T>(bytes: Buffer, fn: (input: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nt-qpdf-'));
  const input = join(dir, `${randomBytes(8).toString('hex')}.pdf`);
  try {
    await writeFile(input, bytes);
    return await fn(input, dir);
  } finally {
    // Untrusted bytes do not get to linger on the worker's disk.
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `execFile`, never `exec` — no shell is involved, so nothing in an argument can
 * become a command. The paths are ours (a fresh mkdtemp) rather than anything
 * derived from the sender, but the rule holds regardless of today's inputs.
 */
function run(binary: string, args: readonly string[], timeoutMs: number): Promise<QpdfOutcome> {
  return new Promise((resolve, rejectPromise) => {
    execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stderr });
      // A non-zero exit is DATA — qpdf reports "not encrypted" as exit 2 — so it
      // must not be thrown. A KILLED process (timeout) carries no exit code and
      // is a genuine failure.
      const code = typeof error.code === 'number' ? error.code : null;
      if (code === null) return rejectPromise(error);
      resolve({ code, stderr });
    });
  });
}
