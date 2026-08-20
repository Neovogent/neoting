import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeAll, describe, expect, test } from 'vitest';
import { AssistantMetaLine, AssistantPending } from './AssistantActivity';
import type { AssistantMeta } from '../../lib/types';

/**
 * jsdom has no `matchMedia`. The reduced-motion hook reads it on mount, so
 * without this every test in this file throws before asserting anything.
 */
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
});

function renderWithIntl(node: React.ReactElement) {
  return render(<IntlProvider locale="en-GB">{node}</IntlProvider>);
}

const META: AssistantMeta = {
  model: 'anthropic.claude-opus-4-6-v1',
  tier: 'judgment',
  latencyMs: 3188,
  degraded: false,
  budgetWarning: false,
};

describe('the pending bubble', () => {
  test('names the client whose records are being read', () => {
    renderWithIntl(<AssistantPending businessName="American Burger Ltd" />);
    expect(screen.getByText("Reading American Burger Ltd's records…")).toBeTruthy();
  });

  test('says something honest when no client is attached', () => {
    // "Reading X's records" would be a lie with nothing in scope — the server
    // retrieves nothing at all in that case.
    renderWithIntl(<AssistantPending businessName={null} />);
    expect(screen.getByText('Working on it…')).toBeTruthy();
  });

  test('is announced to screen readers', () => {
    // The frontend ten require aria-live on chat updates. Without it the gap
    // this component exists to close stays wide open for anyone not watching.
    renderWithIntl(<AssistantPending businessName={null} />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  test('claims no reasoning it does not have', () => {
    // The runtime calls the model with thinking OFF, so there is no chain of
    // thought to show. Any wording implying otherwise would be animated
    // fiction presented as the model's reasoning.
    const { container } = renderWithIntl(<AssistantPending businessName="American Burger Ltd" />);
    const text = (container.textContent ?? '').toLowerCase();
    for (const forbidden of ['thinking', 'reasoning', 'analysing', 'analyzing', 'considering']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('the provenance line', () => {
  test('shows which model answered and how long it took', () => {
    renderWithIntl(<AssistantMetaLine meta={META} />);
    // Vendor prefix trimmed, model kept verbatim — never a prettified alias.
    expect(screen.getByText('claude-opus-4-6-v1 · 3.2s')).toBeTruthy();
  });

  test('a degrade to a lower tier is stated, not swallowed (§9.3)', () => {
    renderWithIntl(<AssistantMetaLine meta={{ ...META, degraded: true }} />);
    expect(screen.getByText('Answered by a fallback model')).toBeTruthy();
  });

  test('the budget warning surfaces before the hard stop (§9.7)', () => {
    renderWithIntl(<AssistantMetaLine meta={{ ...META, budgetWarning: true }} />);
    expect(screen.getByText("Most of today's AI allowance is used")).toBeTruthy();
  });

  test('a healthy turn shows neither warning', () => {
    const { container } = renderWithIntl(<AssistantMetaLine meta={META} />);
    expect(container.textContent).not.toContain('fallback');
    expect(container.textContent).not.toContain('allowance');
  });
});
