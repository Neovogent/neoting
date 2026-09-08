import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { IntentRenderer } from './IntentRenderer';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { Message } from '../../lib/types';

/**
 * Review item 65.3 — the bug check: an empty-set approvals answer must render
 * a SENTENCE, never a blank card. The reviewer clicked "Which items are
 * waiting on approval?" for a client with zero pending approvals and read the
 * nothing that came back as the AI failing.
 */

const setActiveTab = vi.fn();

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({
    documents: [],
    duplicates: [],
    matches: [],
    clients: [],
    approvals: [],
    addMessage: vi.fn(),
    setActiveTab,
  }),
}));

test('SHOW_APPROVALS with an empty queue renders the empty sentence and the way to the real queue — never a blank card', async () => {
  const message: Message = {
    id: 'm1',
    role: 'assistant',
    content: 'Here you go:',
    intent: 'SHOW_APPROVALS',
    payload: { clientIds: [], clientNames: ['Zeplow Inc.'] },
  };
  render(
    <AppIntlProvider>
      <IntentRenderer message={message} />
    </AppIntlProvider>,
  );

  // The empty set is a sentence, not silence. (getAll: DataTable renders both
  // its table and card branches in the DOM — container queries hide one.)
  //
  // ⚠ `findAll`, not `getAll`: the chat's cards are LAZY since 8 Sep 2026 —
  // the route was 56 kB over budget because this renderer imported all of them
  // statically — so the chunk has to resolve before anything is on the page.
  // Still offline; the only thing waited on is a dynamic `import()`.
  expect((await screen.findAllByText('The approval queue is empty.')).length).toBeGreaterThan(0);
  // And the card always carries the way to the REAL queue, which reads
  // GET /action-proposals itself.
  fireEvent.click(screen.getByRole('button', { name: /Open the Approvals queue/ }));
  expect(setActiveTab).toHaveBeenCalledWith('Approvals');
});
