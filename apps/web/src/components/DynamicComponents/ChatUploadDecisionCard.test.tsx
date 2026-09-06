import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatUploadDecisionCard } from './ChatUploadDecisionCard';

/**
 * The held upload's decision card (review item 58). The rules pinned:
 *
 * - the one-click default sends to the SUGGESTED client's inbox, over
 *   CHAT_UPLOAD, with the server id — and the outcome carries item 60's honest
 *   timing copy ("within a minute or two"), never a claim of instant arrival;
 * - "Send to a different client" asks with the searchable picker; nothing
 *   sends until a client is chosen by name, and cancelling the picker sends
 *   nothing;
 * - "Cancel — don't upload" uploads nothing and SAYS the files stay attached;
 * - a refused file's server reason lands in the transcript by name, and one
 *   refusal never stops the rest;
 * - files that did not survive (a reload) degrade to an honest sentence, not
 *   buttons that would upload nothing.
 */

const mocks = vi.hoisted(() => ({
  context: { value: {} as Record<string, unknown> },
  sendWorkspaceUpload: vi.fn(),
  refreshDocuments: vi.fn(),
}));

vi.mock('../../context/AppContext', () => ({ useAppContext: () => mocks.context.value }));
vi.mock('../../api/uploads', () => ({
  sendWorkspaceUpload: mocks.sendWorkspaceUpload,
  refreshDocuments: mocks.refreshDocuments,
}));
vi.mock('../../api/queryClient', () => ({ queryClient: { mocked: true } }));

const addMessage = vi.fn();
const setAssistantPending = vi.fn();

function renderCard(overrides: {
  attachments?: { name: string; size: number; raw?: File }[];
  suggested?: boolean;
  clients?: { id: string; name: string }[];
} = {}) {
  const attachments =
    overrides.attachments ?? [{ name: 'receipt.jpg', size: 5, raw: new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' }) }];
  mocks.context.value = {
    addMessage,
    setAssistantPending,
    clients: overrides.clients ?? [
      { id: '1', name: 'American Burger Ltd' },
      { id: '2', name: 'Ananda Group' },
    ],
    messages: [{ id: 'upl_1', role: 'user', content: '', attachments }],
    serverClientIdFor: (id: string) => `biz_${id}`,
  };
  const suggested = overrides.suggested ?? true;
  return render(
    <IntlProvider locale="en-GB">
      <ChatUploadDecisionCard
        uploadMessageId="upl_1"
        {...(suggested ? { suggestedClientId: '1', suggestedClientName: 'American Burger Ltd' } : {})}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendWorkspaceUpload.mockResolvedValue({ documentId: 'doc_1', state: 'RECEIVED' });
});

describe('the one-click default', () => {
  test('sends to the suggested client over CHAT_UPLOAD and answers with the honest timing copy', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Send to American Burger Ltd's inbox/ }));

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

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(1));
    const reply = addMessage.mock.calls[0]![0] as { content: string };
    expect(reply.content).toContain('American Burger Ltd');
    // Item 60's ruling: where it lands AND that it takes a moment.
    expect(reply.content).toContain('within a minute or two');

    expect(mocks.refreshDocuments).toHaveBeenCalledWith({ mocked: true });
  });
});

describe('a different client', () => {
  test('asks with the searchable picker — nothing sends until a client is chosen by name', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Send to a different client' }));

    // The picker is its own lazy chunk, so it arrives via findBy*.
    expect(await screen.findByText('Choose a client for this upload')).toBeTruthy();
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ananda Group' }));
    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(1));
    expect(mocks.sendWorkspaceUpload).toHaveBeenCalledWith('biz_2', expect.anything(), 'CHAT_UPLOAD');
  });

  test('with no suggestion the PRIMARY is the picker, and cancelling it sends nothing', async () => {
    renderCard({ suggested: false });
    fireEvent.click(screen.getByRole('button', { name: /Send to a client's inbox/ }));

    expect(await screen.findByText('Choose a client for this upload')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Choose a client for this upload')).toBeNull());
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });
});

describe('cancel — don’t upload', () => {
  test('uploads nothing and says the files stay attached', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Cancel — don't upload/ }));

    expect(screen.getByText(/files stay attached to this conversation/)).toBeTruthy();
    expect(mocks.sendWorkspaceUpload).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  test('the server’s own reason reaches the transcript, by file name — and one refusal never stops the rest', async () => {
    mocks.sendWorkspaceUpload
      .mockRejectedValueOnce(new Error('NT-VAL-002 too large'))
      .mockResolvedValueOnce({ documentId: 'doc_2', state: 'RECEIVED' });
    renderCard({
      attachments: [
        { name: 'bad.pdf', size: 9, raw: new File(['a'], 'bad.pdf', { type: 'application/pdf' }) },
        { name: 'good.jpg', size: 3, raw: new File(['b'], 'good.jpg', { type: 'image/jpeg' }) },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Send to American Burger Ltd's inbox/ }));

    await waitFor(() => expect(mocks.sendWorkspaceUpload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(1));
    const reply = addMessage.mock.calls[0]![0] as { content: string };
    expect(reply.content).toContain('Uploaded 1 document');
    expect(reply.content).toContain('bad.pdf — NT-VAL-002 too large');
    expect(setAssistantPending).toHaveBeenLastCalledWith(null);
  });
});

describe('files that did not survive', () => {
  test('degrades to an honest sentence — no buttons that would upload nothing', () => {
    renderCard({ attachments: [{ name: 'receipt.jpg', size: 5 }] });

    expect(screen.getByText(/no longer attached/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
