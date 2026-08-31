import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionProposal } from '@neoting/contracts/model';

import { LiveProposalCard } from './LiveProposalCard';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';

/**
 * How a `business.offboard` proposal reads on the Approvals queue — the
 * kind→copy mapping (`KIND_LABEL` / `KIND_NOTE` in api/proposals), not a
 * bespoke card. The copy has to be truthful before Read review is even
 * opened: the client's name, the queued reason, and that books are retained.
 */

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({ logAudit: vi.fn() }),
}));

afterEach(() => vi.clearAllMocks());

function proposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id: 'prop_off_1',
    businessId: 'biz_sparkle',
    kind: 'business.offboard',
    state: 'CREATED',
    payload: { businessId: 'biz_sparkle', reason: 'Client moved to another practice' },
    payloadHash: 'a'.repeat(64),
    createdByUserId: 'usr_1',
    createdAt: '2026-08-31T10:00:00.000Z',
    ...over,
  } as ActionProposal;
}

function renderCard(p: ActionProposal, clientName: string | null = 'Sparkle Cleaning Ltd') {
  return render(
    <AppIntlProvider>
      <LiveProposalCard proposal={p} clientName={clientName} />
    </AppIntlProvider>,
  );
}

test('a business.offboard proposal renders its label, the client, the reason and the retained-books note', () => {
  renderCard(proposal());

  expect(screen.getByRole('heading', { name: 'Remove a client' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Sparkle Cleaning Ltd');
  expect(text).toContain('Reason given: “Client moved to another practice”');
  // What approving does — and what it deliberately does not.
  expect(text).toContain('the client leaves the client list and every working surface');
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
});

test('a proposal with no reason renders the note alone, never an empty quotation', () => {
  renderCard(proposal({ payload: { businessId: 'biz_sparkle' } }));

  const text = document.body.textContent ?? '';
  expect(text).not.toContain('Reason given');
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
});

test('other kinds carry neither the offboard note nor a reason line', () => {
  renderCard(
    proposal({
      kind: 'chase.send',
      payload: { messages: [] },
    }),
    'Ananda Group',
  );

  const text = document.body.textContent ?? '';
  expect(screen.getByRole('heading', { name: 'Send chase email' })).toBeTruthy();
  expect(text).not.toContain('Reason given');
  expect(text).not.toContain('retained');
});
