import { Paperclip, Mic, Building2, Loader2, X, Check, ChevronDown, Square } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppContext } from '../context/AppContext';
import { motion, AnimatePresence } from 'motion/react';
import { API_ENABLED } from '../api/config';
import { classifyLocally, extractClientName, resolveScope } from '../lib/resolver';
import { matchDemoIntent } from '../lib/demoIntents';
import { useSpeech } from '../lib/useSpeech';
import { suggestPrompts } from '../lib/promptSuggestions';
import { TypedPlaceholder } from './DynamicComponents/TypedPlaceholder';
import { DocumentFormats, VoiceIcon } from './DynamicComponents/InputAffordances';
import { defineMessages, useIntl } from 'react-intl';
import type { Intent, MessagePayload } from '../lib/types';

const m = defineMessages({
  listeningPlaceholder: {
    id: 'shell.inputRow.listeningPlaceholder',
    defaultMessage: 'Listening — speak now, then edit before sending…',
  },
  transcriptChip: { id: 'shell.inputRow.transcriptChip', defaultMessage: 'Transcript — edit before sending' },
  attachClientContext: { id: 'shell.inputRow.attachClientContext', defaultMessage: 'Attach client context' },
  allClients: { id: 'shell.inputRow.allClients', defaultMessage: 'All clients' },
  clientCount: {
    id: 'shell.inputRow.clientCount',
    defaultMessage: '{count, plural, one {# client} other {# clients}}',
  },
  attachDocuments: {
    id: 'shell.inputRow.attachDocuments',
    defaultMessage: 'Attach documents — 25MB per file, auto-split runs on multi-doc PDFs',
  },
  documents: { id: 'shell.inputRow.documents', defaultMessage: 'Documents' },
  voiceSupported: {
    id: 'shell.inputRow.voiceSupported',
    defaultMessage: 'Push to talk — you confirm the transcript before it runs',
  },
  voiceUnsupported: {
    id: 'shell.inputRow.voiceUnsupported',
    defaultMessage: 'Voice not supported in this browser',
  },
  stop: { id: 'shell.inputRow.stop', defaultMessage: 'Stop' },
  voice: { id: 'shell.inputRow.voice', defaultMessage: 'Voice' },
  generate: { id: 'shell.inputRow.generate', defaultMessage: 'Generate' },

  // The assistant's own replies to an upload. Two whole sentences rather than
  // one with an inserted clause: the auto-split case and the plain case say
  // different things, and a translator should not have to hold both at once.
  ingestedSplit: {
    id: 'shell.inputRow.ingestedSplit',
    defaultMessage:
      'Ingested {fileCount, plural, one {# file} other {# files}} — auto-split produced {documentCount, plural, one {# document} other {# documents}}. They\'re extracting now.',
  },
  ingested: {
    id: 'shell.inputRow.ingested',
    defaultMessage:
      'Ingested {documentCount, plural, one {# document} other {# documents}}. Extraction is running.',
  },
  rejected: {
    id: 'shell.inputRow.rejected',
    defaultMessage: 'I couldn\'t take {count, plural, one {# file} other {# files}}: {reasons}.',
  },
});

export function InputRow() {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dictated, setDictated] = useState(false);
  const [anchor, setAnchor] = useState<{ bottom: number; left: number } | null>(null);
  const [voiceHover, setVoiceHover] = useState(false);
  const [docsHover, setDocsHover] = useState(false);
  /** The Documents button's rectangle, so the portalled stack can find it. */
  const [docsAnchor, setDocsAnchor] = useState<DOMRect | null>(null);
  const docsRef = useRef<HTMLButtonElement>(null);
  const baseTextRef = useRef('');
  const fileRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { addMessage, clients, messages, attachedClients, attachClient, detachClient, ingest, missing, chases, approvals, documents, businesses, session } = useAppContext();
  const intl = useIntl();

  /**
   * Read off the live backlog, so the box offers the thing most worth doing
   * rather than five sentences written months ago.
   */
  const suggestions = useMemo(
    () => suggestPrompts(intl, { clients, documents, missing, chases, approvals }),
    [intl, clients, documents, missing, chases, approvals],
  );
  const isEmpty = messages.length === 0;

  const speech = useSpeech((text, isFinal) => {
    setDictated(true);
    setInput(`${baseTextRef.current}${baseTextRef.current ? ' ' : ''}${text}`.trimStart());
    if (isFinal) baseTextRef.current = `${baseTextRef.current}${baseTextRef.current ? ' ' : ''}${text}`.trimStart();
  });

  /**
   * The input row sits inside a rounded card with overflow-hidden, so the menu
   * is portalled out and anchored to the trigger. It opens upward, away from
   * the bottom of the viewport.
   */
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ bottom: window.innerHeight - rect.top + 8, left: rect.left });
  }, []);

  useLayoutEffect(() => {
    if (pickerOpen) place();
  }, [pickerOpen, place]);

  useEffect(() => {
    if (!pickerOpen) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPickerOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [pickerOpen, place]);

  const submitMessage = async (textToSubmit: string) => {
    if (!textToSubmit.trim() || isLoading) return;

    const userMessage = textToSubmit.trim();
    const attachments = files.map((f) => ({ name: f.name, size: f.size, raw: f }));
    const wasDictated = dictated;

    setInput('');
    setFiles([]);
    setDictated(false);
    baseTextRef.current = '';
    if (speech.listening) speech.stop();

    addMessage({
      id: Date.now().toString(),
      role: 'user',
      content: userMessage,
      // Left off entirely when there are none — an empty array would draw an
      // attachment strip on a message that has nothing attached.
      ...(attachments.length ? { attachments } : {}),
      viaVoice: wasDictated || undefined,
    });
    setIsLoading(true);

    const scope = resolveScope(userMessage, clients, attachedClients.map((c) => c.id));
    const local = classifyLocally(userMessage);

    let intent: Intent = local.intent;
    // The classifier is module scope and hands back a catalogue entry; this is
    // where it becomes words. `let`, because an attached file replaces both
    // below: an upload makes the answer about the ingest, not about the text.
    let response = intl.formatMessage(local.response);

    // The live golden paths (METH Stage 13): with a real session, the canned
    // demo table runs AHEAD of the regex classifier — its intents render real
    // components and stage real proposals. Anything it does not recognise
    // falls through to `classifyLocally`, whose GENERAL fallback is the
    // graceful "here's what I can do" card. // DEMO-MOCK: Opus via Bedrock.
    let livePayload: Partial<MessagePayload> = {};
    if (API_ENABLED && session.status === 'authenticated') {
      const demo = matchDemoIntent(userMessage, { businesses, documents });
      if (demo) {
        intent = demo.intent;
        response = intl.formatMessage(demo.response);
        livePayload = demo.payload;
        // Live rows key on the SERVER business id, so a named business also
        // becomes the scope the tables filter on — the synthetic client ids in
        // `scope` cannot match a live row.
        if (demo.payload.businessId !== undefined) {
          scope.clientIds = [demo.payload.businessId];
          scope.clientNames = demo.payload.businessName === undefined ? [] : [demo.payload.businessName];
        }
      }
    }

    // Attachments really enter the pipeline — they appear in the Inboxes
    // section and move the client's counts, not just this conversation.
    let ingestedId: string | undefined;
    if (attachments.length > 0) {
      const result = ingest(attachments, scope.clientIds[0], 'chat');
      ingestedId = result.documents[0]?.id;

      if (result.documents.length) {
        intent = 'SHOW_INBOX';
        response =
          result.documents.length > attachments.length
            ? intl.formatMessage(m.ingestedSplit, {
                fileCount: attachments.length,
                documentCount: result.documents.length,
              })
            : intl.formatMessage(m.ingested, { documentCount: result.documents.length });
      } else if (result.rejected.length) {
        // Nothing sits in a queue waiting to be routed — a file either becomes
        // a document or it was refused at the door, and the reason is said.
        intent = 'GENERAL';
        response = intl.formatMessage(m.rejected, {
          count: result.rejected.length,
          reasons: result.rejected.map((r) => `${r.fileName} — ${r.reason.toLowerCase()}`).join('; '),
        });
      }
    }

    addMessage({
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: response,
      intent,
      payload: {
        ...scope,
        ...livePayload,
        // The ingest answer wins over a live match — an attached file makes
        // the message about the upload, and its id must not be shadowed.
        ...(ingestedId === undefined ? {} : { documentId: ingestedId }),
        clientName: intent === 'ADD_CLIENT' ? extractClientName(userMessage) : undefined,
      },
    });
    setIsLoading(false);
  };

  const handleSubmit = () => submitMessage(input);

  return (
    <div className={`p-6 ${isEmpty ? 'pb-2' : 'pb-12'} shrink-0 max-w-4xl w-full mx-auto`}>
      {/* A light travelling the border, slowly.
          Two arcs on opposite sides of one conic gradient, turning once every
          22 seconds — slow enough to read as a drift rather than a spinner,
          which is what stops it competing with the typing in the box. Held
          still for anyone who has asked for reduced motion. */}
      <div className="relative rounded-[34px] p-[1.5px] overflow-hidden isolate motion-reduce:p-0">
        <motion.span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -z-10 w-[180%] aspect-square -translate-x-1/2 -translate-y-1/2 motion-reduce:hidden"
          // The one gradient that cannot be a utility class: a conic sweep with
          // eight stops. It reads the brand from the token rather than repeating
          // the hex, so it follows the palette like everything else (R8).
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0deg, var(--color-brand-fade) 25deg, var(--color-brand) 60deg, var(--color-brand-fade) 95deg, transparent 180deg, var(--color-brand-fade) 205deg, var(--color-brand) 240deg, var(--color-brand-fade) 275deg, transparent 360deg)',
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
        />
        <div className="relative bg-white/90 backdrop-blur-2xl border border-white/60 shadow-composer rounded-[32px] flex flex-col transition-all overflow-hidden focus-within:shadow-composer-focus focus-within:border-white">
        {/* Only on the launcher. Once a conversation is running the person
            has already said what they want and is mid-thought — a box that
            starts typing its own sentences underneath their reply competes
            with them, and the backlog it recites is no longer the subject. */}
        {isEmpty && !input && !speech.listening && suggestions.length > 0 && (
          <TypedPlaceholder
            suggestions={suggestions}
            paused={isLoading}
            onAccept={(text) => {
              setInput(text);
              baseTextRef.current = text;
            }}
          />
        )}

        <textarea
          placeholder={speech.listening ? intl.formatMessage(m.listeningPlaceholder) : ''}
          className="w-full bg-transparent resize-none p-6 pb-4 text-[16px] focus:outline-none placeholder:text-zinc-400 text-zinc-800 min-h-[100px] max-h-40 font-medium [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          rows={2}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            baseTextRef.current = e.target.value;
          }}
          onKeyDown={(e) => {
            // Tab on an empty box takes the suggestion rather than leaving for
            // the next control — there is nothing to leave yet.
            if (isEmpty && e.key === 'Tab' && !input && !e.shiftKey && suggestions[0]) {
              e.preventDefault();
              const text = suggestions.find((x) => x)!.text;
              setInput(text);
              baseTextRef.current = text;
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />

        {(files.length > 0 || (dictated && input)) && (
          <div className="px-6 pb-3 flex flex-wrap items-center gap-2">
            {dictated && input && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-[12px] font-bold text-brand">
                <Mic size={12} />
                {intl.formatMessage(m.transcriptChip)}
              </span>
            )}
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-100 border border-zinc-200 text-[12px] font-semibold text-zinc-600"
              >
                <Paperclip size={12} />
                {f.name}
                <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-zinc-900">
                  <X size={12} strokeWidth={3} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="px-5 pb-5 flex items-center justify-between gap-3">
          <div className="flex items-center flex-wrap gap-2">
            <div>
              <button
                ref={triggerRef}
                onClick={() => setPickerOpen((o) => !o)}
                className="px-4 py-2 bg-white text-zinc-500 hover:text-zinc-900 border border-zinc-200/50 hover:bg-zinc-50 hover:border-zinc-300 rounded-full text-[13px] font-semibold transition-all shadow-sm flex items-center gap-2"
                title={intl.formatMessage(m.attachClientContext)}
              >
                <Building2 size={14} />
                {attachedClients.length === 0
                  ? intl.formatMessage(m.allClients)
                  : attachedClients.length === 1
                    // A length of one means the client is there; the count
                    // wording is only a fallback for an impossible hole.
                    ? attachedClients[0]?.name ?? intl.formatMessage(m.clientCount, { count: 1 })
                    : intl.formatMessage(m.clientCount, { count: attachedClients.length })}
                <ChevronDown size={13} className={`transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
              </button>

              {createPortal(
                <AnimatePresence>
                  {pickerOpen && anchor && (
                    <motion.div
                      ref={menuRef}
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      style={{ bottom: anchor.bottom, left: anchor.left }}
                      className="fixed w-64 max-h-[60vh] overflow-y-auto bg-white border border-zinc-200 rounded-2xl shadow-2xl z-[100] p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                      {clients.map((c) => {
                        const attached = attachedClients.some((a) => a.id === c.id);
                        return (
                          <button
                            key={c.id}
                            onClick={() => (attached ? detachClient(c.id) : attachClient(c.id))}
                            className="w-full px-3 py-2.5 rounded-xl flex items-center justify-between gap-3 text-[13px] font-semibold text-zinc-600 hover:bg-zinc-50 transition-colors text-left"
                          >
                            <span className="truncate">{c.name}</span>
                            {attached && <Check size={15} strokeWidth={3} className="text-brand shrink-0" />}
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>,
                document.body,
              )}
            </div>

            {/* Portalled, so the composer's overflow-hidden cannot clip it. */}
            <DocumentFormats open={docsHover} anchor={docsAnchor} />
            <div
              onMouseEnter={() => { setDocsAnchor(docsRef.current?.getBoundingClientRect() ?? null); setDocsHover(true); }}
              onMouseLeave={() => setDocsHover(false)}
            >
              <button
                ref={docsRef}
                onClick={() => fileRef.current?.click()}
                onFocus={() => { setDocsAnchor(docsRef.current?.getBoundingClientRect() ?? null); setDocsHover(true); }}
                onBlur={() => setDocsHover(false)}
                className="px-4 py-2 bg-white text-zinc-500 hover:text-zinc-900 border border-zinc-200/50 hover:bg-zinc-50 hover:border-zinc-300 rounded-full text-[13px] font-semibold transition-all shadow-sm flex items-center gap-2"
                title={intl.formatMessage(m.attachDocuments)}
              >
                <Paperclip size={14} />
                {intl.formatMessage(m.documents)}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf,.zip,.csv,.xlsx"
              className="hidden"
              onChange={(e) => {
                setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />

            {/* No positioning wrapper: the arcs live inside the icon's own
                box, so nothing here can overlap the controls either side. */}
            <button
              onClick={speech.toggle}
              onMouseEnter={() => setVoiceHover(true)}
              onMouseLeave={() => setVoiceHover(false)}
              onFocus={() => setVoiceHover(true)}
              onBlur={() => setVoiceHover(false)}
              disabled={!speech.supported}
              className={`px-4 py-2 rounded-full text-[13px] font-semibold transition-all shadow-sm flex items-center gap-2 border disabled:opacity-50 ${
                speech.listening
                  ? 'bg-brand text-white border-brand'
                  : 'bg-white text-zinc-500 hover:text-zinc-900 border-zinc-200/50 hover:bg-zinc-50 hover:border-zinc-300'
              }`}
              title={intl.formatMessage(speech.supported ? m.voiceSupported : m.voiceUnsupported)}
            >
              {speech.listening
                ? <Square size={13} fill="currentColor" />
                : <VoiceIcon active={voiceHover && speech.supported} />}
              {intl.formatMessage(speech.listening ? m.stop : m.voice)}
            </button>
          </div>

          {/* Brand fill rather than the near-black plate: on light the plate
              remaps to white and the button disappeared into the composer. The
              mint carries the logo's dark ink from the brand rule in
              index.css, so it reads in both themes. */}
          <button
            onClick={handleSubmit}
            disabled={isLoading || !input.trim()}
            className="px-6 py-2.5 bg-brand text-white hover:bg-brand-hover rounded-full transition-all shadow-lg disabled:opacity-50 disabled:shadow-none flex items-center gap-2 font-semibold text-[14px] shrink-0"
            title={intl.formatMessage(m.generate)}
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : intl.formatMessage(m.generate)}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
