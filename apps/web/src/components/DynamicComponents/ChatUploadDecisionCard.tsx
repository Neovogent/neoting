import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { Inbox, UploadCloud, Users, X } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';

/**
 * The chat upload's intent step (review item 58): a live upload is HELD on the
 * user bubble and this card asks what to do with it. Three options, all real
 * (S12 — "discuss it without ingesting" does not exist and is not offered):
 *
 *   1. **Send to {client}'s inbox for review** — the suggested one-click
 *      default (today's behaviour, made explicit) when exactly one client was
 *      attached; with none attached the primary is the picker.
 *   2. **Send to a different client** — the searchable `ChatClientPicker`.
 *   3. **Cancel — don't upload** — the files stay attached to the bubble.
 *
 * The send is the same three-call journey every document takes (intent →
 * presigned PUT → complete, channel CHAT_UPLOAD), imported dynamically at
 * click time — this card lives on the chat chunk and the journey follows a
 * user gesture, so the fetch hides behind the network it is about to use. The
 * outcome lands in the transcript with the honest timing copy (item 60's
 * lesson): where the document appears AND that it takes a moment.
 *
 * The raw Files ride the user bubble (`Message.attachments[].raw`) — they do
 * not survive persistence or a reload, and the card says so instead of
 * offering buttons that would upload nothing.
 */

const m = defineMessages({
  fileCount: {
    id: 'shell.chatUploadDecision.fileCount',
    defaultMessage: '{count, plural, one {# file} other {# files}} held',
  },
  sendSuggested: {
    id: 'shell.chatUploadDecision.sendSuggested',
    defaultMessage: 'Send to {client}\'s inbox for review',
  },
  sendPicked: { id: 'shell.chatUploadDecision.sendPicked', defaultMessage: 'Send to a client\'s inbox for review…' },
  differentClient: { id: 'shell.chatUploadDecision.differentClient', defaultMessage: 'Send to a different client' },
  cancel: { id: 'shell.chatUploadDecision.cancel', defaultMessage: 'Cancel — don\'t upload' },
  sending: { id: 'shell.chatUploadDecision.sending', defaultMessage: 'Uploading…' },
  done: { id: 'shell.chatUploadDecision.done', defaultMessage: 'Sent — the outcome is below.' },
  cancelled: {
    id: 'shell.chatUploadDecision.cancelled',
    defaultMessage: 'Not uploaded. The files stay attached to this conversation — the buttons come back if you change your mind.',
  },
  filesGone: {
    id: 'shell.chatUploadDecision.filesGone',
    defaultMessage:
      'The held files are no longer attached — they don\'t survive a reload. Attach them again to upload.',
  },

  // The outcome copy — the honest timing sentence is item 60's ruling: a user
  // checking the inbox immediately must not read absence as loss.
  uploaded: {
    id: 'shell.chatUploadDecision.uploaded',
    defaultMessage:
      'Uploaded {count, plural, one {# document} other {# documents}} for {client}. Extraction is running — {count, plural, one {it appears} other {they appear}} in {client}\'s inbox within a minute or two.',
  },
  uploadedPartial: {
    id: 'shell.chatUploadDecision.uploadedPartial',
    defaultMessage:
      'Uploaded {sent, plural, one {# document} other {# documents}} for {client} — extraction is running, and they appear in {client}\'s inbox within a minute or two. I couldn\'t take {failed, plural, one {# file} other {# files}}: {reasons}.',
  },
  uploadFailed: {
    id: 'shell.chatUploadDecision.uploadFailed',
    defaultMessage: 'I couldn\'t upload {count, plural, one {# file} other {# files}}: {reasons}.',
  },
});

let seq = 0;
const nextId = () => `updec_${Date.now()}_${(seq += 1)}`;

/**
 * The picker chunk the item-58 hold used to load from `ChatUpload.tsx` — same
 * dialog, now opened from the card. Portalled to <body> (the ContextBar
 * pattern): the transcript sits under animated containers, and an ancestor
 * transform would clip the Modal's `fixed` scrim to the card's rectangle.
 */
const LazyChatClientPicker = lazy(() => import('../ChatClientPicker'));

export function ChatUploadDecisionCard({
  uploadMessageId,
  suggestedClientId,
  suggestedClientName,
}: {
  uploadMessageId: string;
  suggestedClientId?: string | undefined;
  suggestedClientName?: string | undefined;
}) {
  const { addMessage, clients, messages, serverClientIdFor, setAssistantPending } = useAppContext();
  const intl = useIntl();
  const [phase, setPhase] = useState<'idle' | 'sending' | 'done' | 'cancelled'>('idle');
  const [pickerOpen, setPickerOpen] = useState(false);

  // The held files live on the user bubble. Gone (a reload, a pruned
  // transcript) means the buttons would upload nothing — say so instead.
  const held = messages.find((msg) => msg.id === uploadMessageId)?.attachments ?? [];
  const files = held.map((a) => a.raw).filter((raw): raw is File => raw instanceof File);

  const send = async (target: { id: string; name: string }) => {
    setPhase('sending');
    // The transcript's own in-flight state. `businessName: null` on purpose:
    // the named variant claims records are being read, and an upload reads none.
    setAssistantPending({ businessName: null });
    try {
      const [{ sendWorkspaceUpload, refreshDocuments }, { queryClient }] = await Promise.all([
        import('../../api/uploads'),
        import('../../api/queryClient'),
      ]);

      // Sequentially, one file's refusal never stopping the rest — each
      // outcome known by name for the reply.
      const failures: string[] = [];
      let sent = 0;
      for (const file of files) {
        try {
          await sendWorkspaceUpload(
            serverClientIdFor(target.id),
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
      // Nudge the documents poll so the inbox is already moving by the time
      // the reply below points at it.
      void refreshDocuments(queryClient);

      const reasons = failures.join('; ');
      const content =
        failures.length === 0
          ? intl.formatMessage(m.uploaded, { count: sent, client: target.name })
          : sent === 0
            ? intl.formatMessage(m.uploadFailed, { count: failures.length, reasons })
            : intl.formatMessage(m.uploadedPartial, { sent, failed: failures.length, client: target.name, reasons });
      addMessage({ id: nextId(), role: 'assistant', content, intent: 'GENERAL' });
      setPhase('done');
    } finally {
      // Whatever happened, the transcript must not keep claiming work is
      // still in flight.
      setAssistantPending(null);
    }
  };

  if (files.length === 0) {
    return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.filesGone)}</p>;
  }
  if (phase === 'sending') {
    return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.sending)}</p>;
  }
  if (phase === 'done') {
    return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.done)}</p>;
  }

  const suggested =
    suggestedClientId !== undefined && suggestedClientName !== undefined
      ? { id: suggestedClientId, name: suggestedClientName }
      : null;

  return (
    <div className="w-full border border-white/5 rounded-[28px] bg-card shadow-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] font-bold text-zinc-500 uppercase tracking-widest">
        <UploadCloud size={14} />
        {intl.formatMessage(m.fileCount, { count: files.length })}
      </div>

      {phase === 'cancelled' ? (
        <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.cancelled)}</p>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        {suggested !== null ? (
          <button
            onClick={() => void send(suggested)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold bg-brand text-brand-on hover:bg-brand-hover transition-colors shadow-glow-btn"
          >
            <Inbox size={14} />
            {intl.formatMessage(m.sendSuggested, { client: suggested.name })}
          </button>
        ) : (
          <button
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold bg-brand text-brand-on hover:bg-brand-hover transition-colors shadow-glow-btn"
          >
            <Inbox size={14} />
            {intl.formatMessage(m.sendPicked)}
          </button>
        )}
        {suggested !== null && (
          <button
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
          >
            <Users size={14} />
            {intl.formatMessage(m.differentClient)}
          </button>
        )}
        <button
          onClick={() => setPhase('cancelled')}
          className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
        >
          <X size={14} />
          {intl.formatMessage(m.cancel)}
        </button>
      </div>

      {createPortal(
        <AnimatePresence>
          {pickerOpen && (
            <Suspense fallback={null}>
              <LazyChatClientPicker
                clients={clients}
                fileCount={files.length}
                onPick={(clientId) => {
                  setPickerOpen(false);
                  const client = clients.find((c) => c.id === clientId);
                  // A pick that raced a changed client list settles to
                  // nothing rather than to a guess.
                  if (client) void send(client);
                }}
                onCancel={() => setPickerOpen(false)}
              />
            </Suspense>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
