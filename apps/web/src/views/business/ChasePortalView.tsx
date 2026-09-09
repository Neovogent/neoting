import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Camera, Check, FileText, Loader2, ShieldCheck, Smartphone, Upload,
} from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';
import type { PortalItem, PortalStatementRequest, PortalView } from '../../api/portal';
import { useAppContext } from '../../context/AppContext';
import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import { compressImage } from '../../lib/capture';
import type { CapturedPage } from '../../lib/capture';
import { currency } from '../../lib/resolver';
import { navigate, path } from '../../lib/router';
import { PORTAL_ACCEPT } from './portalUploadRules';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';
import { usePortalJourney } from './usePortalJourney';
import type { PortalFault, UploadOutcome } from './usePortalJourney';

const m = defineMessages({
  shellSubtitle: { id: 'portal.chasePortal.shellSubtitle', defaultMessage: 'No app · no password' },

  linkTitle: { id: 'portal.chasePortal.linkTitle', defaultMessage: 'Open your secure link' },
  linkDetail: {
    id: 'portal.chasePortal.linkDetail',
    defaultMessage:
      'Your accountant emailed you a link. Tap it on your phone, or paste the code from the end of it here.',
  },
  linkLabel: { id: 'portal.chasePortal.linkLabel', defaultMessage: 'Code from the email' },
  linkPlaceholder: { id: 'portal.chasePortal.linkPlaceholder', defaultMessage: 'Paste the whole link or just its code' },
  linkAction: { id: 'portal.chasePortal.linkAction', defaultMessage: 'Continue' },

  // ── The step that opens the session (item 4, 8 Sep 2026). The eight
  // `otpRequest*` / `otpLabel` / `otpPlaceholder` / `otpAction` / `otpDetail`
  // ids retired with the code entry; `otpAudit` stays, reworded, because the
  // sentence about the session being logged is still true and is the one thing
  // a client should know about what opening this page records.
  openingTitle: { id: 'portal.chasePortal.openingTitle', defaultMessage: 'Opening your uploads' },
  openingDetail: {
    id: 'portal.chasePortal.openingDetail',
    defaultMessage: 'Checking your link — this takes a moment.',
  },
  openingFailedTitle: { id: 'portal.chasePortal.openingFailedTitle', defaultMessage: 'That link did not open' },
  openingRetry: { id: 'portal.chasePortal.openingRetry', defaultMessage: 'Try again' },
  otpAudit: {
    id: 'portal.chasePortal.otpAudit',
    defaultMessage:
      'Your link is checked on our servers, and the session is logged — who the link was sent to and who used it are recorded separately.',
  },

  itemsTitle: { id: 'portal.chasePortal.itemsTitle', defaultMessage: 'What we need from you' },
  itemsDetail: {
    id: 'portal.chasePortal.itemsDetail',
    defaultMessage:
      '{count, plural, one {One payment with no paperwork behind it} other {# payments with no paperwork behind them}}. Pick one and send us the receipt or invoice.',
  },
  itemsAllDone: {
    id: 'portal.chasePortal.itemsAllDone',
    defaultMessage: 'That is everything — nothing is outstanding. You can close this page.',
  },
  itemUnnamed: { id: 'portal.chasePortal.itemUnnamed', defaultMessage: 'Card payment' },
  itemReceived: { id: 'portal.chasePortal.itemReceived', defaultMessage: 'Got it' },
  itemSendAction: { id: 'portal.chasePortal.itemSendAction', defaultMessage: 'Send this one' },
  statementLabel: { id: 'portal.chasePortal.statementLabel', defaultMessage: '{month} bank statement' },
  statementHint: {
    id: 'portal.chasePortal.statementHint',
    defaultMessage: 'A photo of each page works, or the PDF from your banking app.',
  },
  captureForStatement: {
    id: 'portal.chasePortal.captureForStatement',
    defaultMessage: 'For your {month} bank statement',
  },
  itemsExpiry: {
    id: 'portal.chasePortal.itemsExpiry',
    defaultMessage: 'This page signs you out at {time} on {date}. Your link keeps working — open it again any time.',
  },

  captureTitle: { id: 'portal.chasePortal.captureTitle', defaultMessage: 'Send the paperwork' },
  captureFor: { id: 'portal.chasePortal.captureFor', defaultMessage: 'For {merchant} · {amount} · {date}' },
  captureHint: {
    id: 'portal.chasePortal.captureHint',
    defaultMessage:
      'Lay it flat and fill the frame. The picture is shrunk on your phone before it is sent, so this works on a bad signal.',
  },
  capturePhotoAction: { id: 'portal.chasePortal.capturePhotoAction', defaultMessage: 'Take photo' },
  captureFileAction: { id: 'portal.chasePortal.captureFileAction', defaultMessage: 'Upload file' },
  capturePreviewAlt: { id: 'portal.chasePortal.capturePreviewAlt', defaultMessage: 'The document you are about to send' },
  captureSize: { id: 'portal.chasePortal.captureSize', defaultMessage: '{name} · {size}MB' },
  captureRetake: { id: 'portal.chasePortal.captureRetake', defaultMessage: 'Choose a different one' },
  captureSendAction: { id: 'portal.chasePortal.captureSendAction', defaultMessage: 'Send to my accountant' },
  captureTooBig: {
    id: 'portal.chasePortal.captureTooBig',
    defaultMessage: 'That file is over the {limit}MB limit, even after shrinking. Try photographing it instead.',
  },
  captureUnreadable: {
    id: 'portal.chasePortal.captureUnreadable',
    defaultMessage: 'We could not read that file. Try a photo, a PDF, or a screenshot.',
  },

  uploadingTitle: { id: 'portal.chasePortal.uploadingTitle', defaultMessage: 'Sending' },
  uploadingDetail: {
    id: 'portal.chasePortal.uploadingDetail',
    defaultMessage: 'Sending the file, then reading it. This takes a few seconds — keep this page open until it finishes.',
  },

  matchedTitle: { id: 'portal.chasePortal.matchedTitle', defaultMessage: 'That is the one' },
  matchedDetail: {
    id: 'portal.chasePortal.matchedDetail',
    defaultMessage:
      'It matches the {merchant} payment of {amount} on {date}, so that request is closed. Your accountant has it.',
  },
  unmatchedTitle: { id: 'portal.chasePortal.unmatchedTitle', defaultMessage: 'Not quite the one we need' },
  // The honest title when the pipeline has not answered yet — never
  // `unmatchedTitle`, which asserts a verdict the server did not give.
  pendingTitle: { id: 'portal.chasePortal.pendingTitle', defaultMessage: 'Sent — we are still reading it' },
  // A REFUSAL, which is neither of the two above: the server has actually said
  // "not that". It gets its own title so the screen never borrows the hedged
  // pending copy for a verdict that is certain (owner ruling, 9 Sep 2026).
  refusedTitle: { id: 'portal.chasePortal.refusedTitle', defaultMessage: 'That is not what we asked for' },
  // The SMS lane's code step (9 Sep 2026). Only ever reached when the server
  // says so; the email lane never sees it.
  codeTitle: { id: 'portal.chasePortal.codeTitle', defaultMessage: 'Enter the code we texted you' },
  codeDetail: {
    id: 'portal.chasePortal.codeDetail',
    defaultMessage:
      'This link came by text, so we need the six-digit code as well. We have just sent it to the number your accountant has on file.',
  },
  codeLabel: { id: 'portal.chasePortal.codeLabel', defaultMessage: 'Six-digit code' },
  codeAction: { id: 'portal.chasePortal.codeAction', defaultMessage: 'Open my list' },
  failedTitle: { id: 'portal.chasePortal.failedTitle', defaultMessage: 'That did not send' },
  unmatchedDetail: {
    id: 'portal.chasePortal.unmatchedDetail',
    defaultMessage:
      'Your accountant has this document — nothing is lost. But it does not look like the {merchant} payment of {amount} on {date}, so we are still asking for that one.',
  },
  unmatchedDetailNoItem: {
    id: 'portal.chasePortal.unmatchedDetailNoItem',
    defaultMessage:
      'Your accountant has this document — nothing is lost. It has not been matched to one of the payments above yet.',
  },
  sentPanelTitle: { id: 'portal.chasePortal.sentPanelTitle', defaultMessage: 'What you sent' },
  sentPanelReadOnly: {
    id: 'portal.chasePortal.sentPanelReadOnly',
    defaultMessage:
      'Your accountant reads the figures off this and corrects anything that is wrong — there is nothing for you to type.',
  },
  backToItemsAction: { id: 'portal.chasePortal.backToItemsAction', defaultMessage: 'Back to the list' },
  tryAgainAction: { id: 'portal.chasePortal.tryAgainAction', defaultMessage: 'Send a different one' },
  failedAgainAction: { id: 'portal.chasePortal.failedAgainAction', defaultMessage: 'Try again' },

  faultOtp: {
    id: 'portal.chasePortal.faultOtp',
    defaultMessage: 'That link or code did not work. Check the six digits in your email, or ask for a new link.',
  },
  faultSession: {
    id: 'portal.chasePortal.faultSession',
    defaultMessage: 'This page has been open too long. Open the link in your email again.',
  },
  faultUnreachable: {
    id: 'portal.chasePortal.faultUnreachable',
    defaultMessage: 'We could not reach your accountant’s system. Check your signal and try again.',
  },
  faultRefused: {
    id: 'portal.chasePortal.faultRefused',
    defaultMessage:
      'Something went wrong at your accountant’s end. Try again in a moment — if it keeps happening, tell them and quote the reference below.',
  },
  // ⚠ The two `NT-ING-` codes are the file, not the system, and they are
  // PERMANENT. Sending a client back to "try again in a moment" for either one
  // is a loop with no exit — it is what an iPhone photograph got until
  // 9 Sep 2026 — so each says what to send instead.
  faultFileType: {
    id: 'portal.chasePortal.faultFileType',
    defaultMessage:
      'We cannot read that kind of file. Take a photo of it instead, or send a PDF or a screenshot.',
  },
  faultFileTooBig: {
    id: 'portal.chasePortal.faultFileTooBig',
    defaultMessage:
      'That file is too big to send. Photographing it is usually much smaller than the original.',
  },
  faultCode: { id: 'portal.chasePortal.faultCode', defaultMessage: 'Reference {code}' },

  exitAction: { id: 'portal.chasePortal.exitAction', defaultMessage: 'Back to the practice app' },
  syntheticNote: {
    id: 'portal.chasePortal.syntheticNote',
    defaultMessage: 'Demo data — this build is not talking to a server.',
  },
});

/**
 * The no-app client journey: emailed link → six digits → the items being chased →
 * a photograph → the pipeline's answer.
 *
 * This is a different surface from `BusinessPortal`, deliberately. That one is
 * an account a business signs into and can browse. This one has no account, no
 * password and no browsing: a delegated session that may see exactly the items
 * one chase asked for, and may add documents to them. Everything on screen is
 * either something the client was asked for or something they just sent.
 *
 * ⚠ THE EXTRACTION OVERLAY IS READ-ONLY, AND NOT BY CHOICE. SoT Stage 8.4 wants
 * the client to correct a misread figure here. There is no contracted operation
 * that lets a portal bearer *read* an extraction, let alone write a correction:
 * `openapi.yaml` puts `portalSession` on three operations only — create session,
 * context, create upload — plus the shared completion endpoint. Inventing a
 * fourth is a contract change (G7), and guessing at the figures locally would
 * put numbers on screen that no server ever said. So the panel below shows what
 * the client actually sent and says who reads it. The gap is recorded in
 * `apps/web/CLAUDE.md` and in `packages/contracts/CLAUDE.md`'s own pass-3 list.
 */
/**
 * `PortalView.expiresAt` → the two parts the sign-out sentence needs.
 *
 * ⚠ It is the SESSION's expiry — its own field comment in `api/portal.ts` says
 * so — and this line used to render `expiresAt.slice(0, 10)` under the words
 * *"This page closes itself on {date}"*. Truncating to a date threw away the
 * only part that made it meaningful and left a client reading that their LINK
 * died today, hours after we emailed it: found live on 8 Sep 2026, where the
 * token was good for a week and the page announced the day it was sent. The
 * time is what makes it legible as a sign-out clock rather than a link
 * lifetime, and the sentence now says which of the two it is.
 *
 * Europe/London, not UTC: this is a wall-clock time a person compares against
 * the clock on their own phone.
 */
export function sessionExpiryParts(iso: string): { time: string; date: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { time: iso, date: iso };
  const opts = { timeZone: 'Europe/London' } as const;
  return {
    time: new Intl.DateTimeFormat('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' }).format(at),
    date: new Intl.DateTimeFormat('en-GB', { ...opts, day: 'numeric', month: 'long', year: 'numeric' }).format(at),
  };
}

export function ChasePortalView() {
  const { portalLinkToken, exitBusinessPortal } = useAppContext();
  const intl = useIntl();
  const journey = usePortalJourney(portalLinkToken);

  const [picked, setPicked] = useState<PortalItem | null>(null);
  const [pickedStatement, setPickedStatement] = useState<PortalStatementRequest | null>(null);
  const [page, setPage] = useState<CapturedPage | null>(null);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);

  const send = useCallback(async () => {
    if (!page) return;
    setOutcome(await journey.upload(page, picked?.transactionId ?? null));
  }, [journey, page, picked]);

  const restart = useCallback(() => {
    setOutcome(null);
    setPage(null);
    setPicked(null);
    setPickedStatement(null);
    journey.clearFault();
  }, [journey]);

  if (!portalLinkToken) return <LinkEntry onExit={exitBusinessPortal} />;

  if (!journey.view) {
    return <OpeningStep journey={journey} onExit={exitBusinessPortal} />;
  }

  if (journey.busy && page) return <Sending />;

  if (outcome) {
    return <Result outcome={outcome} page={page} onAgain={restart} onExit={exitBusinessPortal} />;
  }

  if (picked || pickedStatement || page) {
    return (
      <Capture
        item={picked}
        statementMonth={pickedStatement === null ? null : monthLabel(intl, pickedStatement.period)}
        page={page}
        onPage={setPage}
        onSend={send}
        onBack={restart}
        fault={journey.fault}
      />
    );
  }

  return (
    <Shell title={intl.formatMessage(m.itemsTitle)} subtitle={journey.view.businessName}>
      <ItemList view={journey.view} onPick={setPicked} onPickStatement={setPickedStatement} live={journey.live} />
      <ExitButton onClick={exitBusinessPortal} />
    </Shell>
  );
}

/** `2026-07` → the client's own month name, in their locale. */
function monthLabel(intl: ReturnType<typeof useIntl>, period: string): string {
  return intl.formatDate(new Date(`${period}-01T12:00:00.000Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* ── ① the link ───────────────────────────────────────────────────────────── */

function LinkEntry({ onExit }: { onExit: () => void }) {
  const intl = useIntl();
  const [value, setValue] = useState('');
  // The client may paste the whole emailed link or just the code at the end of it;
  // both carry the same token, so the last path segment is what is kept.
  const token = value.trim().split(/[?#]/)[0]?.split('/').filter(Boolean).pop() ?? '';

  return (
    <Shell title={intl.formatMessage(m.linkTitle)}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.linkDetail)}</p>
      <div>
        <label htmlFor="portal-link" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          {intl.formatMessage(m.linkLabel)}
        </label>
        <input
          id="portal-link"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && navigate(path('p', token))}
          placeholder={intl.formatMessage(m.linkPlaceholder)}
          className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
        />
      </div>
      <button
        onClick={() => token && navigate(path('p', token))}
        disabled={!token}
        className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
      >
        {intl.formatMessage(m.linkAction)}
        <ArrowRight size={16} strokeWidth={2.5} />
      </button>
      <ExitButton onClick={onExit} />
    </Shell>
  );
}

/* ── ② opening the session ────────────────────────────────────────────────── */

/**
 * The step that used to ask for six digits (item 4, 8 Sep 2026).
 *
 * > *"If a user lands from the email to submit a document, the system asks
 * > again for an email OTP — bad UX. Remove it."*
 *
 * He is right, and the security argument agrees with him: in this release the
 * chase travels by EMAIL, and the code was emailed to the same address as the
 * link. Two secrets in one inbox is one factor asked for twice. What protects
 * the session is what always did the work — the link is an HMAC over the chase
 * id with its own expiry, it is sent only to the chase's registered contact
 * (D45), and the session it opens can touch nothing but the items that one
 * chase asked for.
 *
 * So the client lands and the page opens itself. What is left here is the two
 * honest states that remain: opening, and could-not-open with a way to retry.
 */
function OpeningStep({
  journey,
  onExit,
}: {
  journey: ReturnType<typeof usePortalJourney>;
  onExit: () => void;
}) {
  const intl = useIntl();
  // Runs ONCE per mounted link. A ref rather than a dependency-free effect
  // because StrictMode mounts twice in development, and a second `verify` would
  // open a second session for the same link.
  const opened = useRef(false);
  const [code, setCode] = useState('');
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void journey.verify();
  }, [journey]);

  // The SMS lane. `needsCode` is set only by the server's NT-OTP-003, and it is
  // NOT a fault — nothing went wrong, there is one more thing to type — so this
  // branch comes first and shows no fault box.
  if (journey.needsCode) {
    return (
      <Shell title={intl.formatMessage(m.codeTitle)}>
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.codeDetail)}</p>
        <label className="block">
          <span className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(m.codeLabel)}
          </span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            className="w-full px-4 py-3.5 rounded-2xl bg-card border border-white/5 text-white text-[20px] tracking-[0.4em] text-center tabular-nums focus:border-brand/40 outline-none"
          />
        </label>
        {journey.fault && <Fault fault={journey.fault} />}
        <button
          onClick={() => void journey.verify(code)}
          disabled={journey.busy || code.length !== 6}
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
        >
          {journey.busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} strokeWidth={2.5} />}
          {intl.formatMessage(m.codeAction)}
        </button>
        <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.otpAudit)}</p>
        <ExitButton onClick={onExit} />
      </Shell>
    );
  }

  return (
    <Shell title={intl.formatMessage(journey.fault ? m.openingFailedTitle : m.openingTitle)}>
      {journey.fault ? (
        <>
          <Fault fault={journey.fault} />
          <button
            onClick={() => void journey.verify()}
            disabled={journey.busy}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
          >
            {journey.busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} strokeWidth={2.5} />}
            {intl.formatMessage(m.openingRetry)}
          </button>
        </>
      ) : (
        <p className="flex items-center gap-3 text-[14px] text-zinc-400 leading-relaxed">
          <Loader2 size={16} className="animate-spin shrink-0 text-brand" />
          {intl.formatMessage(m.openingDetail)}
        </p>
      )}
      <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.otpAudit)}</p>
      <ExitButton onClick={onExit} />
    </Shell>
  );
}

/* ── ③ the items ──────────────────────────────────────────────────────────── */

function ItemList({
  view,
  onPick,
  onPickStatement,
  live,
}: {
  view: PortalView;
  onPick: (item: PortalItem) => void;
  onPickStatement: (request: PortalStatementRequest) => void;
  live: boolean;
}) {
  const intl = useIntl();
  const outstanding = view.items.filter((i) => !i.received);
  const outstandingStatements = view.statementRequests.filter((r) => !r.received);

  return (
    <>
      <p className="text-[14px] text-zinc-400 leading-relaxed">
        {outstanding.length === 0 && outstandingStatements.length === 0
          ? intl.formatMessage(m.itemsAllDone)
          : outstanding.length === 0
            ? intl.formatMessage(m.statementHint)
            : intl.formatMessage(m.itemsDetail, { count: outstanding.length })}
      </p>

      <div className="flex flex-col gap-2.5">
        {/* Statement requests first — one card per asked month (engine (c)). */}
        {view.statementRequests.map((request) => (
          <button
            key={`stmt-${request.period}`}
            onClick={() => onPickStatement(request)}
            disabled={request.received}
            className="w-full text-left p-4 rounded-2xl bg-card border border-white/5 hover:border-brand/40 disabled:opacity-50 disabled:hover:border-white/5 transition-colors flex items-center justify-between gap-4"
          >
            <span className="min-w-0">
              <span className="block text-[15px] font-bold text-white truncate">
                {intl.formatMessage(m.statementLabel, { month: monthLabel(intl, request.period) })}
              </span>
              {/* A refusal outlives the upload screen. A client who sent the
                  wrong thing and closed the tab comes back to this list, and
                  without the reason here the row just says "send your
                  statement" again with no hint that they already tried. The
                  server's own sentence, verbatim. */}
              {request.refusedMessage !== null ? (
                <span className="block text-[12.5px] text-amber-400 mt-1">{request.refusedMessage}</span>
              ) : (
                <span className="block text-[12.5px] text-zinc-500 mt-1">{intl.formatMessage(m.statementHint)}</span>
              )}
            </span>
            <span className="shrink-0 text-[12px] font-bold">
              {request.received ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <Check size={14} strokeWidth={3} />
                  {intl.formatMessage(m.itemReceived)}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-brand">
                  {intl.formatMessage(m.itemSendAction)}
                  <ArrowRight size={14} strokeWidth={2.5} />
                </span>
              )}
            </span>
          </button>
        ))}
        {view.items.map((item) => (
          <button
            key={item.transactionId}
            onClick={() => onPick(item)}
            disabled={item.received}
            className="w-full text-left p-4 rounded-2xl bg-card border border-white/5 hover:border-brand/40 disabled:opacity-50 disabled:hover:border-white/5 transition-colors flex items-center justify-between gap-4"
          >
            <span className="min-w-0">
              <span className="block text-[15px] font-bold text-white truncate">
                {item.label ?? intl.formatMessage(m.itemUnnamed)}
              </span>
              <span className="block text-[12.5px] text-zinc-500 mt-1 tabular-nums">
                {currency(Math.abs(item.amount))} · {item.date}
              </span>
            </span>
            <span className="shrink-0 text-[12px] font-bold">
              {item.received ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <Check size={14} strokeWidth={3} />
                  {intl.formatMessage(m.itemReceived)}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-brand">
                  {intl.formatMessage(m.itemSendAction)}
                  <ArrowRight size={14} strokeWidth={2.5} />
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      <p className="text-[12px] text-zinc-600 leading-relaxed">
        {intl.formatMessage(m.itemsExpiry, sessionExpiryParts(view.expiresAt))}
        {live ? '' : ` · ${intl.formatMessage(m.syntheticNote)}`}
      </p>
    </>
  );
}

/* ── ④ the photograph ─────────────────────────────────────────────────────── */

function Capture({
  item,
  statementMonth = null,
  page,
  onPage,
  onSend,
  onBack,
  fault,
}: {
  item: PortalItem | null;
  /** Set when the pick was a statement request — the header line names the month. */
  statementMonth?: string | null;
  page: CapturedPage | null;
  onPage: (page: CapturedPage | null) => void;
  onSend: () => void;
  onBack: () => void;
  fault: PortalFault | null;
}) {
  const intl = useIntl();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const take = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setRejected(null);
      const compressed = await compressImage(file);
      if (compressed.blob.size === 0) {
        setRejected(intl.formatMessage(m.captureUnreadable));
        return;
      }
      if (compressed.blob.size > PORTAL_UPLOAD_LIMIT) {
        setRejected(intl.formatMessage(m.captureTooBig, { limit: Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024) }));
        return;
      }
      onPage(compressed);
    },
    [intl, onPage],
  );

  return (
    <Shell title={intl.formatMessage(m.captureTitle)}>
      {statementMonth !== null ? (
        <p className="text-[13px] text-brand font-semibold">
          {intl.formatMessage(m.captureForStatement, { month: statementMonth })}
        </p>
      ) : (
        item && (
          <p className="text-[13px] text-brand font-semibold">
            {intl.formatMessage(m.captureFor, {
              merchant: item.label ?? intl.formatMessage(m.itemUnnamed),
              amount: currency(Math.abs(item.amount)),
              date: item.date,
            })}
          </p>
        )
      )}
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.captureHint)}</p>

      {page ? (
        <div className="rounded-[28px] overflow-hidden border border-white/5 bg-black">
          {page.dataUrl ? (
            <img src={page.dataUrl} alt={intl.formatMessage(m.capturePreviewAlt)} className="w-full object-contain max-h-80" />
          ) : (
            <div className="w-full py-14 flex items-center justify-center text-zinc-500">
              <FileText size={28} />
            </div>
          )}
          <p className="px-4 py-3 text-[12px] text-zinc-500 font-semibold">
            {intl.formatMessage(m.captureSize, {
              name: page.filename,
              size: (page.blob.size / 1024 / 1024).toFixed(1),
            })}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <PickButton icon={Camera} label={intl.formatMessage(m.capturePhotoAction)} onClick={() => cameraRef.current?.click()} />
          <PickButton icon={Upload} label={intl.formatMessage(m.captureFileAction)} onClick={() => fileRef.current?.click()} />
        </div>
      )}

      {/* The device's own camera app. This is what works on a locked-down
          phone, which is the phone this surface is designed for. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept={PORTAL_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {rejected && (
        <p className="flex items-start gap-2 text-[13px] text-amber-400 font-semibold leading-relaxed">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          {rejected}
        </p>
      )}
      <Fault fault={fault} />

      {page && (
        <div className="flex flex-col gap-2">
          <button
            onClick={onSend}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
          >
            <Upload size={16} strokeWidth={2.5} />
            {intl.formatMessage(m.captureSendAction)}
          </button>
          <button
            onClick={() => onPage(null)}
            className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            {intl.formatMessage(m.captureRetake)}
          </button>
        </div>
      )}

      <button
        onClick={onBack}
        className="self-start flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
      >
        <ArrowLeft size={14} />
        {intl.formatMessage(m.backToItemsAction)}
      </button>
    </Shell>
  );
}

function PickButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 py-7 rounded-[24px] border border-white/10 bg-card text-zinc-300 hover:text-white hover:border-brand/40 transition-colors"
    >
      <Icon size={22} strokeWidth={2} />
      <span className="text-[13px] font-bold">{label}</span>
    </button>
  );
}

/* ── ⑤ sending, then the pipeline's answer ────────────────────────────────── */

function Sending() {
  const intl = useIntl();
  return (
    <Shell title={intl.formatMessage(m.uploadingTitle)}>
      <div className="flex items-center gap-3 text-brand">
        <Loader2 size={22} className="animate-spin" />
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.uploadingDetail)}</p>
      </div>
    </Shell>
  );
}

function Result({
  outcome,
  page,
  onAgain,
  onExit,
}: {
  outcome: UploadOutcome;
  page: CapturedPage | null;
  onAgain: () => void;
  onExit: () => void;
}) {
  const intl = useIntl();
  const matched = outcome.kind === 'matched';
  // `pending` means the server has not answered — it must never borrow the
  // mismatch copy, which asserts this is the wrong document.
  const pending = outcome.kind === 'pending';
  const refused = outcome.kind === 'refused';
  const item = outcome.kind === 'failed' || refused ? null : outcome.item;
  const title = outcome.kind === 'failed'
    ? m.failedTitle
    : matched
      ? m.matchedTitle
      : refused
        ? m.refusedTitle
        : pending
          ? m.pendingTitle
          : m.unmatchedTitle;

  return (
    <Shell title={intl.formatMessage(title)}>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className={`w-14 h-14 rounded-2xl flex items-center justify-center border ${
          matched ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
        }`}
      >
        {matched ? <Check size={26} strokeWidth={3} /> : <AlertTriangle size={24} />}
      </motion.div>

      {/* ⚠ A FAILURE GETS NO LEDE, because this one was hardcoded to
          `faultUnreachable` — "check your signal" — for EVERY fault, including
          the `415` that refused an iPhone photograph. It sat directly above the
          `Fault` box, which was already saying something different, so the
          screen contradicted itself and both halves were wrong (8 Sep 2026).
          `Fault` renders `faultMessageFor` plus the reference, which is the
          whole truth; a second sentence here could only repeat it or fight it. */}
      {outcome.kind !== 'failed' && (
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {/* A pending outcome names no item on purpose: everything we can
              truthfully say ("we have it, it is not matched yet") is in
              `unmatchedDetailNoItem`, and naming the item here would read as
              the verdict we do not have. */}
          {/* A refusal shows the SERVER's sentence verbatim — the same words
              written onto the document, so the client and the accountant read
              one wording rather than two that can drift. */}
          {outcome.kind === 'refused'
            ? outcome.message
            : item && !pending
              ? intl.formatMessage(matched ? m.matchedDetail : m.unmatchedDetail, {
                  merchant: item.label ?? intl.formatMessage(m.itemUnnamed),
                  amount: currency(Math.abs(item.amount)),
                  date: item.date,
                })
              : intl.formatMessage(m.unmatchedDetailNoItem)}
        </p>
      )}

      {outcome.kind === 'failed' && <Fault fault={outcome.fault} />}

      {/* The read-only overlay. See the note at the top of this file for why it
          shows what was sent rather than what was read off it. */}
      {page && (
        <section className="rounded-[28px] border border-white/5 bg-card overflow-hidden">
          <div className="px-4 pt-4 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
            {intl.formatMessage(m.sentPanelTitle)}
          </div>
          {page.dataUrl ? (
            <img src={page.dataUrl} alt={intl.formatMessage(m.capturePreviewAlt)} className="w-full object-contain max-h-64 mt-3" />
          ) : (
            <div className="w-full py-10 flex items-center justify-center text-zinc-500">
              <FileText size={26} />
            </div>
          )}
          <p className="px-4 py-3 text-[12px] text-zinc-500 font-semibold">
            {intl.formatMessage(m.captureSize, {
              name: page.filename,
              size: (page.blob.size / 1024 / 1024).toFixed(1),
            })}
          </p>
          <p className="px-4 pb-4 text-[12px] text-zinc-600 leading-relaxed">
            {intl.formatMessage(m.sentPanelReadOnly)}
          </p>
        </section>
      )}

      <div className="flex flex-col gap-2">
        <button
          onClick={onAgain}
          className="w-full px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
        >
          {/* `pending` goes back to the list, not "send a different one": we have
              the document and have not judged it, so asking for another is how a
              client ends up sending the same receipt twice. */}
          {intl.formatMessage(
            outcome.kind === 'failed'
              ? m.failedAgainAction
              : matched || pending
                ? m.backToItemsAction
                : m.tryAgainAction,
          )}
        </button>
      </div>
      <ExitButton onClick={onExit} />
    </Shell>
  );
}

/* ── shared chrome ────────────────────────────────────────────────────────── */

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const intl = useIntl();
  return (
    // The safe-area insets go on the scroll container, which carries no padding
    // of its own, so they compose with the inner column's `px-5 py-10` instead
    // of overriding it. This screen is only ever opened from an emailed link on a phone:
    // without them the heading sits under the notch and the last item under the
    // home indicator. The 16px input floor arrives from index.css.
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-y-auto pt-safe pb-safe px-safe [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
            <Smartphone size={19} />
          </div>
          <div className="min-w-0">
            <h1 className="font-sans font-bold text-xl text-white tracking-tight truncate">{title}</h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider truncate">
              {subtitle ?? intl.formatMessage(m.shellSubtitle)}
            </p>
          </div>
        </div>
        {children}
        {/* On the shell rather than per-step: UK GDPR Art. 13 wants the
            privacy notice AT the point of collection, and every step of this
            journey — the link, the code, the photograph — collects. It opens
            in a new tab because the session lives in React state and an
            in-app navigation would end it (launch stage M4). */}
        <PrivacyNoticeLink />
      </div>
    </div>
  );
}

/**
 * A failure the way the house renders one: plain English first, the `NT-`
 * reference after it (frontend ten, item 5). The two portal codes get their own
 * sentence because the client can act on them.
 *
 * ⚠ **The rest splits on whether there is a code at all.** "We could not
 * reach it" is the only true thing left to say when nothing answered — and it
 * is a lie the moment a reference is on screen beside it, because that
 * reference travelled over the connection the sentence blames. Sending a
 * client to their signal for a server-side fault costs the document we asked
 * for.
 */
export function faultMessageFor(fault: PortalFault): MessageDescriptor {
  if (fault.code === 'NT-OTP-001') return m.faultOtp;
  if (fault.code === 'NT-OTP-002') return m.faultSession;
  // ⚠ The file itself, and PERMANENTLY so. `faultRefused` says "try again in a
  // moment", which for a type off the allowlist or a file over the cap is a
  // loop with no exit — the client retries on the train, retries at home, and
  // telephones the accountant. Each of these names what to send instead.
  if (fault.code === 'NT-ING-002') return m.faultFileType;
  if (fault.code === 'NT-ING-001') return m.faultFileTooBig;
  return fault.code === null ? m.faultUnreachable : m.faultRefused;
}

function Fault({ fault }: { fault: PortalFault | null }) {
  const intl = useIntl();
  if (!fault) return null;

  const message = intl.formatMessage(faultMessageFor(fault));

  return (
    <div role="alert" className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5">
      <p className="flex items-start gap-2 text-[13px] font-semibold text-red-400 leading-relaxed">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        {message}
      </p>
      {fault.code && (
        <p className="text-[11px] text-zinc-600 font-bold mt-2 ml-[23px] tracking-wide">
          {intl.formatMessage(m.faultCode, { code: fault.code })}
        </p>
      )}
    </div>
  );
}

function ExitButton({ onClick }: { onClick: () => void }) {
  const intl = useIntl();
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-600 hover:text-zinc-400 transition-colors"
    >
      <ArrowLeft size={13} />
      {intl.formatMessage(m.exitAction)}
    </button>
  );
}

