import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { LiveChaseComposerCard } from './LiveChaseComposerCard';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { SliceStatus } from '../../api/slices';
import type { BankTransaction } from '../../lib/types';

/**
 * Review item 30 (5 Sep 2026): the composer offered EVERY transaction on the
 * statement pre-ticked — a matched-and-published line and the settlement
 * credits included. Two rules pinned here:
 *
 * - the candidate list is exactly the `isUnexplained` set — no matched, no
 *   SUGGESTED, no suppressed lines, ever;
 * - chasing is OPT-IN per line: nothing is pre-selected, and staging is
 *   disabled until the accountant picks the lines the message is about.
 */

vi.mock('../../api/config', () => ({
  API_ENABLED: true,
  API_MOCKED: false,
  API_BASE_URL: '',
  dataSourceLabel: () => 'live API' as const,
}));

// The staging flow is its own component with its own tests; here it only has
// to reflect the `disabled` contract the composer drives it with — plus, since
// item 31, expose what `buildRequest` would stage so the payload is testable.
vi.mock('./LiveProposalFlow', () => ({
  LiveProposalFlow: ({
    stageLabel,
    disabled,
    buildRequest,
  }: {
    stageLabel: string;
    disabled?: boolean;
    buildRequest: () => unknown;
  }) => (
    <button
      disabled={disabled === true}
      onClick={() => {
        (globalThis as Record<string, unknown>).__stagedRequest = buildRequest();
      }}
    >
      {stageLabel}
    </button>
  ),
}));

const row = (id: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  id,
  clientId: 'biz_zeplow',
  clientName: 'Zeplow Inc.',
  description: `LINE ${id}`,
  date: '06 Aug 2026',
  amount: 994.0,
  isCredit: false,
  accountId: 'acc_1',
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  ...over,
});

const API_SLICE: SliceStatus = { source: 'api', loading: false, error: null };

let ctx: {
  transactions: BankTransaction[];
  businesses: { id: string; name: string }[];
  clients: { id: string; name: string; mobile?: string }[];
  slices: { bankTransactions: SliceStatus };
};

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ctx,
}));

beforeEach(() => {
  ctx = {
    transactions: [
      row('unexplained'),
      row('confirmed', { matchState: 'CONFIRMED', matchedDocId: 'doc_1' }),
      row('suggested', { matchState: 'SUGGESTED' }),
      row('credit', { chaseSuppressed: true, isCredit: true, amount: -2841.55, description: 'WORLDPAY SETTLEMENT' }),
    ],
    businesses: [{ id: 'biz_zeplow', name: 'Zeplow Inc.' }],
    clients: [],
    slices: { bankTransactions: API_SLICE },
  };
});

function renderCard() {
  return render(
    <AppIntlProvider>
      <LiveChaseComposerCard businessId="biz_zeplow" businessName="Zeplow Inc." />
    </AppIntlProvider>,
  );
}

test('offers ONLY the isUnexplained lines — no matched, no suggested, no suppressed credits', () => {
  renderCard();

  expect(screen.getByText('LINE unexplained')).toBeTruthy();
  expect(screen.queryByText('LINE confirmed')).toBeNull();
  expect(screen.queryByText('LINE suggested')).toBeNull();
  expect(screen.queryByText('WORLDPAY SETTLEMENT')).toBeNull();
});

test('nothing is pre-ticked, staging is disabled, and a tick is what arms both', () => {
  renderCard();

  const checkbox = screen.getByRole('checkbox');
  expect(checkbox.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByText('Draft message')).toBeNull();
  expect((screen.getByRole('button', { name: 'Stage for review' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(checkbox);

  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Draft message')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Stage for review' }) as HTMLButtonElement).disabled).toBe(false);
});

test('the draft derives from the CURRENT checked set — unticking recomposes it (item 31)', () => {
  ctx.transactions = [row('a', { description: 'CURRYS 1234', date: '09 Aug 2026' }), row('b', { description: 'GOOGLE ADS', date: '05 Aug 2026' })];
  renderCard();

  const [first, second] = screen.getAllByRole('checkbox');
  fireEvent.click(first!);
  fireEvent.click(second!);
  expect(screen.getByText(/CURRYS 1234/, { selector: 'p' })).toBeTruthy();

  // Untick the first line: the draft must stop naming it immediately — the
  // reviewer's exact defect was a message still listing excluded lines.
  fireEvent.click(first!);
  const draft = screen.getByText(/we're missing/).textContent ?? '';
  expect(draft).toContain('GOOGLE ADS');
  expect(draft).not.toContain('CURRYS 1234');
});

test('more than three ticked lines summarise instead of reciting every descriptor (item 31)', () => {
  ctx.transactions = ['W', 'X', 'Y', 'Z'].map((s, i) =>
    row(`t${i}`, { description: `SUPPLIER ${s}`, date: `${String(i + 3).padStart(2, '0')} Aug 2026` }),
  );
  renderCard();

  screen.getAllByRole('checkbox').forEach((c) => fireEvent.click(c));
  const draft = screen.getByText(/we're missing/).textContent ?? '';
  expect(draft).toContain('4 payments between 3 Aug and 6 Aug, including SUPPLIER W and SUPPLIER X');
  expect(draft).not.toContain('SUPPLIER Z');
});

test('the accountant can write the message; the words travel as accountantMessage and the frame stays (item 31)', () => {
  renderCard();
  fireEvent.click(screen.getByRole('checkbox'));

  fireEvent.change(screen.getByLabelText(/Write the message yourself/), {
    target: { value: '  Could you send the August receipts over?  ' },
  });

  // The preview weaves the custom words into the engine's frame. Selector
  // needed: jsdom exposes the controlled textarea's value as textContent too.
  const draft = screen.getByText(/Could you send/, { selector: 'p' }).textContent ?? '';
  expect(draft).toMatch(/^Zeplow Inc\. Accounts: Could you send the August receipts over\? Upload securely: /);

  // The staged payload carries the trimmed words for the engine to weave.
  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  const staged = (globalThis as Record<string, unknown>).__stagedRequest as {
    payload: { messages: { accountantMessage?: string; body: string }[] };
  };
  expect(staged.payload.messages[0]?.accountantMessage).toBe('Could you send the August receipts over?');
});

test('the recipient field starts EMPTY — never prefilled from a namesake record (item 31 / M8)', () => {
  ctx.clients = [{ id: '1', name: 'Zeplow Inc.', mobile: '+447700900001' }];
  renderCard();

  expect((screen.getByLabelText(/Recipient mobile/) as HTMLInputElement).value).toBe('');
});

test('a failed bank read says so instead of claiming there is nothing to chase', () => {
  ctx.transactions = [];
  ctx.slices = { bankTransactions: { source: 'error', loading: false, error: 'NT-SRV-001 — boom' } };
  renderCard();

  expect(screen.getByRole('alert').textContent).toMatch(/could not be read/);
  expect(screen.queryByText(/Nothing to chase/)).toBeNull();
});
