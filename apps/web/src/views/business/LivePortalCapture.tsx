import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Check, ImageIcon, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import { compressImage, type CapturedPage } from '../../lib/capture';
import { currency } from '../../lib/resolver';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';
import { LapsedSubscriptionNotice } from './LapsedSubscriptionNotice';
import { monthName } from './LivePortalHome';
import { transactionIdFor, type PortalAsk } from './portalAsk';
import {
  CAMERA_CONSTRAINTS,
  cameraAvailability,
  cameraFaultFor,
  captureFilename,
  frameToPage,
  type CameraFault,
  type CameraState,
} from './portalCamera';
import { PORTAL_UPLOAD_LIMIT_MB } from './portalUploadRules';
import { PortalSendFaultNotice } from './PortalSendFaultNotice';
import type { PortalSendFault } from './portalSendFault';
import type { PortalSendOutcome } from './useBusinessPortalSession';

/**
 * Photograph a receipt straight into the pipeline — the phone-first heart of
 * the portal, and the one thing the live product had no equivalent of at all.
 *
 * ## Two lifecycle fixes that are load-bearing
 *
 * - **`track.onended` returns the view to `idle`.** iOS ends the track when the
 *   tab is backgrounded. Without this the view stays "live" over a frozen
 *   frame, and the shutter photographs the last thing the camera saw before the
 *   client took a phone call.
 * - **Every track is released on unmount.** Otherwise the recording indicator
 *   stays lit after the client has navigated away, on their own phone, on a
 *   page about their own money. That is not a cosmetic bug.
 *
 * ## The photograph is the real bytes, downscaled
 *
 * The prototype throws the picture away — it passes `{name, size}` to a
 * synthetic ingest. Here the frame is encoded through the same compressor a
 * picked file goes through (`lib/capture.ts`: JPEG 0.86, long edge 2200) and
 * the bytes go up the contracted three-call upload. A 12 MP photograph of a
 * till receipt is 4–8 MB and reads perfectly well at a tenth of that, which
 * matters on the connection this surface is actually used on.
 *
 * ## Nothing here promises an ask will close
 *
 * Starting from "Send it" puts the tapped `transactionId` on the upload, which
 * the server records — and then re-derives the match from the extraction
 * anyway. So the copy says what was sent and against what it was offered; the
 * ask goes to "Got it" when the server says so and not before.
 */

const m = defineMessages({
  title: { id: 'portal.livePortalCapture.title', defaultMessage: 'Capture a document' },
  subtitle: {
    id: 'portal.livePortalCapture.subtitle',
    defaultMessage:
      'Lay the receipt flat and fill the frame. Shoot as many as you like — each photo is sent as its own document.',
  },
  forItem: {
    id: 'portal.livePortalCapture.forItem',
    defaultMessage: 'For {merchant} · {amount} · {date}',
  },
  forStatement: {
    id: 'portal.livePortalCapture.forStatement',
    defaultMessage: 'For your {month} bank statement',
  },
  forUnnamed: { id: 'portal.livePortalCapture.forUnnamed', defaultMessage: 'a card payment' },
  // ⚠ Verified against the server: the declared transaction is recorded and
  // then the match is RE-DERIVED from the extraction. So this says what is
  // true — it is offered against that line — and never that it closes it.
  forNote: {
    id: 'portal.livePortalCapture.forNote',
    defaultMessage:
      'Your accountant checks it against what they asked for. The request stays open until it matches.',
  },
  clearAsk: { id: 'portal.livePortalCapture.clearAsk', defaultMessage: 'Send something else instead' },

  faultHeading: { id: 'portal.livePortalCapture.faultHeading', defaultMessage: 'Camera unavailable' },
  faultNoApi: {
    id: 'portal.livePortalCapture.faultNoApi',
    defaultMessage: 'This browser will not give a web page camera access. Use your camera app below instead.',
  },
  faultInsecure: {
    id: 'portal.livePortalCapture.faultInsecure',
    defaultMessage:
      'A browser only allows the camera on a secure address. Open this portal from your accountant’s link, or use your camera app below.',
  },
  faultBlocked: {
    id: 'portal.livePortalCapture.faultBlocked',
    defaultMessage: 'Camera access was blocked. Allow it in your browser settings, or use your camera app below.',
  },
  faultNotFound: {
    id: 'portal.livePortalCapture.faultNotFound',
    defaultMessage: 'No camera found on this device. Use your camera app or upload a file instead.',
  },
  faultInUse: {
    id: 'portal.livePortalCapture.faultInUse',
    defaultMessage:
      'Another app is using the camera. Close it and try again, or use your camera app below.',
  },
  faultConstraints: {
    id: 'portal.livePortalCapture.faultConstraints',
    defaultMessage:
      'This camera could not be started at the size we asked for. Use your camera app below instead.',
  },
  faultOther: {
    id: 'portal.livePortalCapture.faultOther',
    defaultMessage: 'The camera could not start. Use your camera app below instead.',
  },

  startingHeading: { id: 'portal.livePortalCapture.startingHeading', defaultMessage: 'Starting the camera…' },
  offHeading: { id: 'portal.livePortalCapture.offHeading', defaultMessage: 'Camera is off' },
  permissionNote: {
    id: 'portal.livePortalCapture.permissionNote',
    defaultMessage:
      'Your browser will ask permission. Nothing is recorded — a still is taken only when you press the shutter.',
  },
  retryAction: { id: 'portal.livePortalCapture.retryAction', defaultMessage: 'Try again' },
  startAction: { id: 'portal.livePortalCapture.startAction', defaultMessage: 'Turn on camera' },
  useCameraAppAction: { id: 'portal.livePortalCapture.useCameraAppAction', defaultMessage: 'Use camera app' },
  choosePhotoTitle: { id: 'portal.livePortalCapture.choosePhotoTitle', defaultMessage: 'Choose a photo instead' },
  shutterLabel: { id: 'portal.livePortalCapture.shutterLabel', defaultMessage: 'Take photo' },
  turnOffTitle: { id: 'portal.livePortalCapture.turnOffTitle', defaultMessage: 'Turn the camera off' },
  videoLabel: { id: 'portal.livePortalCapture.videoLabel', defaultMessage: 'Camera preview' },

  autoSendLabel: { id: 'portal.livePortalCapture.autoSendLabel', defaultMessage: 'Send as I shoot' },
  autoSendHint: {
    id: 'portal.livePortalCapture.autoSendHint',
    defaultMessage: 'Each photo goes straight to your accountant, with no review step. For this visit only.',
  },

  sentConfirmation: {
    id: 'portal.livePortalCapture.sentConfirmation',
    defaultMessage: 'Sent to your accountant — {count, plural, one {# document} other {# documents}} on the way.',
  },
  pagesReady: {
    id: 'portal.livePortalCapture.pagesReady',
    defaultMessage: '{count, plural, one {# photo ready} other {# photos ready}}',
  },
  totalSize: {
    id: 'portal.livePortalCapture.totalSize',
    defaultMessage: '{size}MB in total · each one is sent as its own document',
  },
  clearAllAction: { id: 'portal.livePortalCapture.clearAllAction', defaultMessage: 'Clear all' },
  pageAlt: { id: 'portal.livePortalCapture.pageAlt', defaultMessage: 'Photo {index}' },
  deletePageLabel: { id: 'portal.livePortalCapture.deletePageLabel', defaultMessage: 'Delete photo {index}' },
  addPageAction: { id: 'portal.livePortalCapture.addPageAction', defaultMessage: 'Add photo' },
  overLimitWarning: {
    id: 'portal.livePortalCapture.overLimitWarning',
    defaultMessage: 'One of these is over the {limit}MB limit — delete it and photograph it again, closer in.',
  },
  sendAction: { id: 'portal.livePortalCapture.sendAction', defaultMessage: 'Send to accountant' },
  sendingAction: { id: 'portal.livePortalCapture.sendingAction', defaultMessage: 'Sending…' },
  retakeAction: { id: 'portal.livePortalCapture.retakeAction', defaultMessage: 'Delete the last one' },
  // ⚠ "try again" is GONE from this headline, and its removal is the point of
  // the change. It is the right advice for exactly one of the reasons below and
  // actively wrong for three of them — a client whose subscription has lapsed
  // can press the button all afternoon. The headline now says only what is
  // true of every case (the photographs are safe), and the reason says what to
  // do about it.
  sendFault: {
    id: 'portal.livePortalCapture.sendFault',
    defaultMessage:
      '{count, plural, one {# photo did not send} other {# photos did not send}} — they are still here.',
  },
});

/** Keyed by the machine fault — only the sentence is copy. */
const FAULT: Record<CameraFault, MessageDescriptor> = {
  'no-api': m.faultNoApi,
  insecure: m.faultInsecure,
  blocked: m.faultBlocked,
  'not-found': m.faultNotFound,
  'in-use': m.faultInUse,
  'unsupported-constraints': m.faultConstraints,
  other: m.faultOther,
};

interface Page extends CapturedPage {
  readonly id: string;
}

let pageSeq = 0;

export function LivePortalCapture({
  ask,
  subscriptionActive,
  busy,
  onSend,
  onClearAsk,
  onSubscribe,
}: {
  readonly ask: PortalAsk | null;
  readonly subscriptionActive: boolean;
  readonly busy: boolean;
  readonly onSend: (page: CapturedPage, transactionId: string | null) => Promise<PortalSendOutcome>;
  readonly onClearAsk: () => void;
  readonly onSubscribe: () => void;
}) {
  const intl = useIntl();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraFileRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<CameraState>('idle');
  const [fault, setFault] = useState<CameraFault | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [sentCount, setSentCount] = useState(0);
  // The faults themselves, not a count of them. A count is what produced
  // "2 photos did not send" over four unrelated problems.
  const [failures, setFailures] = useState<readonly PortalSendFault[]>([]);
  const [flash, setFlash] = useState(false);
  // Session-only, and the hint says so. There is no server setting behind this
  // and there must not be a control pretending otherwise — but a preference
  // that takes effect immediately and dies with the tab is not a write that
  // anything can revert, so it belongs here rather than in Settings.
  const [autoSend, setAutoSend] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  // ⚠ Release the camera when the client navigates away, or the recording
  // indicator stays lit on their phone after they have left this screen.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setFault(null);

    const availability = cameraAvailability();
    if (availability !== 'ok') {
      setFault(availability);
      setState('error');
      return;
    }

    setState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      streamRef.current = stream;
      // ⚠ iOS ends the track when the tab is backgrounded, and the view would
      // otherwise sit on a frozen frame calling itself live.
      stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          stop();
          setState('idle');
        });
      });
      if (videoRef.current !== null) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState('live');
    } catch (error) {
      stop();
      setFault(cameraFaultFor(error));
      setState('error');
    }
  }, [stop]);

  const addPage = useCallback((page: CapturedPage) => {
    pageSeq += 1;
    setPages((prev) => [...prev, { ...page, id: `pg-${Date.now()}-${pageSeq}` }]);
  }, []);

  const sendBatch = useCallback(
    async (batch: readonly Page[]) => {
      if (batch.length === 0) return;
      const transactionId = transactionIdFor(ask);
      let sent = 0;
      const survivors: Page[] = [];
      const faults: PortalSendFault[] = [];
      for (const page of batch) {
        const outcome = await onSend(page, transactionId);
        if (outcome.ok) sent += 1;
        else {
          survivors.push(page);
          if (outcome.fault !== null) faults.push(outcome.fault);
        }
      }
      // Only what actually failed stays in the tray. Clearing everything on a
      // partial failure would lose photographs the client took; keeping
      // everything would send the successful ones twice.
      setPages((prev) => prev.filter((p) => survivors.some((s) => s.id === p.id)));
      setSentCount(sent);
      setFailures(faults);
    },
    [ask, onSend],
  );

  const shoot = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    const page = frameToPage(video, document.createElement('canvas'), captureFilename(pageSeq + 1));
    // Null means the video has no frame yet — nothing is added, because a
    // blank JPEG offered as a receipt is worse than a shutter that did nothing.
    if (page === null) return;

    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);

    if (autoSend) {
      pageSeq += 1;
      void sendBatch([{ ...page, id: `pg-${Date.now()}-${pageSeq}` }]);
      return;
    }
    addPage(page);
  }, [addPage, autoSend, sendBatch]);

  const totalMb = pages.reduce((sum, p) => sum + p.blob.size, 0) / 1024 / 1024;
  const overLimit = pages.some((p) => p.blob.size / 1024 / 1024 > PORTAL_UPLOAD_LIMIT_MB);

  if (!subscriptionActive) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto flex flex-col gap-6 pb-safe-6">
        <Heading ask={ask} onClearAsk={onClearAsk} />
        {/* ⚠ D48 — before the camera, never after the photograph. */}
        <LapsedSubscriptionNotice onSubscribe={onSubscribe} busy={busy} />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto flex flex-col gap-6 pb-safe-6">
      <Heading ask={ask} onClearAsk={onClearAsk} />

      <div
        data-tour="portal-capture"
        className="relative rounded-[28px] overflow-hidden border border-white/5 bg-black aspect-[3/4] sm:aspect-[4/3] max-h-[70dvh] mx-auto w-full flex items-center justify-center"
      >
        <video
          ref={videoRef}
          playsInline
          muted
          aria-label={intl.formatMessage(m.videoLabel)}
          className={`w-full h-full object-cover ${state === 'live' ? '' : 'hidden'}`}
        />

        {/* Framing guides — only meaningful once there is a picture behind them. */}
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
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4 md:p-8">
            <div className="w-14 h-14 rounded-2xl bg-raised border border-white/5 flex items-center justify-center text-zinc-300">
              {state === 'error' ? <CameraOff size={24} /> : <Camera size={24} />}
            </div>
            {state === 'error' && fault !== null ? (
              <>
                <p className="text-sm font-bold text-white mt-4">{intl.formatMessage(m.faultHeading)}</p>
                <p role="alert" className="text-[12px] text-zinc-400 mt-1.5 max-w-sm leading-relaxed">
                  {intl.formatMessage(FAULT[fault])}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-white mt-4">
                  {state === 'starting' ? intl.formatMessage(m.startingHeading) : intl.formatMessage(m.offHeading)}
                </p>
                <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">
                  {intl.formatMessage(m.permissionNote)}
                </p>
              </>
            )}
            <div className="flex items-center gap-2 mt-5 flex-wrap justify-center">
              <button
                onClick={() => void start()}
                disabled={state === 'starting'}
                className="px-5 py-2.5 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-50 transition-colors"
              >
                {state === 'error' ? intl.formatMessage(m.retryAction) : intl.formatMessage(m.startAction)}
              </button>
              <button
                onClick={() => cameraFileRef.current?.click()}
                className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
              >
                {intl.formatMessage(m.useCameraAppAction)}
              </button>
            </div>
          </div>
        )}

        {/* ⚠ The device camera fallback. This is what actually works on a
            locked-down phone, and it is why every camera failure above points
            at it rather than dead-ending. The picked photograph goes through
            the SAME compressor a live frame does. */}
        <input
          ref={cameraFileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file === undefined) return;
            void compressImage(file).then((page) => {
              if (autoSend) {
                pageSeq += 1;
                void sendBatch([{ ...page, id: `pg-${Date.now()}-${pageSeq}` }]);
                return;
              }
              addPage(page);
            });
          }}
        />
      </div>

      {state === 'live' && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => cameraFileRef.current?.click()}
            title={intl.formatMessage(m.choosePhotoTitle)}
            aria-label={intl.formatMessage(m.choosePhotoTitle)}
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
            aria-label={intl.formatMessage(m.turnOffTitle)}
            className="w-12 h-12 rounded-full border border-white/10 text-zinc-400 hover:text-white hover:border-white/25 flex items-center justify-center transition-colors"
          >
            <CameraOff size={18} />
          </button>
        </div>
      )}

      <button
        onClick={() => setAutoSend((v) => !v)}
        aria-pressed={autoSend}
        className="bg-card border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 hover:border-white/10 transition-colors text-left"
      >
        <span>
          <span className="block text-sm font-bold text-white">{intl.formatMessage(m.autoSendLabel)}</span>
          <span className="block text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.autoSendHint)}</span>
        </span>
        <span
          className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${autoSend ? 'bg-brand' : 'bg-white/10'}`}
        >
          <span
            className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${autoSend ? 'left-6' : 'left-1'}`}
          />
        </span>
      </button>

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

      <PortalSendFaultNotice failures={failures} headline={m.sendFault} onSubscribe={onSubscribe} busy={busy} />

      {pages.length > 0 && (
        <section className="rounded-[28px] border border-white/5 bg-card p-5 md:p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-[15px] font-bold text-white tracking-tight">
                {intl.formatMessage(m.pagesReady, { count: pages.length })}
              </h2>
              <p className="text-[12px] text-zinc-500 mt-1">
                {intl.formatMessage(m.totalSize, { size: totalMb.toFixed(1) })}
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
              <div
                key={p.id}
                className="relative group rounded-2xl overflow-hidden border border-white/5 bg-black aspect-[3/4]"
              >
                {/* A browser that would not decode the picture returns the
                    original bytes and no preview — the photograph still sends,
                    only the thumbnail is lost, and a broken <img> would look
                    like a lost receipt. */}
                {p.dataUrl === '' ? (
                  <span className="w-full h-full flex items-center justify-center text-zinc-500">
                    <ImageIcon size={22} />
                  </span>
                ) : (
                  <img
                    src={p.dataUrl}
                    alt={intl.formatMessage(m.pageAlt, { index: i + 1 })}
                    className="w-full h-full object-cover"
                  />
                )}
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] font-bold text-white">
                  {i + 1}
                </span>
                <button
                  onClick={() => setPages((prev) => prev.filter((x) => x.id !== p.id))}
                  className="absolute top-1.5 right-1.5 w-8 h-8 rounded-full bg-black/70 text-zinc-200 hover:text-white flex items-center justify-center transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
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
            <p role="alert" className="text-[12px] text-amber-400 font-semibold mt-4">
              {intl.formatMessage(m.overLimitWarning, { limit: PORTAL_UPLOAD_LIMIT_MB })}
            </p>
          )}

          <div className="flex items-center gap-2 mt-5 flex-wrap">
            <button
              onClick={() => void sendBatch(pages)}
              disabled={overLimit || busy}
              className="flex-1 sm:flex-none justify-center flex items-center gap-2 px-6 py-3 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn-strong"
            >
              <Send size={15} strokeWidth={2.5} />
              {busy ? intl.formatMessage(m.sendingAction) : intl.formatMessage(m.sendAction)}
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

function Heading({ ask, onClearAsk }: { ask: PortalAsk | null; onClearAsk: () => void }) {
  const intl = useIntl();
  return (
    <div>
      <h1 className="font-sans text-2xl font-bold text-white tracking-tight">{intl.formatMessage(m.title)}</h1>
      <p className="text-[13px] text-zinc-500 mt-1">{intl.formatMessage(m.subtitle)}</p>
      {ask !== null && (
        <div className="mt-3 rounded-2xl border border-brand/25 bg-brand/[0.07] p-4">
          <p className="text-[13px] text-brand font-semibold">
            {ask.kind === 'statement'
              ? intl.formatMessage(m.forStatement, { month: monthName(intl, ask.period) })
              : intl.formatMessage(m.forItem, {
                  merchant: ask.label ?? intl.formatMessage(m.forUnnamed),
                  amount: currency(Math.abs(ask.amount)),
                  date: ask.date,
                })}
          </p>
          <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">{intl.formatMessage(m.forNote)}</p>
          <button
            onClick={onClearAsk}
            className="mt-2 text-[12px] font-bold text-zinc-500 hover:text-white transition-colors"
          >
            {intl.formatMessage(m.clearAsk)}
          </button>
        </div>
      )}
      {/* The camera is an upload control too — UK GDPR Art. 13 wants the
          privacy notice where the collecting happens. */}
      <PrivacyNoticeLink className="mt-2" />
    </div>
  );
}
