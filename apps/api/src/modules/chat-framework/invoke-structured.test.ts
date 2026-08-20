import { Logger } from '@nestjs/common';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { invokeStructured } from './invoke-structured.js';
import { CircuitBreaker } from './provider/circuit-breaker.js';
import {
  ModelAccessError,
  type ModelProvider,
  ModelOutputInvalidError,
  type ModelResponse,
  ModelUnavailableError,
} from './provider/model-provider.js';

const Schema = z.object({ ok: z.boolean() }).strict();

const USAGE = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheCreationInputTokens: 0 };

function providerReturning(...outputs: unknown[]): ModelProvider & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  let index = 0;
  return {
    name: 'demo',
    calls,
    invoke: (request) => {
      calls.push([...request.messages]);
      const output = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      if (output instanceof Error) return Promise.reject(output);
      return Promise.resolve({ output, usage: USAGE, modelId: 'test-model' } satisfies ModelResponse);
    },
  };
}

const INPUT = {
  task: 'chatWorkspace' as const,
  schema: Schema,
  system: 'system',
  messages: [{ role: 'user' as const, content: 'hello' }],
  toolName: 'respond',
  toolSchema: {},
  traceId: 't',
  practiceId: 'prac_1',
  businessId: null,
};

describe('structured invocation (Governance §9.2)', () => {
  test('a valid first answer is returned without a retry', async () => {
    const provider = providerReturning({ ok: true });
    const result = await invokeStructured(provider, new CircuitBreaker(), INPUT);

    expect(result.value).toEqual({ ok: true });
    expect(provider.calls).toHaveLength(1);
  });

  test('a schema mismatch retries ONCE, with the validation error appended', async () => {
    const provider = providerReturning({ nope: 1 }, { ok: true });
    const result = await invokeStructured(provider, new CircuitBreaker(), INPUT);

    expect(result.value).toEqual({ ok: true });
    expect(provider.calls).toHaveLength(2);

    // The retry must be a CORRECTION, not a repetition: the model's own answer
    // and the specific validation failure both have to be in front of it, or
    // asking again is just spending twice for the same mistake.
    const retryMessages = provider.calls[1] as { role: string; content: string }[];
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[1]?.role).toBe('assistant');
    expect(retryMessages[2]?.content).toContain('failed validation');
  });

  test('a second schema failure raises — never a best-effort parse (§9.2)', async () => {
    const provider = providerReturning({ nope: 1 }, { still: 'wrong' });

    await expect(invokeStructured(provider, new CircuitBreaker(), INPUT)).rejects.toBeInstanceOf(
      ModelOutputInvalidError,
    );
    expect(provider.calls).toHaveLength(2);
  });

  test('strict mode rejects an unexpected key rather than dropping it', async () => {
    const provider = providerReturning({ ok: true, extra: 'smuggled' }, { ok: true, extra: 'smuggled' });

    await expect(invokeStructured(provider, new CircuitBreaker(), INPUT)).rejects.toBeInstanceOf(
      ModelOutputInvalidError,
    );
  });
});

describe('availability and the degrade ladder (Governance §9.3)', () => {
  test('chat exhausts immediately — it has no eval-passing tier to fall to', async () => {
    const provider = providerReturning(new ModelUnavailableError('bedrock down'));
    const breaker = new CircuitBreaker(() => 0);

    await expect(invokeStructured(provider, breaker, INPUT)).rejects.toBeInstanceOf(ModelUnavailableError);
    // One attempt, on the judgment tier, and then the honest error. Silently
    // answering from an unmeasured tier is the thing §9.3 forbids.
    expect(provider.calls).toHaveLength(1);
  });

  test('an open breaker short-circuits without calling the provider at all', async () => {
    const breaker = new CircuitBreaker(() => 0);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    const provider = providerReturning({ ok: true });
    await expect(invokeStructured(provider, breaker, INPUT)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(provider.calls).toHaveLength(0);
  });

  test('a schema failure does NOT trip the breaker — it is our bug, not theirs', async () => {
    const breaker = new CircuitBreaker(() => 0);
    const provider = providerReturning({ nope: 1 }, { nope: 2 });

    await expect(invokeStructured(provider, breaker, INPUT)).rejects.toBeInstanceOf(ModelOutputInvalidError);
    // Counting this as a provider failure would open the breaker against a
    // provider that answered perfectly well, taking chat down for 60 s over a
    // prompt problem.
    expect(breaker.allows()).toBe(true);
  });

  test('a model-access refusal raises once and never touches the breaker', async () => {
    // Measured against real Bedrock on 21 Aug 2026: the models list fine and
    // every invocation 404s with "Model use case details have not been
    // submitted for this account". Retrying that spends money to be refused
    // again, and opening the breaker would blame an outage for a console
    // checkbox.
    const breaker = new CircuitBreaker(() => 0);
    const provider = providerReturning(new ModelAccessError('refused', 'use case details not submitted'));

    await expect(invokeStructured(provider, breaker, INPUT)).rejects.toBeInstanceOf(ModelAccessError);
    expect(provider.calls).toHaveLength(1);
    expect(breaker.allows()).toBe(true);
  });

  test('a 400-class error is not retried onto another tier', async () => {
    const bug = new Error('malformed request — our bug');
    const provider = providerReturning(bug);

    await expect(invokeStructured(provider, new CircuitBreaker(), INPUT)).rejects.toBe(bug);
    expect(provider.calls).toHaveLength(1);
  });

  test('token usage accumulates across the retry, so the retry is billed', async () => {
    const provider = providerReturning({ nope: 1 }, { ok: true });
    const result = await invokeStructured(provider, new CircuitBreaker(), INPUT);

    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
    expect(result.costPence).toBeGreaterThan(0);
  });
});

describe('telemetry (Governance §9.7)', () => {
  test('every call logs one ai.call line carrying cost, tokens and outcome', async () => {
    // Spied on the Nest logger rather than on `console.log`: Nest writes to
    // stdout through its own transport, so a console spy sees nothing and the
    // assertion passes or fails for the wrong reason.
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });

    try {
      await invokeStructured(providerReturning({ ok: true }), new CircuitBreaker(), INPUT);
    } finally {
      spy.mockRestore();
    }

    const call = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === 'ai.call');
    expect(call).toBeDefined();
    // The fields a cost dashboard and a metric filter key off (§9.7). Renaming
    // one is a dashboard change, and this is what makes that visible.
    expect(call).toMatchObject({
      traceId: 't',
      practiceId: 'prac_1',
      task: 'chatWorkspace',
      tier: 'judgment',
      outcome: 'ok',
      cacheHit: false,
    });
    expect(typeof call?.costPence).toBe('number');
    expect(typeof call?.latencyMs).toBe('number');
  });

  test('the log line carries no prompt text and no reply text', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });

    try {
      await invokeStructured(providerReturning({ ok: true }), new CircuitBreaker(), {
        ...INPUT,
        messages: [{ role: 'user', content: 'a client secret nobody should find in CloudWatch' }],
      });
    } finally {
      spy.mockRestore();
    }

    // Customer data in a log line lands in CloudWatch, where the retention
    // policy, the access grants and the DPIA all say something different from
    // what `documents` says.
    expect(lines.join(' ')).not.toContain('a client secret');
  });
});
