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
  };
  const { deps, warns } = baseDeps();

  const summary = await drainEmailSource(source, deps);

  expect(summary.processed).toBe(1); // the work was done; ack failing does not undo it
  expect(warns.some((w) => w.includes('ok-1') && w.includes('ack failed'))).toBe(true);
});

test('an unparseable email drains as failed, is left in the source, and warns once', async () => {
  const source = new FixtureEmailSource();
  source.seed(rawEmail({ id: 'bad-mime' }));
  const { deps, warns } = baseDeps({
    parser: stubParser(async () => {
      throw new Error('malformed');
    }),
  });
  const warned = new Set<string>();

  const first = await drainEmailSource(source, { ...deps, warned });
  expect(first.failed).toBe(1);
  expect(source.acked).toEqual([]); // never dropped
  expect(warns.filter((w) => w.includes('bad-mime'))).toHaveLength(1);

  const second = await drainEmailSource(source, { ...deps, warned });
  expect(second.failed).toBe(1);
  expect(warns.filter((w) => w.includes('bad-mime'))).toHaveLength(1); // still once
});

test('drain acks processed emails, leaves an unresolvable one in the source, and warns once', async () => {
  const source = new FixtureEmailSource();
  source.seed(rawEmail({ id: 'ok-1', envelopeRecipient: 'doc+prac_x@neoting.test' }));
  source.seed(rawEmail({ id: 'bad-1', envelopeRecipient: 'doc@neoting.test' }));
  const { deps, warns } = baseDeps();
  const warned = new Set<string>();

  const first = await drainEmailSource(source, { ...deps, warned });
  expect(first.processed).toBe(1);
  expect(first.unresolved).toBe(1);
  expect(source.acked).toEqual(['ok-1']); // the unresolvable one is NOT acked — never dropped
  expect(warns.filter((w) => w.includes('bad-1'))).toHaveLength(1);

  // Second poll: ok-1 is gone, bad-1 remains and must NOT re-warn (warned-once).
  const second = await drainEmailSource(source, { ...deps, warned });
  expect(second.unresolved).toBe(1);
  expect(warns.filter((w) => w.includes('bad-1'))).toHaveLength(1);
});
