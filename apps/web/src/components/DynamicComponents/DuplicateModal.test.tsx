import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { DuplicateModal } from './DuplicateModal';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { DuplicatePair } from '../../lib/types';

/**
 * Review item 49: live, the four D49 resolutions are REAL — they stage a
 * `document.resolve-duplicate` proposal (the review card is the confirmation)
 * — except Attach, which has no server shape yet and is disabled wearing its
 * reason (S12: no button whose action cannot happen). Synthetic keeps the
 * local ConfirmStep flow.
 */

let ctx: {
  documents: { id: string; clientId: string }[];
  resolveDuplicate: ReturnType<typeof vi.fn>;
  documentsSource: 'api' | 'seed';
};

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ctx,
}));

// The confirm dialog resolves true immediately — the synthetic path's gate.
const confirmFn = vi.fn(async () => true);
vi.mock('./ConfirmProvider', () => ({
  useConfirm: () => confirmFn,
}));

// The create-then-review flow is its own component with its own tests; here it
// only has to surface the request it was handed and its two callbacks.
vi.mock('./ProposalFlowModal', () => {
  // A variable, not a literal in JSX — the i18n lint rule reads test JSX too.
  const approveLabel = 'simulate-approved';
  return {
    ProposalFlowModal: ({
      request,
      onExecuted,
    }: {
      request: unknown;
      onExecuted?: () => void;
    }) => (
      <div data-testid="flow-modal">
        <span data-testid="flow-request">{JSON.stringify(request)}</span>
        <button aria-label={approveLabel} onClick={onExecuted} />
      </div>
    ),
  };
});

const pair: DuplicatePair = {
  id: 'dup-doc_copy-doc_keep',
  clientName: 'Zeplow Inc.',
  similarity: 0.77,
  signals: ['Identical total'],
  crossType: false,
  left: { id: 'doc_copy', label: 'BC Window Cleaning', type: 'Receipt', total: 35, date: '26 Aug 2025', uploader: 'king fisser.jpg' },
  right: { id: 'doc_keep', label: 'B C Window Cleaning', type: 'Receipt', total: 35, date: '26 Aug 2025', uploader: 'receipt-2.jpg', sentBy: 'Dee Okafor' },
};

beforeEach(() => {
  confirmFn.mockClear();
  ctx = {
    documents: [
      { id: 'doc_copy', clientId: 'biz_zeplow' },
      { id: 'doc_keep', clientId: 'biz_zeplow' },
    ],
    resolveDuplicate: vi.fn(),
    documentsSource: 'api',
  };
});

function renderModal(onResolved?: () => void) {
  return render(
    <AppIntlProvider>
      <DuplicateModal pair={pair} onClose={() => {}} {...(onResolved ? { onResolved } : {})} />
    </AppIntlProvider>,
  );
}

test('live: Delete the copy stages the real resolution — keep is the on-file side, no local confirm', async () => {
  renderModal();

  fireEvent.click(screen.getByRole('button', { name: /Delete the copy/ }));

  await waitFor(() => expect(screen.getByTestId('flow-request')).toBeTruthy());
  const request = JSON.parse(screen.getByTestId('flow-request').textContent ?? '{}');
  expect(request).toEqual({
    kind: 'document.resolve-duplicate',
    businessId: 'biz_zeplow',
    payload: { documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'delete-copy' },
  });
  // The review IS the confirmation — a second dialog in front is theatre.
  expect(confirmFn).not.toHaveBeenCalled();
  expect(ctx.resolveDuplicate).not.toHaveBeenCalled();
});

test('live: dismiss and keep-both carry their own resolutions', async () => {
  renderModal();

  fireEvent.click(screen.getByRole('button', { name: /Different documents/ }));
  await waitFor(() => expect(screen.getByTestId('flow-request')).toBeTruthy());
  expect(JSON.parse(screen.getByTestId('flow-request').textContent ?? '{}').payload.resolution).toBe(
    'different-documents',
  );
});

test('live: Attach is disabled wearing its reason — no server shape exists yet', () => {
  renderModal();

  const attach = screen.getByRole('button', { name: /Attach to the original/ }) as HTMLButtonElement;
  expect(attach.disabled).toBe(true);
  expect(attach.title).toMatch(/not built yet/);
});

test('live: an approved resolution calls onResolved so the opener refetches the rulings', async () => {
  const onResolved = vi.fn();
  renderModal(onResolved);

  fireEvent.click(screen.getByRole('button', { name: /Keep both/ }));
  await waitFor(() => expect(screen.getByTestId('flow-modal')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'simulate-approved' }));

  expect(onResolved).toHaveBeenCalledTimes(1);
});

test('synthetic: the local ConfirmStep flow stands, byte-for-byte', async () => {
  ctx.documentsSource = 'seed';
  renderModal();

  fireEvent.click(screen.getByRole('button', { name: /Delete the copy/ }));
  await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(ctx.resolveDuplicate).toHaveBeenCalledWith(pair.id, 'delete'));
  expect(screen.queryByTestId('flow-modal')).toBeNull();
});

test('who sent it is a PERSON when known, and the honest "File" label otherwise', () => {
  renderModal();

  // The on-file side carries package E's submitter label — a person.
  expect(screen.getByText('Dee Okafor')).toBeTruthy();
  // The copy side knows only the filename — labelled File, never "Sent by".
  expect(screen.getByText('File')).toBeTruthy();
  expect(screen.getByText('king fisser.jpg')).toBeTruthy();
});
