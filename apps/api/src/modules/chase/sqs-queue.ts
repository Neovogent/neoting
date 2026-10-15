import { createHash, createHmac } from 'node:crypto';

import { PinpointSMSVoiceV2Client } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { z } from 'zod';

/**
 * A minimal SQS client (ReceiveMessage + DeleteMessageBatch) over the AWS JSON
 * protocol, signed with SigV4 by hand.
 *
 * Why not `@aws-sdk/client-sqs`: it is not a dependency, and adding one is a
 * stop-and-ask. Credentials still come from the SDK's own default provider
 * chain (ECS task role, env, profile) via an already-installed client, so no
 * secret handling is re-invented here — only the request signature.
 * ponytail: two operations; swap for `@aws-sdk/client-sqs` if a third is needed.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

export interface SignInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** SigV4 headers (`authorization`, `x-amz-date`, token) for one request with no query string. */
export function signV4(input: SignInput): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.host,
    'x-amz-date': amzDate,
    ...(input.credentials.sessionToken === undefined ? {} : { 'x-amz-security-token': input.credentials.sessionToken }),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonical = [
    input.method,
    input.path,
    '',
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    sha256(input.body),
  ].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const ReceiveResponse = z
  .object({
    Messages: z
      .array(z.object({ MessageId: z.string(), ReceiptHandle: z.string(), Body: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

export interface QueueMessage {
  readonly receiptHandle: string;
  readonly body: string;
}

export class SqsQueue {
  private readonly region: string;
  private readonly host: string;

  constructor(
    private readonly queueUrl: string,
    private readonly credentials: () => Promise<AwsCredentials> = defaultCredentials(regionOf(queueUrl)),
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.region = regionOf(queueUrl);
    this.host = `sqs.${this.region}.amazonaws.com`;
  }

  /** Long-polls for up to ten messages. */
  async receive(waitSeconds = 20): Promise<QueueMessage[]> {
    const body = await this.call('ReceiveMessage', {
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
    });
    return (ReceiveResponse.parse(body).Messages ?? []).map((m) => ({ receiptHandle: m.ReceiptHandle, body: m.Body }));
  }

  async deleteBatch(receiptHandles: readonly string[]): Promise<void> {
    if (receiptHandles.length === 0) return;
    await this.call('DeleteMessageBatch', {
      QueueUrl: this.queueUrl,
      Entries: receiptHandles.map((handle, i) => ({ Id: String(i), ReceiptHandle: handle })),
    });
  }

  private async call(action: string, payload: unknown): Promise<unknown> {
    const body = JSON.stringify(payload);
    const headers = signV4({
      method: 'POST',
      host: this.host,
      path: '/',
      region: this.region,
      service: 'sqs',
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${action}` },
      body,
      credentials: await this.credentials(),
      now: new Date(),
    });
    const { host: _host, ...sendable } = headers;
    const response = await this.fetchImpl(`https://${this.host}/`, { method: 'POST', headers: sendable, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`SQS ${action} answered HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  }
}

/** `https://sqs.eu-west-2.amazonaws.com/123456789012/name` → `eu-west-2`. */
export function regionOf(queueUrl: string): string {
  const match = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\//.exec(queueUrl);
  if (match?.[1] === undefined) throw new Error(`not an SQS queue URL: ${queueUrl}`);
  return match[1];
}

function defaultCredentials(region: string): () => Promise<AwsCredentials> {
  // The SDK's default provider chain, borrowed from a client already installed.
  const client = new PinpointSMSVoiceV2Client({ region });
  return async () => {
    const c = await client.config.credentials();
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };
  };
}
