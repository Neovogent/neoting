import { Paperclip, Mic, Building2, Loader2, X, Check, ChevronDown, Square } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppContext } from '../context/AppContext';
import { motion, AnimatePresence } from 'motion/react';
import { classifyLocally, extractClientName, resolveScope } from '../lib/resolver';
import { useSpeech } from '../lib/useSpeech';
import { suggestPrompts } from '../lib/promptSuggestions';
import { TypedPlaceholder } from './DynamicComponents/TypedPlaceholder';
import { DocumentFormats, VoiceIcon } from './DynamicComponents/InputAffordances';
import type { Intent } from '../lib/types';

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

  const { addMessage, clients, messages, attachedClients, attachClient, detachClient, ingest, missing, chases, approvals, documents } = useAppContext();

  /**
   * Read off the live backlog, so the box offers the thing most worth doing
   * rather than five sentences written months ago.
   */
  const suggestions = useMemo(
    () => suggestPrompts({ clients, documents, missing, chases, approvals }),
    [clients, documents, missing, chases, approvals],
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
    let response = local.response;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          context: { clients: clients.map((c) => c.name), attached: scope.clientNames, hasAttachments: attachments.length > 0 },
        }),
      });
      // A non-2xx carries the server's own error fallback — keep the local
      // classification rather than letting it overwrite a good answer.
      if (res.ok) {
        const data = await res.json();
        // The model classifies; the payload is always resolved locally against real state.
        if (data?.intent) intent = data.intent as Intent;
        if (data?.response) response = data.response;
      }
    } catch {
      /* Server unavailable — the local classifier above already answered. */
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
            ? `Ingested ${attachments.length} file${attachments.length === 1 ? '' : 's'} — auto-split produced ${result.documents.length} documents. They're extracting now.`
            : `Ingested ${result.documents.length} document${result.documents.length === 1 ? '' : 's'}. Extraction is running.`;
      } else if (result.rejected.length) {
        // Nothing sits in a queue waiting to be routed — a file either becomes
        // a document or it was refused at the door, and the reason is said.
        intent = 'GENERAL';
        response = `I couldn't take ${result.rejected.length} file${result.rejected.length === 1 ? '' : 's'}: ${result.rejected
          .map((r) => `${r.fileName} — ${r.reason.toLowerCase()}`)
          .join('; ')}.`;
      }
    }

    addMessage({
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: response,
      intent,
      payload: {
        ...scope,
        documentId: ingestedId,
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
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0deg, rgba(20,227,196,0) 25deg, #14e3c4 60deg, rgba(20,227,196,0) 95deg, transparent 180deg, rgba(20,227,196,0) 205deg, #14e3c4 240deg, rgba(20,227,196,0) 275deg, transparent 360deg)',
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
        />
        <div className="relative bg-white/90 backdrop-blur-2xl border border-white/60 shadow-[0_20px_40px_-15px_rgba(20,227,196,0.2)] rounded-[32px] flex flex-col transition-all overflow-hidden focus-within:shadow-[0_20px_40px_-15px_rgba(20,227,196,0.4)] focus-within:border-white">
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
          placeholder={speech.listening ? 'Listening — speak now, then edit before sending…' : ''}
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
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#14e3c4]/10 border border-[#14e3c4]/30 text-[12px] font-bold text-[#14e3c4]">
                <Mic size={12} />
                Transcript — edit before sending
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
                title="Attach client context"
              >
                <Building2 size={14} />
                {attachedClients.length === 0
                  ? 'All clients'
                  : attachedClients.length === 1
                    // A length of one means the client is there; the count
                    // wording is only a fallback for an impossible hole.
                    ? attachedClients[0]?.name ?? '1 client'
                    : `${attachedClients.length} clients`}
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
                            {attached && <Check size={15} strokeWidth={3} className="text-[#14e3c4] shrink-0" />}
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
                title="Attach documents — 25MB per file, auto-split runs on multi-doc PDFs"
              >
                <Paperclip size={14} />
                Documents
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
                  ? 'bg-[#14e3c4] text-white border-[#14e3c4]'
                  : 'bg-white text-zinc-500 hover:text-zinc-900 border-zinc-200/50 hover:bg-zinc-50 hover:border-zinc-300'
              }`}
              title={speech.supported ? 'Push to talk — you confirm the transcript before it runs' : 'Voice not supported in this browser'}
            >
              {speech.listening
                ? <Square size={13} fill="currentColor" />
                : <VoiceIcon active={voiceHover && speech.supported} />}
              {speech.listening ? 'Stop' : 'Voice'}
            </button>
          </div>

          {/* Brand fill rather than the near-black plate: on light the plate
              remaps to white and the button disappeared into the composer. The
              mint carries the logo's dark ink from the brand rule in
              index.css, so it reads in both themes. */}
          <button
            onClick={handleSubmit}
            disabled={isLoading || !input.trim()}
            className="px-6 py-2.5 bg-[#14e3c4] text-white hover:bg-[#0fcbaf] rounded-full transition-all shadow-lg disabled:opacity-50 disabled:shadow-none flex items-center gap-2 font-semibold text-[14px] shrink-0"
            title="Generate"
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : 'Generate'}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
