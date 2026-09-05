import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatDropOverlay, useChatUpload } from './ChatUpload';

/**
 * The chat surface's upload flow. Since review item 58 the LIVE rules changed
 * shape and are pinned here:
 *
 * - a live drop HOLDS and ASKS — nothing uploads on the drop itself, ever. The
 *   files land on a user bubble (raw File kept, so an unanswered question
 *   stays visibly attached) and the assistant answers with the
 *   CHAT_UPLOAD_DECISION card, suggesting the attached client when exactly one
 *   was attached;
 * - "All clients" (or several) holds with NO suggestion — never a guess;
 * - a practice with no clients keeps the named refusal, because an empty list
 *   has nothing to pick;
 * - synthetic mode keeps the local ingest, so the no-API walkthrough works.
 *
 * The SEND half — the journey, the refusal reasons, the honest timing copy —
 * lives on the decision card and is pinned in
 * `DynamicComponents/ChatUploadDecisionCard.test.tsx`.
 */

const mocks = vi.hoisted(() => ({
  context: { value: {} as Record<string, unknown> },
  confirm: vi.fn(),
}));

vi.mock('../context/AppContext', () => ({ useAppContext: () => mocks.context.value }));
vi.mock('./DynamicComponents/ConfirmProvider', () => ({ useConfirm: () => mocks.confirm }));

/** The smallest host both real hosts (InputRow, ChatArea) are instances of. */
function Harness() {
  const upload = useChatUpload();
  return (
    <div data-testid="zone" {...upload.dropTargetProps}>
      <ChatDropOverlay dragging={upload.dragging} />
    </div>
  );
}

const addMessage = vi.fn();
const ingest = vi.fn();

function renderZone(overrides: Record<string, unknown> = {}) {
  mocks.context.value = {
    documentsSource: 'api',
    attachedClients: [{ id: '1', name: 'American Burger Ltd' }],
    clients: [{ id: '1', name: 'American Burger Ltd' }],
    addMessage,
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

describe('a live drop HOLDS and asks (item 58)', () => {
  test('one attached client becomes the suggested default — and NOTHING uploads on the drop', async () => {
    renderZone();
    dropFile();

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const [bubble, question] = addMessage.mock.calls.map(
      (c) => c[0] as { id: string; role: string; content: string; intent?: string; payload?: Record<string, unknown>; attachments?: { raw?: File }[] },
    );

    // The files stay visibly attached — raw File and all, so the card can act
    // on them later in the session.
    expect(bubble!.role).toBe('user');
    expect(bubble!.attachments).toHaveLength(1);
    expect(bubble!.attachments![0]!.raw).toBeInstanceOf(File);

    // The question, with the one-click default named.
    expect(question!.role).toBe('assistant');
    expect(question!.intent).toBe('CHAT_UPLOAD_DECISION');
    expect(question!.content).toContain('nothing has uploaded yet');
    expect(question!.content).toContain('American Burger Ltd');
    expect(question!.payload).toEqual({
      uploadMessageId: bubble!.id,
      suggestedClientId: '1',
      suggestedClientName: 'American Burger Ltd',
    });
  });

  test('"All clients" holds with NO suggestion — never a guess', async () => {
    renderZone({ attachedClients: [] });
    dropFile();

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const question = addMessage.mock.calls[1]![0] as { intent?: string; payload?: Record<string, unknown> };
    expect(question.intent).toBe('CHAT_UPLOAD_DECISION');
    expect(question.payload!.suggestedClientId).toBeUndefined();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  test('two attached clients is not a choice either — held with no suggestion', async () => {
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

    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    const question = addMessage.mock.calls[1]![0] as { payload?: Record<string, unknown> };
    expect(question.payload!.suggestedClientId).toBeUndefined();
  });

  test('a practice with no clients yet is pointed at the real first step', async () => {
    renderZone({ attachedClients: [], clients: [] });
    dropFile();

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const options = mocks.confirm.mock.calls[0]![0] as { detail: string };
    expect(options.detail).toContain('none yet');
    expect(addMessage).not.toHaveBeenCalled();
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
