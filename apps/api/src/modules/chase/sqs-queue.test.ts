import { expect, test } from 'vitest';

import { regionOf, signV4 } from './sqs-queue.js';

test('signV4 matches the AWS SDK signer byte for byte', () => {
  // Expected value computed with @smithy/signature-v4 (applyChecksum: false)
  // over the identical request — the hand-written signer must agree with it.
  const headers = signV4({
    method: 'POST',
    host: 'sqs.eu-west-2.amazonaws.com',
    path: '/',
    region: 'eu-west-2',
    service: 'sqs',
    headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ReceiveMessage' },
    body: '{"QueueUrl":"https://sqs.eu-west-2.amazonaws.com/123456789012/q","MaxNumberOfMessages":10,"WaitTimeSeconds":20}',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      sessionToken: 'TOKEN123',
    },
    now: new Date('2026-10-15T12:34:56.000Z'),
  });
  expect(headers.authorization).toBe(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261015/eu-west-2/sqs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=457dff3487228bdc75ef8e48affefe2e2073306fe0069ced627b27735d44f2d0',
  );
  expect(regionOf('https://sqs.eu-west-2.amazonaws.com/123456789012/q')).toBe('eu-west-2');
});
