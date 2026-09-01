import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatDropOverlay, ChatUploadClientPicker, useChatUpload } from './ChatUpload';

/**
 * The chat surface's upload flow — the thing the user report said did not
 * exist ("no document is being uploaded here"). What is pinned is the flow's
 * honesty rules, at the context boundary like `ChatArea.test.tsx`:
 *
 * - live, a drop reaches the real uploads client with the ATTACHED client's
 *   server id and `channel: 'CHAT_UPLOAD'` — never a guessed workspace;
 * - "All clients" holds the files and ASKS (the searchable picker) instead of
 *   uploading somewhere hopeful — nothing is sent until a client is chosen,
 *   and cancelling sends nothing at all; a practice with no clients yet keeps
 *   the named refusal, because an empty list has nothing to pick;
 * - a refused file's server reason lands in the transcript by name;
 * - synthetic mode keeps the local ingest, so the no-API walkthrough works.
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

/** The smallest host both real hosts (InputRow, ChatArea) are instances of. */
function Harness() {
  const upload = useChatUpload();
  return (
    <div data-testid="zone" {...upload.dropTargetProps}>
      <ChatDropOverlay dragging={upload.dragging} />
      <ChatUploadClientPicker upload={upload} />
    </div>
  );
}

const addMessage = vi.fn();
const setAssistantPending = vi.fn();
const ingest = vi.fn();

function renderZone(overrides: Record<string, unknown> = {}) {
  mocks.context.value = {
    documentsSource: 'api',
    attachedClients: [{ id: '1', name: 'American Burger Ltd' }],
    clients: [{ id: '1', name: 'American Burger Ltd' }],
    serverClientIdFor: (id: string) => `biz_${id}`,
    addMessage,
    setAssistantPending,
    ingest,
    ...overrides,
  };
  return render(
    <IntlProvider locale="en-GB">
      <Harness />
    </IntlProvider>,
  );
}

const dropFile = (name = 'receipt.jpg') =>
  fireEvent.drop(screen.getByTestId('zone'), {
    dataTransfer: { files: [new File(['bytes'], name, { type: 'image/jpeg' })] },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.sendWorkspaceUpload.mockResolvedValue({ documentId: 'doc_1', state: 'RECEIVED' });
});

describe('the drop overlay', () => {
  test('hidden until files are dragged over, then InboxesView’s copy', () => {
    renderZone();
    expect(screen.queryByText('Drop to ingest')).toBeNull();

    fireEvent.dragOver(screen.getByTestId('zone'));
    expect(screen.getByText('Drop to ingest')).toBeTruthy();
    // pointer-events-none + aria-hidden: it can neither take focus nor trap it.
    const overlay = screen.getByText('Drop to ingest').closest('[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.className).toContain('pointer-events-none');
  });
});

describe('a drop with a client attached, live', () => {
  test('uploads to that client’s business over CHAT_UPLOAD and says where it lands', async () => {
    renderZone();
    dropFile();

    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(1));
    expect(mocks.sendWorkspaceUpload).toHaveBeenCalledWith(
      'biz_1',
      { filename: 'receipt.jpg', mimeType: 'image/jpeg', bytes: expect.any(File) },
      'CHAT_UPLOAD',
    );

    // The in-flight state is the honest one — no client name, because an
    // upload reads nobody's records — and it is always cleared.
    expect(setAssistantPending).toHaveBeenNthCalledWith(1, { businessName: null });
    expect(setAssistantPending).toHaveBeenLastCalledWith(null);

    // The transcript: the queued file by name, then the reply pointing at the
    // surface where the document shows up next.
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const [userMsg, reply] = addMessage.mock.calls.map((c) => c[0] as { role: string; content: string; attachments?: unknown[] });
    expect(userMsg!.role).toBe('user');
    expect(userMsg!.attachments).toHaveLength(1);
    expect(reply!.role).toBe('assistant');
    expect(reply!.content).toContain('American Burger Ltd');
    expect(reply!.content).toContain('To Review');

    // The documents poll is nudged so Inboxes is already moving.
    expect(mocks.refreshDocuments).toHaveBeenCalledWith({ mocked: true });
  });
});

describe('a drop with "All clients" active, live', () => {
  test('asks with the searchable picker — nothing is sent until a client is chosen by name', async () => {
    renderZone({ attachedClients: [] });
    dropFile();

    // The picker is its own lazy chunk, so it arrives via findBy*.
    expect(await screen.findByText('Choose a client for this upload')).toBeTruthy();
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'American Burger Ltd' }));
    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(1));
    expect(mocks.sendWorkspaceUpload).toHaveBeenCalledWith(
      'biz_1',
      { filename: 'receipt.jpg', mimeType: 'image/jpeg', bytes: expect.any(File) },
      'CHAT_UPLOAD',
    );
    // The old flat refusal is gone — the question replaced it.
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  test('the search narrows the list, and cancel sends nothing', async () => {
    renderZone({
      attachedClients: [],
      clients: [
        { id: '1', name: 'American Burger Ltd' },
        { id: '2', name: 'Ananda Group' },
      ],
    });
    dropFile();

    const search = await screen.findByRole('textbox', { name: 'Search clients' });
    fireEvent.change(search, { target: { value: 'ananda' } });
    expect(screen.queryByRole('button', { name: 'American Burger Ltd' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ananda Group' })).toBeTruthy();

    // A query nothing matches says so, rather than showing an empty silence.
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No client matches “zzz”.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Choose a client for this upload')).toBeNull());
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  test('two attached clients is not a choice either — the picker asks', async () => {
    renderZone({
      attachedClients: [
        { id: '1', name: 'American Burger Ltd' },
        { id: '2', name: 'Ananda Group' },
      ],
      clients: [
        { id: '1', name: 'American Burger Ltd' },
        { id: '2', name: 'Ananda Group' },
      ],
    });
    dropFile();

    expect(await screen.findByText('Choose a client for this upload')).toBeTruthy();
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
  });

  test('a practice with no clients yet is pointed at the real first step', async () => {
    renderZone({ attachedClients: [], clients: [] });
    dropFile();

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const options = mocks.confirm.mock.calls[0]![0] as { detail: string };
    expect(options.detail).toContain('none yet');
  });
});

describe('a refused file, live', () => {
  test('the server’s own reason reaches the transcript, by file name', async () => {
    mocks.sendWorkspaceUpload.mockRejectedValueOnce(new Error('NT-VAL-002 The file is larger than the 25MB limit.'));
    renderZone();
    dropFile('huge-scan.pdf');

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const reply = addMessage.mock.calls[1]![0] as { content: string };
    expect(reply.content).toContain("I couldn't upload 1 file");
    expect(reply.content).toContain('huge-scan.pdf — NT-VAL-002 The file is larger than the 25MB limit.');
    // The wait indicator never survives a failure.
    expect(setAssistantPending).toHaveBeenLastCalledWith(null);
  });

  test('one refusal never stops the rest — the reply carries both halves', async () => {
    mocks.sendWorkspaceUpload
      .mockRejectedValueOnce(new Error('NT-VAL-002 too large'))
      .mockResolvedValueOnce({ documentId: 'doc_2', state: 'RECEIVED' });
    renderZone();
    fireEvent.drop(screen.getByTestId('zone'), {
      dataTransfer: {
        files: [new File(['a'], 'bad.pdf', { type: 'application/pdf' }), new File(['b'], 'good.jpg', { type: 'image/jpeg' })],
      },
    });

    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const reply = addMessage.mock.calls[1]![0] as { content: string };
    expect(reply.content).toContain('Uploaded 1 document');
    expect(reply.content).toContain('bad.pdf — NT-VAL-002 too large');
  });
});

describe('synthetic mode', () => {
  test('a drop is the local ingest — InboxesView’s posture, told in the transcript', async () => {
    ingest.mockReturnValue({ documents: [{ id: 'doc_local' }], rejected: [], imports: [] });
    renderZone({ documentsSource: 'seed', attachedClients: [{ id: '1', name: 'American Burger Ltd' }] });
    dropFile();

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    expect(ingest).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'receipt.jpg' })],
      '1',
      'chat',
    );
    const reply = addMessage.mock.calls[1]![0] as { content: string; intent: string };
    expect(reply.content).toBe('Ingested 1 document. Extraction is running.');
    expect(reply.intent).toBe('SHOW_INBOX');
    // Nothing live was touched.
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  test('no attached client ingests unrouted rather than prompting — extraction reads the addressee', async () => {
    ingest.mockReturnValue({ documents: [{ id: 'doc_local' }], rejected: [], imports: [] });
    renderZone({ documentsSource: 'seed', attachedClients: [] });
    dropFile();

    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(ingest).toHaveBeenCalledWith([expect.objectContaining({ name: 'receipt.jpg' })], undefined, 'chat');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
