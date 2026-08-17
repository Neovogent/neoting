import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, RotateCcw, Trash2, Send, Plus, ImageIcon, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import type { BusinessAccount } from '../../lib/types';

interface Page {
  id: string;
  dataUrl: string;
  bytes: number;
}

type CameraState = 'idle' | 'starting' | 'live' | 'error';

let pageSeq = 0;

const m = defineMessages({
  title: { id: 'portal.businessCaptureView.title', defaultMessage: 'Capture a document' },
  subtitleMultiPage: {
    id: 'portal.businessCaptureView.subtitleMultiPage',
    defaultMessage:
      'Lay the receipt flat and fill the frame. Multi-page is on — shoot each sheet, then send them as one document.',
  },
  subtitleSinglePage: {
    id: 'portal.businessCaptureView.subtitleSinglePage',
    defaultMessage: 'Lay the receipt flat and fill the frame. Each shot is sent as its own document.',
  },
  errorNoApi: {
    id: 'portal.businessCaptureView.errorNoApi',
    defaultMessage: 'This browser will not give a web page camera access. Use your camera app below instead.',
  },
  errorBlocked: {
    id: 'portal.businessCaptureView.errorBlocked',
    defaultMessage: 'Camera access was blocked. Allow it in your browser settings, or use your camera app below.',
  },
  errorNotFound: {
    id: 'portal.businessCaptureView.errorNotFound',
    defaultMessage: 'No camera found on this device. Use your camera app or upload a file instead.',
  },
  errorOther: {
    id: 'portal.businessCaptureView.errorOther',
    defaultMessage: 'The camera could not start ({reason}).',
  },
  errorUnknownReason: {
    id: 'portal.businessCaptureView.errorUnknownReason',
    defaultMessage: 'unknown error',
  },
  errorHeading: { id: 'portal.businessCaptureView.errorHeading', defaultMessage: 'Camera unavailable' },
  startingHeading: {
    id: 'portal.businessCaptureView.startingHeading',
    defaultMessage: 'Starting the camera…',
  },
  offHeading: { id: 'portal.businessCaptureView.offHeading', defaultMessage: 'Camera is off' },
  permissionNote: {
    id: 'portal.businessCaptureView.permissionNote',
    defaultMessage:
      'Your browser will ask permission. Nothing is recorded — a still is taken only when you press the shutter.',
  },
  retryAction: { id: 'portal.businessCaptureView.retryAction', defaultMessage: 'Try again' },
  startAction: { id: 'portal.businessCaptureView.startAction', defaultMessage: 'Turn on camera' },
  useCameraAppAction: {
    id: 'portal.businessCaptureView.useCameraAppAction',
    defaultMessage: 'Use camera app',
  },
  choosePhotoTitle: {
    id: 'portal.businessCaptureView.choosePhotoTitle',
    defaultMessage: 'Choose a photo instead',
  },
  shutterLabel: { id: 'portal.businessCaptureView.shutterLabel', defaultMessage: 'Take photo' },
  turnOffTitle: { id: 'portal.businessCaptureView.turnOffTitle', defaultMessage: 'Turn the camera off' },
  sentConfirmation: {
    id: 'portal.businessCaptureView.sentConfirmation',
    defaultMessage:
      'Sent to your accountant — {count, plural, one {# document} other {# documents}} on the way.',
  },
  pagesReady: {
    id: 'portal.businessCaptureView.pagesReady',
    defaultMessage: '{count, plural, one {# page ready} other {# pages ready}}',
  },
  totalSize: { id: 'portal.businessCaptureView.totalSize', defaultMessage: '{size}MB total' },
  totalSizeOneDocument: {
    id: 'portal.businessCaptureView.totalSizeOneDocument',
    defaultMessage: '{size}MB total · sending as one document',
  },
  clearAllAction: { id: 'portal.businessCaptureView.clearAllAction', defaultMessage: 'Clear all' },
  pageAlt: { id: 'portal.businessCaptureView.pageAlt', defaultMessage: 'Page {index}' },
  deletePageLabel: {
    id: 'portal.businessCaptureView.deletePageLabel',
    defaultMessage: 'Delete page {index}',
  },
  addPageAction: { id: 'portal.businessCaptureView.addPageAction', defaultMessage: 'Add page' },
  overLimitWarning: {
    id: 'portal.businessCaptureView.overLimitWarning',
    defaultMessage: 'This batch is over the {limit}MB limit — remove a page or send in two goes.',
  },
  sendAction: { id: 'portal.businessCaptureView.sendAction', defaultMessage: 'Send to accountant' },
  retakeAction: { id: 'portal.businessCaptureView.retakeAction', defaultMessage: 'Retake last' },
});

/**
 * Photograph a receipt straight into the pipeline. Uses the real camera where
 * the browser allows it and falls back to the device's own camera app
 * otherwise — a business on a locked-down phone still has to be able to send
 * something.
 */
export function BusinessCaptureView({ account }: { account: BusinessAccount }) {
  const { ingest } = useAppContext();
  const intl = useIntl();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<CameraState>('idle');
  const [error, setError] = useState('');
  const [pages, setPages] = useState<Page[]>([]);
  const [sentCount, setSentCount] = useState(0);
  const [flash, setFlash] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // The camera must be released when the business navigates away, otherwise the
  // recording indicator stays lit.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setState('starting');
    setError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(intl.formatMessage(m.errorNoApi));
      setState('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState('live');
    } catch (e) {
      const err = e as DOMException;
      setError(
        err.name === 'NotAllowedError'
          ? intl.formatMessage(m.errorBlocked)
          : err.name === 'NotFoundError'
            ? intl.formatMessage(m.errorNotFound)
            : intl.formatMessage(m.errorOther, {
                reason: err.name || intl.formatMessage(m.errorUnknownReason),
              }),
      );
      setState('error');
    }
  }, [intl]);

  const addPage = useCallback((dataUrl: string, bytes: number) => {
    setPages((prev) => [...prev, { id: `pg-${Date.now()}-${pageSeq++}`, dataUrl, bytes }]);
  }, []);

  const shoot = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    // base64 overhead stripped, so the size shown is the real payload size.
    const bytes = Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    addPage(dataUrl, bytes);
  }, [addPage]);

  const send = useCallback(
    (override?: Page[]) => {
      const batch = override ?? pages;
      if (!batch.length) return;

      const stamp = new Date().toISOString().slice(0, 10);
      const totalBytes = batch.reduce((sum, p) => sum + p.bytes, 0);

      // With multi-page on, the sheets are one document rather than several.
      const files =
        account.multiPageCapture && batch.length > 1
          ? [{ name: `capture-${stamp}-${batch.length}pages.jpg`, size: totalBytes }]
          : batch.map((p, i) => ({ name: `capture-${stamp}-${i + 1}.jpg`, size: p.bytes }));

      ingest(files, account.clientId, 'portal', {
        limit: PORTAL_UPLOAD_LIMIT,
        uploader: `${account.contactName} (camera capture)`,
      });

      setSentCount(files.length);
      setPages([]);
      setTimeout(() => setSentCount(0), 3200);
    },
    [pages, account, ingest],
  );

  // "Send as I shoot" skips the review step entirely.
  useEffect(() => {
    if (account.autoSubmitOnCapture && pages.length === 1) send(pages);
  }, [pages, account.autoSubmitOnCapture, send]);

  const totalMb = pages.reduce((s, p) => s + p.bytes, 0) / 1024 / 1024;
  const overLimit = totalMb * 1024 * 1024 > PORTAL_UPLOAD_LIMIT;

  return (
    <div className="p-8 max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">{intl.formatMessage(m.title)}</h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          {account.multiPageCapture
            ? intl.formatMessage(m.subtitleMultiPage)
            : intl.formatMessage(m.subtitleSinglePage)}
        </p>
      </div>

      <div className="relative rounded-[28px] overflow-hidden border border-white/5 bg-black aspect-[4/3] flex items-center justify-center">
        <video
          ref={videoRef}
          playsInline
          muted
          className={`w-full h-full object-cover ${state === 'live' ? '' : 'hidden'}`}
        />

        {/* Framing guides — only meaningful once there's a picture behind them. */}
        {state === 'live' && (
          <>
            <div className="pointer-events-none absolute inset-8 border-2 border-white/25 rounded-2xl" />
            <div className="pointer-events-none absolute inset-0 shadow-camera-vignette" />
          </>
        )}

        <AnimatePresence>
          {flash && (
            <motion.div
              initial={{ opacity: 0.85 }}
              animate={{ opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="absolute inset-0 bg-white"
            />
          )}
        </AnimatePresence>

        {state !== 'live' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
            <div className="w-14 h-14 rounded-2xl bg-raised border border-white/5 flex items-center justify-center text-zinc-300">
              {state === 'error' ? <CameraOff size={24} /> : <Camera size={24} />}
            </div>
            {state === 'error' ? (
              <>
                <p className="text-sm font-bold text-white mt-4">{intl.formatMessage(m.errorHeading)}</p>
                <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">{error}</p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-white mt-4">
                  {state === 'starting'
                    ? intl.formatMessage(m.startingHeading)
                    : intl.formatMessage(m.offHeading)}
                </p>
                <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">
                  {intl.formatMessage(m.permissionNote)}
                </p>
              </>
            )}
            <div className="flex items-center gap-2 mt-5">
              <button
                onClick={start}
                disabled={state === 'starting'}
                className="px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-50 transition-colors"
              >
                {state === 'error' ? intl.formatMessage(m.retryAction) : intl.formatMessage(m.startAction)}
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
              >
                {intl.formatMessage(m.useCameraAppAction)}
              </button>
            </div>
          </div>
        )}

        {/* Device camera fallback — this is what actually works on a locked-down phone. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = () => addPage(String(reader.result), file.size);
              reader.readAsDataURL(file);
            }
            e.target.value = '';
          }}
        />
      </div>

      {state === 'live' && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => fileRef.current?.click()}
            title={intl.formatMessage(m.choosePhotoTitle)}
            className="w-12 h-12 rounded-full border border-white/10 text-zinc-400 hover:text-white hover:border-white/25 flex items-center justify-center transition-colors"
          >
            <ImageIcon size={18} />
          </button>
          <button
            onClick={shoot}
            className="w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-shutter-halo active:scale-95 transition-transform"
            aria-label={intl.formatMessage(m.shutterLabel)}
          >
            <span className="w-16 h-16 rounded-full border-4 border-ground" />
          </button>
          <button
            onClick={() => {
              stop();
              setState('idle');
            }}
            title={intl.formatMessage(m.turnOffTitle)}
            className="w-12 h-12 rounded-full border border-white/10 text-zinc-400 hover:text-white hover:border-white/25 flex items-center justify-center transition-colors"
          >
            <CameraOff size={18} />
          </button>
        </div>
      )}

      <AnimatePresence>
        {sentCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-3 p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5"
          >
            <Check size={16} className="text-emerald-400 shrink-0" />
            <p className="text-[13px] font-semibold text-emerald-400">
              {intl.formatMessage(m.sentConfirmation, { count: sentCount })}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {pages.length > 0 && (
        <section className="rounded-[28px] border border-white/5 bg-card p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-[15px] font-bold text-white tracking-tight">
                {intl.formatMessage(m.pagesReady, { count: pages.length })}
              </h2>
              <p className="text-[12px] text-zinc-500 mt-1">
                {account.multiPageCapture && pages.length > 1
                  ? intl.formatMessage(m.totalSizeOneDocument, { size: totalMb.toFixed(1) })
                  : intl.formatMessage(m.totalSize, { size: totalMb.toFixed(1) })}
              </p>
            </div>
            <button
              onClick={() => setPages([])}
              className="text-[12px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              {intl.formatMessage(m.clearAllAction)}
            </button>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {pages.map((p, i) => (
              <div key={p.id} className="relative group rounded-2xl overflow-hidden border border-white/5 bg-black aspect-[3/4]">
                <img
                  src={p.dataUrl}
                  alt={intl.formatMessage(m.pageAlt, { index: i + 1 })}
                  className="w-full h-full object-cover"
                />
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] font-bold text-white">
                  {i + 1}
                </span>
                <button
                  onClick={() => setPages((prev) => prev.filter((x) => x.id !== p.id))}
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 text-zinc-300 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={intl.formatMessage(m.deletePageLabel, { index: i + 1 })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {state === 'live' && (
              <button
                onClick={shoot}
                className="rounded-2xl border-2 border-dashed border-white/10 hover:border-brand/50 aspect-[3/4] flex flex-col items-center justify-center text-zinc-500 hover:text-white transition-colors"
              >
                <Plus size={20} />
                <span className="text-[11px] font-bold mt-1">{intl.formatMessage(m.addPageAction)}</span>
              </button>
            )}
          </div>

          {overLimit && (
            <p className="text-[12px] text-amber-400 font-semibold mt-4">
              {intl.formatMessage(m.overLimitWarning, {
                limit: Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024),
              })}
            </p>
          )}

          <div className="flex items-center gap-2 mt-5">
            <button
              onClick={() => send()}
              disabled={overLimit}
              className="flex items-center gap-2 px-6 py-3 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn-strong"
            >
              <Send size={15} strokeWidth={2.5} />
              {intl.formatMessage(m.sendAction)}
            </button>
            <button
              onClick={() => setPages((prev) => prev.slice(0, -1))}
              className="flex items-center gap-2 px-5 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              <RotateCcw size={15} />
              {intl.formatMessage(m.retakeAction)}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
