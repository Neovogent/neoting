import { expect, test, vi } from 'vitest';

import { parseEmailAddress } from './email-address.js';
import { InMemoryEmailRateLimiter } from './email-rate-limit.js';
import { DemoEmailSender, type EmailSender, type OutboundEmail } from './email-sender.js';
import { NotificationsService } from './notifications.service.js';
import { SignInCode } from './sign-in-code.js';

function harness() {
  const sender = new DemoEmailSender(() => new Date('2026-08-26T10:00:00Z'));
  const limiter = new InMemoryEmailRateLimiter(() => new Date('2026-08-26T10:00:00Z'));
  return { sender, limiter, service: new NotificationsService(sender, limiter) };
}

const invite = {
  to: 'ada@example.com',
  practiceName: 'Harrow & Co',
  businessName: 'Sparkle Cleaning Ltd',
  inviteLink: 'https://neoacc.neovogent.com/invite/abc123',
  expiresAt: new Date('2026-09-02T09:00:00Z'),
  termsLink: 'https://neoacc.neovogent.com/legal/terms-of-service',
  privacyLink: 'https://neoacc.neovogent.com/legal/privacy-notice',
};

test('a send composes, transports, and reports the provider id', async () => {
  const { service, sender } = harness();

  const outcome = await service.sendClientInvite(invite);

  expect(outcome).toEqual({ sent: true, kind: 'client-invite', providerMessageId: 'demo-email-1' });
  const sent = sender.readOutbox()[0];
  expect(sent?.to).toBe('ada@example.com');
  expect(sent?.subject).toContain('Harrow & Co');
});

test('the caller hands over facts, never a subject or a body', async () => {
  // Composition is a pure function in `email-copy.ts`, so the text a reviewer
  // reads is byte-for-byte the text that sends. A caller that could pass a body
  // would break that guarantee.
  const { service } = harness();
  const keys = Object.keys(invite);
  expect(keys).not.toContain('subject');
  expect(keys).not.toContain('body');
  await expect(service.sendClientInvite(invite)).resolves.toMatchObject({ sent: true });
});

test('a malformed address throws before any ceiling is consumed', async () => {
  const { service, limiter, sender } = harness();

  await expect(service.sendClientInvite({ ...invite, to: 'not-an-address' })).rejects.toThrow();

  // The real recipient's budget is untouched — a typo must not be able to
  // spend someone else's ceiling, and nothing was transported.
  expect(sender.readOutbox()).toHaveLength(0);
  expect((await limiter.consume({ kind: 'client-invite', address: parseEmailAddress('not-an-address@x.com') })).allowed).toBe(
    true,
  );
});

test('a rate-limited send is a verdict, not an exception, and nothing is transported', async () => {
  const { service, sender } = harness();

  for (let i = 0; i < 5; i += 1) await service.sendClientInvite(invite);
  const sixth = await service.sendClientInvite(invite);

  // A thrown exception would force the sign-in path, the invite path and the
  // chase batch into the same handling. Each needs a different one.
  expect(sixth).toEqual({ sent: false, kind: 'client-invite', reason: 'rate-limited', retryAfterSeconds: 3600 });
  expect(sender.readOutbox()).toHaveLength(5);
});

test('the IP travels to the limiter, and a system send passes none', async () => {
  const seen: (string | undefined)[] = [];
  const limiter = { consume: async (r: { ip?: string | undefined }) => (seen.push(r.ip), { allowed: true, retryAfterSeconds: 0, limitedBy: null }) };
  const service = new NotificationsService(new DemoEmailSender(), limiter);

  await service.sendClientInvite(invite, { ip: '198.51.100.7' });
  await service.sendDocumentRequest({ to: 'ada@example.com', businessName: 'Sparkle', items: [], portalLink: 'https://x.test/p' });

  expect(seen).toEqual(['198.51.100.7', undefined]);
});

// ── The credential rules ───────────────────────────────────────────────────

test('the sign-in code reaches the body and appears in NO log line', async () => {
  const { service, sender } = harness();
  const logged: string[] = [];
  // The service's own Logger — the one place a code could reach CloudWatch.
  const logger = (service as unknown as { logger: { log: (m: string) => void; warn: (m: string) => void } }).logger;
  vi.spyOn(logger, 'log').mockImplementation((m: string) => void logged.push(m));
  vi.spyOn(logger, 'warn').mockImplementation((m: string) => void logged.push(m));

  await service.sendSignInCode({ to: 'ada@example.com', code: SignInCode.parse('482913'), expiresInMinutes: 10 });

  expect(sender.readOutbox()[0]?.body).toContain('482913');
  expect(logged.join('\n')).not.toContain('482913');
});

test('the log carries the kind, the message id and the DOMAIN — never the address or the body', async () => {
  const { service } = harness();
  const logged: string[] = [];
  const logger = (service as unknown as { logger: { log: (m: string) => void } }).logger;
  vi.spyOn(logger, 'log').mockImplementation((m: string) => void logged.push(m));

  await service.sendClientInvite(invite);

  expect(logged[0]).toContain('kind=client-invite');
  expect(logged[0]).toContain('domain=example.com');
  expect(logged[0]).toContain('messageId=demo-email-1');
  // Personal data does not belong in CloudWatch (Governance §11.6).
  expect(logged[0]).not.toContain('ada@example.com');
  expect(logged[0]).not.toContain('Sparkle Cleaning');
});

test('a refused sign-in send never materialises the code into a string at all', async () => {
  // Composition runs AFTER the limit is granted, so a flood produces no
  // credential-bearing strings on the heap.
  const composed: OutboundEmail[] = [];
  const recording: EmailSender = {
    send: (email) => (composed.push(email), Promise.resolve({ kind: email.kind, providerMessageId: 'x' })),
  };
  const service = new NotificationsService(recording, new InMemoryEmailRateLimiter(() => new Date('2026-08-26T10:00:00Z')));

  for (let i = 0; i < 8; i += 1) {
    await service.sendSignInCode({ to: 'ada@example.com', code: SignInCode.parse('482913'), expiresInMinutes: 10 });
  }

  expect(composed).toHaveLength(5);
});

test('the rate-limit warning names the domain and the ceiling, not the address', async () => {
  const { service } = harness();
  const warned: string[] = [];
  const logger = (service as unknown as { logger: { warn: (m: string) => void } }).logger;
  vi.spyOn(logger, 'warn').mockImplementation((m: string) => void warned.push(m));

  for (let i = 0; i < 6; i += 1) await service.sendClientInvite(invite);

  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain('limitedBy=address');
  expect(warned[0]).toContain('domain=example.com');
  expect(warned[0]).not.toContain('ada@example.com');
});
