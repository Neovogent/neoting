import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The composer's two file doors — the Documents button and a drag onto the
 * composer itself — reaching the REAL upload flow (`ChatUpload.tsx`, unmocked
 * here on purpose: the wiring between InputRow and the hook is the thing this
 * suite exists to see). Only the boundaries beyond it are stubbed: the context,
 * the uploads client, and the two chat data hooks that would otherwise open
 * queries this suite is not about.
 */

const mocks = vi.hoisted(() => ({
  context: { value: {} as Record<string, unknown> },
  confirm: vi.fn(),
  sendWorkspaceUpload: vi.fn(),
  refreshDocuments: vi.fn(),
}));

vi.mock('../context/AppContext', () => ({ useAppContext: () => mocks.context.value }));
vi.mock('./DynamicComponents/ConfirmProvider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../api/uploads', () => ({
  sendWorkspaceUpload: mocks.sendWorkspaceUpload,
  refreshDocuments: mocks.refreshDocuments,
}));
vi.mock('../api/queryClient', () => ({ queryClient: { mocked: true } }));
vi.mock('../api/suggestions', () => ({ useLiveSuggestions: () => null }));
vi.mock('../lib/useSpeech', () => ({
  useSpeech: () => ({ listening: false, supported: false, toggle: vi.fn(), stop: vi.fn() }),
}));
// Types on its own timers; this suite is about the file doors, not the launcher.
vi.mock('./DynamicComponents/TypedPlaceholder', () => ({ TypedPlaceholder: () => null }));

const addMessage = vi.fn();

async function renderComposer(overrides: Record<string, unknown> = {}) {
  mocks.context.value = {
    documentsSource: 'api',
    attachedClients: [{ id: '1', name: 'American Burger Ltd' }],
    clients: [{ id: '1', name: 'American Burger Ltd' }],
    serverClientIdFor: (id: string) => `biz_${id}`,
    addMessage,
    setAssistantPending: vi.fn(),
    ingest: vi.fn(() => ({ documents: [], rejected: [], imports: [] })),
    attachClient: vi.fn(),
    detachClient: vi.fn(),
    messages: [],
    missing: [],
    chases: [],
    approvals: [],
    documents: [],
    businesses: [],
    session: { status: 'off' },
    // The drill-in bridge (review item 25): absent means nothing queued.
    pendingUtterance: null,
    setPendingUtterance: vi.fn(),
    ...overrides,
  };
  const { InputRow } = await import('./InputRow');
  return render(
    <IntlProvider locale="en-GB">
      <InputRow />
    </IntlProvider>,
  );
}

const fileInput = (container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  return input!;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.sendWorkspaceUpload.mockResolvedValue({ documentId: 'doc_1', state: 'RECEIVED' });
});

describe('the Documents button', () => {
  test('renders, and opens the native multi-file picker', async () => {
    const { container } = await renderComposer();
    const input = fileInput(container);
    expect(input.multiple).toBe(true);

    const clicked = vi.spyOn(input, 'click');
    // Live, the title says what the click now does — upload, not attach.
    fireEvent.click(screen.getByTitle(/Upload documents from your computer/));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  test('synthetic keeps the attach wording — that flow still attaches', async () => {
    await renderComposer({ documentsSource: 'seed' });
    expect(screen.getByTitle(/Attach documents/)).toBeTruthy();
  });
});

describe('picking files, live', () => {
  test('HOLDS and asks (item 58) — the files reach the transcript, nothing uploads on the pick', async () => {
    const { container } = await renderComposer();
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const question = addMessage.mock.calls[1]![0] as { intent?: string; payload?: Record<string, unknown> };
    expect(question.intent).toBe('CHAT_UPLOAD_DECISION');
    expect(question.payload!.suggestedClientName).toBe('American Burger Ltd');
    // The one thing item 58 exists to stop: the ingest firing on the pick.
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
    // And no chip in the composer either — the file lives in the transcript.
    expect(screen.queryByText('receipt.jpg')).toBeNull();
  });

  test('with "All clients" active the hold carries NO suggested client — never a guess', async () => {
    const { container } = await renderComposer({ attachedClients: [] });
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const question = addMessage.mock.calls[1]![0] as { intent?: string; payload?: Record<string, unknown> };
    expect(question.intent).toBe('CHAT_UPLOAD_DECISION');
    expect(question.payload!.suggestedClientId).toBeUndefined();
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
  });
});

describe('picking files, synthetic', () => {
  test('keeps the attach-then-send chips — the no-API walkthrough is untouched', async () => {
    const { container } = await renderComposer({ documentsSource: 'seed' });
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    expect(await screen.findByText('receipt.jpg')).toBeTruthy();
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
  });
});

describe('dragging files over the composer', () => {
  test('shows the drop overlay, and a drop takes the same path as the picker', async () => {
    const { container } = await renderComposer();
    const host = container.firstElementChild as HTMLElement;

    expect(screen.queryByText('Drop to ingest')).toBeNull();
    fireEvent.dragOver(host);
    expect(screen.getByText('Drop to ingest')).toBeTruthy();

    fireEvent.drop(host, {
      dataTransfer: { files: [new File(['bytes'], 'dropped.jpg', { type: 'image/jpeg' })] },
    });
    // Same path as the picker: the drop HOLDS and asks (item 58).
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const question = addMessage.mock.calls[1]![0] as { intent?: string };
    expect(question.intent).toBe('CHAT_UPLOAD_DECISION');
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
  });
});
