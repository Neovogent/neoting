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

async function renderComposer(overrides: Record<string, unknown> = {}) {
  mocks.context.value = {
    documentsSource: 'api',
    attachedClients: [{ id: '1', name: 'American Burger Ltd' }],
    clients: [{ id: '1', name: 'American Burger Ltd' }],
    serverClientIdFor: (id: string) => `biz_${id}`,
    addMessage: vi.fn(),
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
  test('uploads to the attached client over CHAT_UPLOAD — no chip a send could never deliver', async () => {
    const { container } = await renderComposer();
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(1));
    expect(mocks.sendWorkspaceUpload).toHaveBeenCalledWith(
      'biz_1',
      { filename: 'receipt.jpg', mimeType: 'image/jpeg', bytes: expect.any(File) },
      'CHAT_UPLOAD',
    );
    // The file went into the pipeline, not into the composer's chip strip.
    expect(screen.queryByText('receipt.jpg')).toBeNull();
  });

  test('with "All clients" active it prompts for a client instead of uploading', async () => {
    const { container } = await renderComposer({ attachedClients: [] });
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({ title: 'Choose a client before uploading' });
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
    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(1));
    expect(mocks.sendWorkspaceUpload).toHaveBeenCalledWith(
      'biz_1',
      expect.objectContaining({ filename: 'dropped.jpg' }),
      'CHAT_UPLOAD',
    );
  });
});
