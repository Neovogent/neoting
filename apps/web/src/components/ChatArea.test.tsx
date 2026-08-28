import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { Message } from '../lib/types';

/**
 * Does the typing indicator actually reach the screen?
 *
 * `AssistantActivity.test.tsx` proves the component renders in isolation. That
 * is not the thing that breaks. What breaks is the wiring: `InputRow` sets the
 * pending flag, the provider carries it, and `ChatArea` — a different component
 * entirely — has to read it. The first version of this feature had `isLoading`
 * local to `InputRow`, so the transcript never learned a reply was coming and
 * sat blank for three seconds. That bug was invisible to a component test and
 * would be invisible to this one too if it stubbed anything less than the
 * context boundary.
 *
 * So this mounts the real `ChatArea` and lies only about the context.
 */

const mockContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../context/AppContext', () => ({
  useAppContext: () => mockContext.value,
}));

// IntentRenderer reaches deep into app state for the live cards; this suite is
// about the transcript's own rendering, so it is stubbed to nothing.
vi.mock('./DynamicComponents/IntentRenderer', () => ({
  IntentRenderer: () => null,
}));

beforeAll(() => {
  if (window.matchMedia === undefined) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }
  // jsdom has no layout, so scrollIntoView is absent on the bottom sentinel.
  if (Element.prototype.scrollIntoView === undefined) {
    Element.prototype.scrollIntoView = () => undefined;
  }
});

async function renderChat(value: Record<string, unknown>) {
  mockContext.value = value;
  const { ChatArea } = await import('./ChatArea');
  return render(
    <IntlProvider locale="en-GB">
      <ChatArea />
    </IntlProvider>,
  );
}

const USER_TURN: Message = { id: '1', role: 'user', content: 'chase them' };

describe('the transcript while a reply is in flight', () => {
  test('shows the typing indicator when the context says one is pending', async () => {
    await renderChat({
      messages: [USER_TURN],
      assistantPending: { businessName: 'American Burger Ltd' },
    });

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText("Reading American Burger Ltd's records…")).toBeTruthy();
  });

  test('shows nothing extra when nothing is pending', async () => {
    await renderChat({ messages: [USER_TURN], assistantPending: null });

    expect(screen.queryByRole('status')).toBeNull();
  });

  test('the indicator sits AFTER the last message, not before it', async () => {
    // It is the next turn, so it belongs at the bottom. Rendered above the
    // transcript it would read as something that already happened.
    const { container } = await renderChat({
      messages: [USER_TURN],
      assistantPending: { businessName: null },
    });

    const text = container.textContent ?? '';
    expect(text.indexOf('chase them')).toBeLessThan(text.indexOf('Working on it…'));
  });
});

describe('the meta line on a landed reply', () => {
  test('a healthy server-answered turn carries no model id or latency', async () => {
    // Removed 28 Aug 2026 (see AssistantMetaLine): the transcript shows no
    // model identifier; telemetry is where a turn's model and latency live.
    const { container } = await renderChat({
      messages: [
        USER_TURN,
        {
          id: '2',
          role: 'assistant',
          content: 'Drafted.',
          meta: {
            model: 'anthropic.claude-opus-4-6-v1',
            tier: 'judgment',
            latencyMs: 3188,
            degraded: false,
            budgetWarning: false,
          },
        } satisfies Message,
      ],
      assistantPending: null,
    });

    expect(container.textContent).not.toContain('claude');
    expect(container.textContent).not.toContain('3.2s');
  });

  test('a degraded turn still wears its warning — that stays (§9.3)', async () => {
    await renderChat({
      messages: [
        USER_TURN,
        {
          id: '2',
          role: 'assistant',
          content: 'Drafted.',
          meta: {
            model: 'anthropic.claude-opus-4-6-v1',
            tier: 'workhorse',
            latencyMs: 3188,
            degraded: true,
            budgetWarning: false,
          },
        } satisfies Message,
      ],
      assistantPending: null,
    });

    expect(screen.getByText('Answered by a fallback model')).toBeTruthy();
  });

  test('a synthetic reply stays unlabelled rather than borrowing a model’s authority', async () => {
    const { container } = await renderChat({
      messages: [USER_TURN, { id: '2', role: 'assistant', content: 'Here is what I can do.' } satisfies Message],
      assistantPending: null,
    });

    expect(container.textContent).not.toContain('claude');
  });
});
