import { expect, test } from 'vitest';

import { currentTraceId } from '../../../../common/trace/trace-context.js';
import { InMemoryDocumentStore } from '../../storage/document-store.js';
import { FixtureIngestQueue, type IngestQueue } from '../../webhooks/whatsapp/ingest-queue.js';
import type { EmailParser } from '../email-parser.js';
import type { ParsedEmail } from '../parsed-email.js';
import { drainEmailSource, type EmailIntakeRunnerDeps, runEmailIntake } from './email-intake-runner.js';
import { type EmailSource, FixtureEmailSource, type InboundRawEmail } from './email-source.js';

/** A PNG signature is all the sniffer reads; the fixture normaliser is a passthrough. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

function parsedEmail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: 'sender@acme.co',
    to: 'doc+prac_x@neoting.test',
    subject: 'lunch',
    date: null,
    messageId: '<m1@acme.co>',
    text: 'body',
    attachments: [{ filename: 'r.png', contentType: 'image/png', bytes: PNG }],
    ...over,
  };
}

function stubParser(email: ParsedEmail | (() => Promise<ParsedEmail>)): EmailParser {
  return { parse: typeof email === 'function' ? email : async () => email };
}

function rawEmail(over: Partial<InboundRawEmail> = {}): InboundRawEmail {
  return { id: 's3-key-1', raw: Buffer.from('raw'), envelopeRecipient: null, receivedAtSeconds: 1_700_000_000, ...over };
}

function baseDeps(over: Partial<EmailIntakeRunnerDeps> = {}): {
  deps: EmailIntakeRunnerDeps;
  queue: FixtureIngestQueue;
  logs: string[];
  warns: string[];
} {
  const queue = new FixtureIngestQueue();
  const logs: string[] = [];
  const warns: string[] = [];
  const deps: EmailIntakeRunnerDeps = {
    parser: stubParser(parsedEmail()),
    queue,
    logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    store: new InMemoryDocumentStore(),
    ...over,
  };
  return { deps, queue, logs, warns };
}

test('parses, resolves the practice from the recipient, and enqueues the accepted attachment', async () => {
  const { deps, queue } = baseDeps();
  const outcome = await runEmailIntake(rawEmail(), deps);

  expect(outcome.status).toBe('processed');
  if (outcome.status !== 'processed') throw new Error('expected processed');
  expect(outcome.practiceId).toBe('prac_x');
  expect(outcome.result.accepted).toHaveLength(1);
  expect(queue.enqueued).toHaveLength(1);
  const job = queue.enqueued[0];
  expect(job?.source).toBe('email');
  expect(job?.practiceId).toBe('prac_x');
  expect(job?.storageKey).toContain('w/_unrouted/prac_x/documents/');
});

test('the envelope recipient wins over the To header for practice resolution', async () => {
  // One delivery's envelope is what SES actually routed on; the To header is a
  // fallback. Attributing to the header could file the document under the wrong
  // practice when they differ.
  const { deps, queue } = baseDeps({ parser: stubParser(parsedEmail({ to: 'doc+prac_header@neoting.test' })) });
  const outcome = await runEmailIntake(rawEmail({ envelopeRecipient: 'doc+prac_env@neoting.test' }), deps);
  if (outcome.status !== 'processed') throw new Error('expected processed');
  expect(outcome.practiceId).toBe('prac_env');
  expect(queue.enqueued[0]?.practiceId).toBe('prac_env');
});

test('receivedAtSeconds comes from the source, not the sender’s forgeable Date header', async () => {
  const { deps, queue } = baseDeps({ parser: stubParser(parsedEmail({ date: new Date('2000-01-01T00:00:00Z') })) });
  await runEmailIntake(rawEmail({ receivedAtSeconds: 1_712_345_678 }), deps);
  expect(queue.enqueued[0]?.receivedAtSeconds).toBe(1_712_345_678);
});

test('the traceId born at the trigger reaches the enqueue, the way the whatsapp path does', async () => {
  const seen: (string | undefined)[] = [];
  const queue: IngestQueue = {
    async enqueue() {
      seen.push(currentTraceId());
    },
  };
  const { deps } = baseDeps({ queue, newTraceId: () => 'trace-fixed' });
  await runEmailIntake(rawEmail(), deps);
  expect(seen).toEqual(['trace-fixed']);
});

test('an unresolvable recipient is NOT dropped: nothing enqueued, the outcome says so', async () => {
  const { deps, queue } = baseDeps({ parser: stubParser(parsedEmail({ to: 'doc@neoting.test' })) });
  const outcome = await runEmailIntake(rawEmail({ envelopeRecipient: 'doc@neoting.test' }), deps);
  expect(outcome.status).toBe('unresolved-recipient');
  expect(queue.enqueued).toHaveLength(0);
});

test('a parse failure is this email’s problem, returned not thrown (the loop survives)', async () => {
  const { deps } = baseDeps({
    parser: stubParser(async () => {
      throw new Error('bad mime');
    }),
  });
  const outcome = await runEmailIntake(rawEmail(), deps);
  expect(outcome.status).toBe('parse-error');
});

test('a throwing email costs one email, not the batch — the rest still drain', async () => {
  // The poison-wedges-the-loop guard: if enqueue (Redis) or store.put (S3) throws
  // for one email, the batch must continue and the throwing one must be left in
  // the source (not acked, so a transient fault retries), never starving the rest.
  const source = new FixtureEmailSource();
  source.seed(rawEmail({ id: 'boom-1' }));
  source.seed(rawEmail({ id: 'ok-2' }));
  let calls = 0;
  const flakyQueue: IngestQueue = {
    async enqueue() {
      calls += 1;
      if (calls === 1) throw new Error('redis down');
    },
  };
  const { deps, warns } = baseDeps({ queue: flakyQueue });

  const summary = await drainEmailSource(source, deps);

  expect(summary.processed).toBe(1); // ok-2 got through
  expect(summary.failed).toBe(1); // boom-1 failed but did not abort the loop
  expect(source.acked).toEqual(['ok-2']); // the throwing email is left in the source
  expect(warns.some((w) => w.includes('boom-1') && w.includes('processing threw'))).toBe(true);
});

test('an ack failure after a successful handoff is contained, not fatal to the batch', async () => {
  const source: EmailSource = {
    async poll() {
      return [rawEmail({ id: 'ok-1' })];
    },
    async ack() {
      throw new Error('mailhog unreachable');
    },
    async quarantine() {
      /* not reached */
    },
  };
  const { deps, warns } = baseDeps();

  const summary = await drainEmailSource(source, deps);

  expect(summary.processed).toBe(1); // the work was done; ack failing does not undo it
  expect(warns.some((w) => w.includes('ok-1') && w.includes('ack failed'))).toBe(true);
});

test('an unparseable email drains as failed and is QUARANTINED — out of the window, never dropped', async () => {
  const source = new FixtureEmailSource();
  source.seed(rawEmail({ id: 'bad-mime' }));
  const { deps, warns } = baseDeps({
    parser: stubParser(async () => {
      throw new Error('malformed');
    }),
  });

  const first = await drainEmailSource(source, deps);
  expect(first.failed).toBe(1);
  expect(source.acked).toEqual([]); // not acked — quarantine is not deletion
  expect(source.quarantined).toEqual(['bad-mime']);
  expect(warns.filter((w) => w.includes('bad-mime'))).toHaveLength(1);

  // Second poll: it has LEFT the window, so nothing re-drains and nothing re-warns.
  const second = await drainEmailSource(source, deps);
  expect(second.failed).toBe(0);
  expect(warns.filter((w) => w.includes('bad-mime'))).toHaveLength(1);
});

test('drain acks processed emails and quarantines an unresolvable one', async () => {
  const source = new FixtureEmailSource();
  source.seed(rawEmail({ id: 'ok-1', envelopeRecipient: 'doc+prac_x@neoting.test' }));
  source.seed(rawEmail({ id: 'bad-1', envelopeRecipient: 'doc@neoting.test' }));
  const { deps, warns } = baseDeps();

  const first = await drainEmailSource(source, deps);
  expect(first.processed).toBe(1);
  expect(first.unresolved).toBe(1);
  expect(source.acked).toEqual(['ok-1']);
  expect(source.quarantined).toEqual(['bad-1']); // out of the window, not dropped
  expect(warns.filter((w) => w.includes('bad-1'))).toHaveLength(1);

  const second = await drainEmailSource(source, deps);
  expect(second.unresolved).toBe(0); // gone from the window; nothing re-warns
  expect(warns.filter((w) => w.includes('bad-1'))).toHaveLength(1);
});

test('REGRESSION: stuck unresolvable mail cannot starve the poll window', async () => {
  // "Left in the source, warned once" wedged the whole channel: the S3 source
  // lists a bounded window, plain mail to doc@ (no plus tag) is unresolvable BY
  // DESIGN, and a stuck email never left the window — so once it filled, new
  // mail was never listed again while the drain reported clean. Quarantine
  // frees the slot; this drives a window-of-one source to prove it.
  const window = 1;
  const pending: InboundRawEmail[] = [
    rawEmail({ id: 'stuck-1', envelopeRecipient: 'doc@neoting.test' }), // unresolvable, sorts first
    rawEmail({ id: 'stuck-2', envelopeRecipient: 'doc@neoting.test' }),
    rawEmail({ id: 'new-mail', envelopeRecipient: 'doc+prac_x@neoting.test' }),
  ];
  const quarantined: string[] = [];
  const acked: string[] = [];
  const source: EmailSource = {
    async poll() {
      return pending.slice(0, window); // the bounded window, like MaxKeys
    },
    async ack(id) {
      acked.push(id);
      const i = pending.findIndex((e) => e.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    async quarantine(id) {
      quarantined.push(id);
      const i = pending.findIndex((e) => e.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const { deps } = baseDeps();

  await drainEmailSource(source, deps);
  await drainEmailSource(source, deps);
  await drainEmailSource(source, deps);

  expect(quarantined).toEqual(['stuck-1', 'stuck-2']);
  expect(acked).toEqual(['new-mail']); // the mail behind the stuck ones still arrives
});

test('a quarantine failure leaves the email in the source and warns every drain, not once', async () => {
  const pending = [rawEmail({ id: 'bad-1', envelopeRecipient: 'doc@neoting.test' })];
  const source: EmailSource = {
    async poll() {
      return [...pending];
    },
    async ack() {
      /* not reached */
    },
    async quarantine() {
      throw new Error('s3 blip');
    },
  };
  const { deps, warns } = baseDeps();

  await drainEmailSource(source, deps);
  await drainEmailSource(source, deps);

  // Still in the source (the next drain retried), and the failure is loud each
  // time — a quarantine that cannot complete is a window slot that stays taken.
  expect(warns.filter((w) => w.includes('quarantine failed'))).toHaveLength(2);
});

test('every rejected attachment is logged with its filename, code and reason before the ack deletes the email', async () => {
  // The count alone survived the production path; the per-attachment reason —
  // what a human needs to tell a client what to re-send — was discarded, and
  // the source email deleted right after. Pinned here.
  const source = new FixtureEmailSource();
  source.seed(rawEmail({ id: 'ok-1', envelopeRecipient: 'doc+prac_x@neoting.test' }));
  const { deps, warns } = baseDeps({
    parser: stubParser(
      parsedEmail({
        attachments: [
          { filename: 'r.png', contentType: 'image/png', bytes: PNG },
          { filename: 'evil.exe', contentType: 'application/octet-stream', bytes: Buffer.from('MZ-not-accepted') },
        ],
      }),
    ),
  });

  const summary = await drainEmailSource(source, deps);
  expect(summary.processed).toBe(1);
  expect(source.acked).toEqual(['ok-1']);
  expect(warns.some((w) => w.includes('evil.exe') && w.includes('NT-ING-'))).toBe(true);
});
