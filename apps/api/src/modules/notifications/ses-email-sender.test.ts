import { expect, test } from 'vitest';

import { parseEmailAddress } from './email-address.js';
import type { OutboundEmail } from './email-sender.js';
import { SesEmailSender, type SesSendClient } from './ses-email-sender.js';

const config = {
  region: 'eu-west-2',
  fromAddress: 'no-reply@neoting.neovogent.com',
  replyToAddress: 'support@neovogent.com',
  configurationSetName: 'nt-staging-default',
};

const email: OutboundEmail = {
  kind: 'sign-in-code',
  to: parseEmailAddress('ada@example.com'),
  subject: 'Your Neo Accounting sign-in code',
  body: 'Your sign-in code is 482913\n',
};

/** Captures the command SES would receive, so nothing here needs AWS credentials. */
function harness(response: { MessageId?: string } = { MessageId: '0100019' }) {
  const commands: Record<string, unknown>[] = [];
  const client: SesSendClient = {
    send: ((command: { input: Record<string, unknown> }) => {
      commands.push(command.input);
      return Promise.resolve(response);
    }) as SesSendClient['send'],
  };
  return { client, commands };
}

test('the envelope is From no-reply, Reply-To support, and names the configuration set', async () => {
  const { client, commands } = harness();

  const sent = await new SesEmailSender(config, client).send(email);

  expect(sent).toEqual({ kind: 'sign-in-code', providerMessageId: '0100019' });
  expect(commands[0]).toMatchObject({
    // ⚠ NOT doc@ — that is the inbound intake address, and a reply to it would
    // be ingested as a client document (email.tf, the doc-to-s3 receipt rule).
    FromEmailAddress: 'no-reply@neoting.neovogent.com',
    Destination: { ToAddresses: ['ada@example.com'] },
    ReplyToAddresses: ['support@neovogent.com'],
    // Without this the send silently opts out of bounce suppression and
    // reputation metrics.
    ConfigurationSetName: 'nt-staging-default',
  });
});

test('the body is sent as text and ONLY as text', async () => {
  const { client, commands } = harness();
  await new SesEmailSender(config, client).send(email);

  const content = commands[0]?.['Content'] as { Simple: { Body: Record<string, unknown>; Subject: { Data: string } } };
  expect(content.Simple.Body).toHaveProperty('Text');
  // An Html part is what makes a transactional message score as a campaign,
  // and a sign-in code in a spam folder is a client who cannot sign in at all.
  expect(content.Simple.Body).not.toHaveProperty('Html');
  expect(content.Simple.Subject.Data).toBe(email.subject);
});

test('the kind is tagged, so bounce rates are answerable per message type', async () => {
  const { client, commands } = harness();
  await new SesEmailSender(config, client).send(email);

  expect(commands[0]?.['EmailTags']).toEqual([{ Name: 'nt-kind', Value: 'sign-in-code' }]);
});

test('an empty reply-to or configuration set omits the field rather than sending a blank one', async () => {
  const { client, commands } = harness();
  await new SesEmailSender({ ...config, replyToAddress: '', configurationSetName: '' }, client).send(email);

  expect(commands[0]).not.toHaveProperty('ReplyToAddresses');
  expect(commands[0]).not.toHaveProperty('ConfigurationSetName');
});

test('a 200 with no MessageId throws rather than reporting an untraceable delivery', async () => {
  const { client } = harness({});
  // The send may well have succeeded — which is exactly why a blank id must not
  // be recorded as a successful delivery nobody can ever trace.
  await expect(new SesEmailSender(config, client).send(email)).rejects.toThrow(/no MessageId/);
});
