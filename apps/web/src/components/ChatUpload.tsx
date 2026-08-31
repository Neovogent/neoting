import { useCallback, useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { useConfirm } from './DynamicComponents/ConfirmProvider';
import { commonActions } from '../i18n/common';

/**
 * The chat surface's way into the real pipeline: the composer's file picker and
 * a drag-and-drop over the transcript, one flow behind both (the user report
 * this closes: files "attached" in chat never reached the server — the live
 * build routed them into the synthetic ingest, which writes local rows the next
 * poll discards).
 *
 * Live (`documentsSource === 'api'`) it is the same three-call journey every
 * other document takes — intent → presigned PUT → complete (`api/uploads.ts`) —
 * with `channel: 'CHAT_UPLOAD'`, the contract's name for this door. The
 * business id is resolved exactly the way InboxesView resolves it: the chosen
 * client through `serverClientIdFor`. With "All clients" active there is no
 * chosen client, and the honest answer is InboxesView's — a named refusal with
 * instructions, never a guessed workspace (guessing at ingest time is the
 * misrouting the product exists to fix).
 *
 * Synthetic mode keeps InboxesView's posture for a drop: the local `ingest`
 * runs immediately (METH_MODE §1 — the app walks end to end with no API), and
 * the transcript says what happened in the same words the composer already
 * uses for an attached file.
 *
 * Feedback lives in the transcript, the chat's own pattern: a user bubble
 * carrying the files as they queue (one chip per file), the pending indicator
 * while the uploads run — `businessName: null`, so it says only "Working on
 * it…", which is true, rather than "Reading X's records…", which would not
 * be — and an assistant reply naming what landed, where it shows up next
 * (Inboxes → To Review), and every refused file with the server's own reason.
 *
 * `api/uploads.ts` and the query client are imported dynamically at upload
 * time: this module is floor-resident (InputRow is the shell), the worst
 * route's headroom is ~2.9 kB, and an upload always follows a user gesture, so
 * the chunk fetch hides entirely behind the network the upload is about to use.
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
  needsClientDetail: {
    id: 'shell.chatUpload.needsClientDetail',
    defaultMessage:
      'Every document is filed under a named client — pick one with the client selector in the composer, then send the files again. Guessing at upload time is how paperwork lands in the wrong books.',
  },
  // A practice with no clients cannot "pick one with the client selector" —
  // the list is empty, and the instruction has to point at the real first step.
  needsFirstClientDetail: {
    id: 'shell.chatUpload.needsFirstClientDetail',
    defaultMessage:
      'Every document is filed under a named client, and this practice has none yet — add your first client under Clients, then come back.',
  },
  uploaded: {
    id: 'shell.chatUpload.uploaded',
    defaultMessage:
      'Uploaded {count, plural, one {# document} other {# documents}} for {client}. Extraction is running — they land in Inboxes under To Review.',
  },
  uploadedPartial: {
    id: 'shell.chatUpload.uploadedPartial',
    defaultMessage:
      'Uploaded {sent, plural, one {# document} other {# documents}} for {client} — extraction is running, and they land in Inboxes under To Review. I couldn\'t take {failed, plural, one {# file} other {# files}}: {reasons}.',
  },
  uploadFailed: {
    id: 'shell.chatUpload.uploadFailed',
    defaultMessage: 'I couldn\'t upload {count, plural, one {# file} other {# files}}: {reasons}.',
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
  const { addMessage, attachedClients, clients, documentsSource, ingest, serverClientIdFor, setAssistantPending } =
    useAppContext();
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

      // Exactly one attached client names the workspace. Zero is "All clients";
      // two or more is not a choice either — refuse with instructions, never
      // guess (the API's own rule, and InboxesView's).
      const target = attachedClients.length === 1 ? attachedClients[0] : undefined;
      if (target === undefined) {
        await confirm({
          tone: 'red',
          title: intl.formatMessage(m.needsClientTitle),
          detail: intl.formatMessage(clients.length === 0 ? m.needsFirstClientDetail : m.needsClientDetail),
          confirmLabel: intl.formatMessage(commonActions.close),
        });
        return;
      }
      const businessId = serverClientIdFor(target.id);

      addMessage({ id: nextId(), role: 'user', content: '', attachments });
      // The transcript's own in-flight state. `businessName: null` on purpose:
      // the named variant claims records are being read, and an upload reads none.
      setAssistantPending({ businessName: null });
      try {
        const [{ sendWorkspaceUpload, refreshDocuments }, { queryClient }] = await Promise.all([
          import('../api/uploads'),
          import('../api/queryClient'),
        ]);

        // Sequentially, one file's refusal never stopping the rest — the
        // `sendWorkspaceUploads` shape, walked here so each file's outcome is
        // known by name for the reply.
        const failures: string[] = [];
        let sent = 0;
        for (const file of files) {
          try {
            await sendWorkspaceUpload(
              businessId,
              { filename: file.name, mimeType: file.type || 'application/octet-stream', bytes: file },
              'CHAT_UPLOAD',
            );
            sent += 1;
          } catch (error) {
            // The uploads client throws the problem+json detail as the message;
            // that is the server's own sentence, so it is the one shown.
            failures.push(`${file.name} — ${error instanceof Error ? error.message : 'upload failed'}`);
          }
        }
        // Nudge the documents poll so the Inboxes list is already moving by
        // the time the reply below points at it.
        void refreshDocuments(queryClient);

        const reasons = failures.join('; ');
        const content =
          failures.length === 0
            ? intl.formatMessage(m.uploaded, { count: sent, client: target.name })
            : sent === 0
              ? intl.formatMessage(m.uploadFailed, { count: failures.length, reasons })
              : intl.formatMessage(m.uploadedPartial, { sent, failed: failures.length, client: target.name, reasons });
        addMessage({ id: nextId(), role: 'assistant', content, intent: 'GENERAL' });
      } finally {
        // Whatever happened, the transcript must not keep claiming work is
        // still in flight.
        setAssistantPending(null);
      }
    },
    [live, addMessage, ingest, attachedClients, clients, serverClientIdFor, setAssistantPending, confirm, intl],
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

  return { live, dragging, dropTargetProps: { onDragOver, onDragLeave, onDrop }, uploadFiles };
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
