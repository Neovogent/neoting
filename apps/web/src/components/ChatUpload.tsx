import { useCallback, useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { useConfirm } from './DynamicComponents/ConfirmProvider';
import { commonActions } from '../i18n/common';

/**
 * The chat surface's way into the real pipeline: the composer's file picker and
 * a drag-and-drop over the transcript, one flow behind both.
 *
 * ⚠ **Live, a chat upload ASKS FIRST (review item 58).** It used to fire the
 * ingest the moment a file landed; now every live upload is HELD: the files go
 * into the transcript as a user bubble (raw `File` kept on the message, so an
 * unanswered question leaves them visibly attached to the conversation), and
 * the assistant answers with a `CHAT_UPLOAD_DECISION` card offering the real
 * options — "Send to {client}'s inbox for review" (the one-click default when
 * exactly one client is attached), "Send to a different client" (the
 * searchable picker), "Cancel — don't upload". The card and the actual send
 * live in `DynamicComponents/ChatUploadDecisionCard.tsx`, on the chat chunk —
 * which is also what took the upload journey OFF this floor-resident module.
 * There is deliberately no "discuss it without ingesting" option: no read path
 * for un-ingested bytes exists, and a button whose action cannot happen is the
 * S12 lie.
 *
 * A practice with no clients keeps the named refusal, because an empty list
 * has nothing to pick. Never a guessed workspace — guessing at ingest time is
 * the misrouting the product exists to fix.
 *
 * Synthetic mode keeps InboxesView's posture for a drop: the local `ingest`
 * runs immediately (METH_MODE §1 — the app walks end to end with no API), and
 * the transcript says what happened in the same words the composer already
 * uses for an attached file.
 */

const m = defineMessages({
  dropHeading: { id: 'shell.chatUpload.dropHeading', defaultMessage: 'Drop to ingest' },
  // The composer's own claim (25MB in `attachDocuments`), not InboxesView's
  // 100MB — the overlay and the button it stands beside must agree.
  dropDetail: {
    id: 'shell.chatUpload.dropDetail',
    defaultMessage: 'Multi-document PDFs are auto-split · 25MB per file',
  },
  needsClientTitle: {
    id: 'shell.chatUpload.needsClientTitle',
    defaultMessage: 'Choose a client before uploading',
  },
  // A practice with no clients cannot pick one from a list — it is empty, and
  // the instruction has to point at the real first step.
  needsFirstClientDetail: {
    id: 'shell.chatUpload.needsFirstClientDetail',
    defaultMessage:
      'Every document is filed under a named client, and this practice has none yet — add your first client under Clients, then come back.',
  },

  // The intent step (item 58): the assistant's question. Written to stand
  // alone too — a restored transcript keeps the text and drops the card.
  holdQuestionFor: {
    id: 'shell.chatUpload.holdQuestionFor',
    defaultMessage:
      'I\'m holding {count, plural, one {# file} other {# files}} — nothing has uploaded yet. Send {count, plural, one {it} other {them}} to {client}\'s inbox for review? {count, plural, one {It stays} other {They stay}} attached to this conversation until you decide.',
  },
  holdQuestion: {
    id: 'shell.chatUpload.holdQuestion',
    defaultMessage:
      'I\'m holding {count, plural, one {# file} other {# files}} — nothing has uploaded yet. Which client\'s inbox should {count, plural, one {it} other {they}} go to? {count, plural, one {It stays} other {They stay}} attached to this conversation until you decide.',
  },

  // The synthetic drop's replies — the same two-sentence discipline as the
  // composer's own ingest copy, under this surface's ids.
  ingestedSplit: {
    id: 'shell.chatUpload.ingestedSplit',
    defaultMessage:
      'Ingested {fileCount, plural, one {# file} other {# files}} — auto-split produced {documentCount, plural, one {# document} other {# documents}}. They\'re extracting now.',
  },
  ingested: {
    id: 'shell.chatUpload.ingested',
    defaultMessage:
      'Ingested {documentCount, plural, one {# document} other {# documents}}. Extraction is running.',
  },
  rejected: {
    id: 'shell.chatUpload.rejected',
    defaultMessage: 'I couldn\'t take {count, plural, one {# file} other {# files}}: {reasons}.',
  },
});

/**
 * Unique within a session even when two messages are minted in the same
 * millisecond — `addMessage` is idempotent BY ID, so a bare `Date.now()` here
 * would silently drop the second of a fast pair.
 */
let seq = 0;
const nextId = () => `upl_${Date.now()}_${(seq += 1)}`;

export interface ChatUpload {
  /** `documentsSource === 'api'` — the same live signal InboxesView branches on. */
  live: boolean;
  /** Files are over this host right now; render `ChatDropOverlay` from it. */
  dragging: boolean;
  /** Spread onto the host element — InboxesView's drop wiring, verbatim. */
  dropTargetProps: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
  /** The one flow both entry points share. */
  uploadFiles: (files: File[]) => Promise<void>;
}

export function useChatUpload(): ChatUpload {
  const { addMessage, attachedClients, clients, documentsSource, ingest } = useAppContext();
  const intl = useIntl();
  const confirm = useConfirm();
  const [dragging, setDragging] = useState(false);

  const live = documentsSource === 'api';

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const attachments = files.map((f) => ({ name: f.name, size: f.size, raw: f }));

      if (!live) {
        // Synthetic: InboxesView's posture — ingest immediately, no client
        // required (extraction reads the addressee off the document) — told in
        // the transcript because that is where this surface talks.
        addMessage({ id: nextId(), role: 'user', content: '', attachments });
        const result = ingest(attachments, attachedClients[0]?.id, 'chat');
        const firstId = result.documents[0]?.id;
        if (result.documents.length) {
          addMessage({
            id: nextId(),
            role: 'assistant',
            content:
              result.documents.length > files.length
                ? intl.formatMessage(m.ingestedSplit, { fileCount: files.length, documentCount: result.documents.length })
                : intl.formatMessage(m.ingested, { documentCount: result.documents.length }),
            intent: 'SHOW_INBOX',
            payload: { ...(firstId === undefined ? {} : { documentId: firstId }) },
          });
        } else if (result.rejected.length) {
          addMessage({
            id: nextId(),
            role: 'assistant',
            content: intl.formatMessage(m.rejected, {
              count: result.rejected.length,
              reasons: result.rejected.map((r) => `${r.fileName} — ${r.reason.toLowerCase()}`).join('; '),
            }),
            intent: 'GENERAL',
          });
        }
        return;
      }

      if (clients.length === 0) {
        await confirm({
          tone: 'red',
          title: intl.formatMessage(m.needsClientTitle),
          detail: intl.formatMessage(m.needsFirstClientDetail),
          confirmLabel: intl.formatMessage(commonActions.close),
        });
        return;
      }

      // Live: HOLD and ask (item 58). The files ride the user bubble — raw
      // File included, so the decision card can act on them and an unanswered
      // question leaves them visibly attached — and the assistant's card asks
      // the one thing that decides everything: whose inbox. Exactly one
      // attached client is the suggested one-click default; zero or several
      // is not a choice, so the card leads with the picker (never a guess —
      // the API's own rule, and InboxesView's).
      const suggested = attachedClients.length === 1 ? attachedClients[0] : undefined;
      const uploadMessageId = nextId();
      addMessage({ id: uploadMessageId, role: 'user', content: '', attachments });
      addMessage({
        id: nextId(),
        role: 'assistant',
        content:
          suggested === undefined
            ? intl.formatMessage(m.holdQuestion, { count: files.length })
            : intl.formatMessage(m.holdQuestionFor, { count: files.length, client: suggested.name }),
        intent: 'CHAT_UPLOAD_DECISION',
        payload: {
          uploadMessageId,
          ...(suggested === undefined
            ? {}
            : { suggestedClientId: suggested.id, suggestedClientName: suggested.name }),
        },
      });
    },
    [live, addMessage, ingest, attachedClients, clients, confirm, intl],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dropped = e.dataTransfer?.files;
      if (dropped?.length) void uploadFiles(Array.from(dropped));
    },
    [uploadFiles],
  );

  return {
    live,
    dragging,
    dropTargetProps: { onDragOver, onDragLeave, onDrop },
    uploadFiles,
  };
}

/**
 * InboxesView's drop overlay, on the chat surface. `pointer-events-none` and
 * `aria-hidden` together are what keep it honest for a keyboard user: it can
 * neither take focus nor trap it — it exists only while a pointer is mid-drag,
 * an operation a keyboard never starts.
 */
export function ChatDropOverlay({ dragging }: { dragging: boolean }) {
  const intl = useIntl();
  return (
    <AnimatePresence>
      {dragging && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          aria-hidden="true"
          className="fixed inset-0 z-[60] bg-brand/20 backdrop-blur-sm border-4 border-dashed border-brand flex items-center justify-center pointer-events-none"
        >
          <div className="bg-card border border-white/10 rounded-[32px] px-4 md:px-10 py-8 text-center shadow-2xl">
            <UploadCloud size={40} className="text-brand mx-auto mb-4" />
            <p className="text-xl font-bold text-white">{intl.formatMessage(m.dropHeading)}</p>
            <p className="text-[13px] text-zinc-500 mt-1">{intl.formatMessage(m.dropDetail)}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
