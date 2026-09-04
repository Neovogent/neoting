import { describe, expect, test } from 'vitest';
import { fingerprintOf, fromStoredMessages, toStoredMessages } from './chatConversations';
import type { Conversation, Message } from '../lib/types';

/**
 * The transcript's two boundary crossings and the save fingerprint (review
 * item 9, 5 Sep 2026). What these pin, in order of cost-to-lose:
 *
 * 1. **Payloads never travel.** A stored message is text + intent name; a
 *    draft, a proposal id or a display block in the saved bytes would re-offer
 *    an action whose proposal already lives in the Approvals queue.
 * 2. **The contract's caps are applied by the CALLER** — 200 messages trimmed
 *    from the front, 4000 chars of content — because the server refuses, it
 *    does not trim, and a refusal would lose the save.
 * 3. **The fingerprint ignores what the save ignores.** A payload arriving on
 *    a message must not re-PUT a conversation whose stored bytes are
 *    unchanged; a pin, a rename or a new message must.
 */

const AT = '2026-09-05T09:00:00.000Z';

function msg(over: Partial<Message> = {}): Message {
  return { id: 'm1', role: 'user', content: 'chase them', ...over };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Chasing',
    messages: [msg()],
    attachedClientIds: [],
    pinned: false,
    updatedAt: 0,
    ...over,
  };
}

describe('toStoredMessages', () => {
  test('carries role, content and intent — and nothing else', () => {
    const stored = toStoredMessages(
      [
        msg(),
        msg({
          id: 'm2',
          role: 'assistant',
          content: 'Drafted.',
          intent: 'LIVE_CHASE',
          payload: { businessId: 'biz_1' },
          meta: { modelVersion: 'x', promptVersion: 'y' } as unknown as Message['meta'],
        }),
      ],
      AT,
    );

    expect(stored).toEqual([
      { role: 'user', content: 'chase them', at: AT },
      { role: 'assistant', content: 'Drafted.', intent: 'LIVE_CHASE', at: AT },
    ]);
    // The payload must not survive in ANY form — not under another key either.
    expect(JSON.stringify(stored)).not.toContain('biz_1');
    expect(JSON.stringify(stored)).not.toContain('modelVersion');
  });

  test('trims to the contract caps: 200 messages from the FRONT, 4000 chars of content', () => {
    const many = Array.from({ length: 250 }, (_, i) => msg({ id: `m${i}`, content: `line ${i}` }));
    const stored = toStoredMessages(many, AT);
    expect(stored).toHaveLength(200);
    expect(stored[0]?.content).toBe('line 50'); // the oldest 50 fell off
    expect(stored[199]?.content).toBe('line 249');

    const long = toStoredMessages([msg({ content: 'x'.repeat(5000) })], AT);
    expect(long[0]?.content).toHaveLength(4000);
  });

  test('an absent intent is an ABSENT key, not an explicit undefined', () => {
    const stored = toStoredMessages([msg()], AT);
    expect(Object.keys(stored[0] ?? {})).not.toContain('intent');
  });
});

describe('fromStoredMessages', () => {
  test('restores text and intent with stable per-conversation ids', () => {
    const restored = fromStoredMessages('c1', [
      { role: 'user', content: 'chase them' },
      { role: 'assistant', content: 'Drafted.', intent: 'LIVE_CHASE' },
    ]);
    expect(restored).toHaveLength(2);
    expect(restored[0]?.id).toBe('c1-restored-0');
    expect(restored[1]).toMatchObject({ role: 'assistant', content: 'Drafted.', intent: 'LIVE_CHASE' });
    // No payload is invented for a restored card — the transcript is text.
    expect(restored[1]?.payload).toBeUndefined();
  });
});

describe('fingerprintOf', () => {
  test('changes on a new message, a pin, a rename or a scope change', () => {
    const base = fingerprintOf(conversation());
    expect(fingerprintOf(conversation({ messages: [msg(), msg({ id: 'm2', content: 'more' })] }))).not.toBe(base);
    expect(fingerprintOf(conversation({ pinned: true }))).not.toBe(base);
    expect(fingerprintOf(conversation({ title: 'Renamed' }))).not.toBe(base);
    expect(fingerprintOf(conversation({ attachedClientIds: ['biz_1'] }))).not.toBe(base);
  });

  test('is INDIFFERENT to what the save does not carry — payloads, meta, timestamps', () => {
    const base = fingerprintOf(conversation());
    const noisy = conversation({
      updatedAt: 999,
      remoteMessageCount: 5,
      messages: [msg({ payload: { businessId: 'biz_1' }, display: [] })],
    });
    expect(fingerprintOf(noisy)).toBe(base);
  });
});
