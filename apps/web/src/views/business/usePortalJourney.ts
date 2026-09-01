import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NtProblemError } from '@neoting/contracts';
import { API_ENABLED } from '../../api/config';
import { fetchPortalView, openPortalSession, requestPortalCode, sendPortalUpload } from '../../api/portal';
import type { PortalItem, PortalView } from '../../api/portal';
import { useAppContext } from '../../context/AppContext';
import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import type { CapturedPage } from '../../lib/capture';

/**
 * The chase-portal journey, as one hook with two implementations behind it.
 *
 * Live (`VITE_API_ENABLED=true`) it is the three contracted portal operations
 * plus the shared completion endpoint. On seed data it is the app's own chase
 * state, which already models everything the portal needs — the outstanding
 * items, and an item closing when a matching document arrives. Both answer the
 * same interface, so `ChasePortalView` has one code path and the synthetic demo
 * that works today keeps working exactly as it does (METH_MODE §1: no stage may
 * break synthetic mode).
 *
 * The bearer lives in this hook's state and nowhere else — see the note in
 * `src/api/portal.ts` for why it is never persisted.
 */

/** A failure the client can be told about: plain English, plus the `NT-` code. */
export interface PortalFault {
  /** e.g. `NT-OTP-001`. Null when the API was never reached. */
  code: string | null;
  /** The server's own sentence, when it sent one worth showing. */
  detail: string | null;
}

export type UploadOutcome =
  /** Extraction matched the chased item — the chase closes itself. */
  | { kind: 'matched'; item: PortalItem }
  /** The document arrived, and it is not the thing that was asked for. */
  | { kind: 'unmatched'; item: PortalItem | null }
  /**
   * The document arrived and the server has not said either way yet.
   *
   * ⚠ This is NOT `unmatched`, and conflating the two was a real bug: the
   * screen told a client who had photographed the correct receipt that it "does
   * not look like" the payment we asked for, purely because the pipeline had
   * not answered within the poll budget. `received` is false both for a genuine
   * mismatch and for a document still being read, and the client cannot tell
   * those apart — so neither may the copy. Everything true of this state ("your
   * accountant has it, nothing is lost") is said; the verdict is not invented.
   */
  | { kind: 'pending'; item: PortalItem | null }
  | { kind: 'failed'; fault: PortalFault };

export interface PortalJourney {
  /** Whether the app is talking to the API at all. Shown, not hidden. */
  live: boolean;
  /** Null until the OTP has been accepted. */
  view: PortalView | null;
  busy: boolean;
  fault: PortalFault | null;
  clearFault: () => void;
  /**
   * Ask for the six-digit code. Live it is emailed to the chase's REGISTERED
   * recipient (a `202` whatever happened — the mail is the only answer);
   * synthetic mode needs no code, so this resolves without a network. Returns
   * whether the request was ACCEPTED, never whether a code exists.
   */
  requestCode: () => Promise<boolean>;
  /** True once a code was requested this visit — what flips the copy to "check your email". */
  codeRequested: boolean;
  verify: (otp: string) => Promise<boolean>;
  upload: (page: CapturedPage, transactionId: string | null) => Promise<UploadOutcome>;
}

/**
 * How long the portal waits for the pipeline to have an opinion.
 *
 * Extraction is a queued job, never inline (Governance §7), and the demo
 * extractor is deliberately latency-honest at 2–4 s. Eight polls at 1.5 s gives
 * it twelve seconds before the screen stops waiting — after which the outcome
 * is `pending` and the client is told the document is with their accountant,
 * which is true, rather than being shown a spinner that never resolves OR a
 * verdict the server never gave.
 */
const SETTLE_POLL_MS = 1_500;
const SETTLE_ATTEMPTS = 8;

const faultFrom = (error: unknown): PortalFault =>
  error instanceof NtProblemError
    ? { code: error.code, detail: error.detail ?? error.title }
    : { code: null, detail: null };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function usePortalJourney(linkToken: string | null): PortalJourney {
  const synthetic = useSyntheticPortal(linkToken);

  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<PortalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<PortalFault | null>(null);

  // Nothing may set state after the client has closed the tab or navigated
  // away mid-upload; the settle poll below runs for up to twelve seconds.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const clearFault = useCallback(() => setFault(null), []);

  const [codeRequested, setCodeRequested] = useState(false);
  const requestCode = useCallback(async (): Promise<boolean> => {
    if (!linkToken) return false;
    if (!API_ENABLED) {
      // Synthetic mode's verifier is the fixed demo code — nothing to send.
      setCodeRequested(true);
      return true;
    }
    setBusy(true);
    setFault(null);
    try {
      await requestPortalCode(linkToken);
      if (alive.current) setCodeRequested(true);
      return true;
    } catch (error) {
      if (alive.current) setFault(faultFrom(error));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [linkToken]);

  const verify = useCallback(
    async (otp: string): Promise<boolean> => {
      if (!linkToken) return false;
      setBusy(true);
      setFault(null);
      try {
        if (!API_ENABLED) {
          const seeded = synthetic.open();
          if (!alive.current) return false;
          setView(seeded);
          return true;
        }
        const session = await openPortalSession(linkToken, otp);
        const opened = await fetchPortalView(session.token);
        if (!alive.current) return false;
        setToken(session.token);
        setView(opened);
        return true;
      } catch (error) {
        if (alive.current) setFault(faultFrom(error));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [linkToken, synthetic],
  );

  const upload = useCallback(
    async (page: CapturedPage, transactionId: string | null): Promise<UploadOutcome> => {
      setBusy(true);
      setFault(null);
      try {
        if (!API_ENABLED) {
          const settled = synthetic.upload(page, transactionId);
          if (alive.current) setView(settled.view);
          return settled.outcome;
        }
        if (!token) return { kind: 'failed', fault: { code: null, detail: null } };

        // ⚠ ONLY the send may report "that did not send". Once this resolves the
        // bytes are in storage and the document is created, so a later failure
        // is our inability to report a verdict — not a lost upload. Telling the
        // client it failed would push them to re-send a document we already
        // have. Hence the second `try` around the settle poll below.
        await sendPortalUpload(
          token,
          { filename: page.filename, mimeType: page.blob.type, bytes: page.blob },
          transactionId,
        );

        // The pipeline decides whether this answered the request. `received`
        // flipping is the server's answer, not a guess made here: it is set by
        // the same deterministic compare that auto-closes the chase.
        let latest: PortalView | null = null;
        try {
          for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
            await sleep(SETTLE_POLL_MS);
            if (!alive.current) return { kind: 'pending', item: null };
            latest = await fetchPortalView(token);
            setView(latest);
            const matched = latest.items.find((i) => i.transactionId === transactionId && i.received);
            if (matched) return { kind: 'matched', item: matched };
          }
        } catch (error) {
          // The poll broke, not the upload. Record the fault so the screen can
          // show the code, but the outcome is "we have it, no verdict yet".
          if (alive.current) setFault(faultFrom(error));
          return { kind: 'pending', item: null };
        }

        // The budget ran out with no answer. That is NOT a mismatch: the server
        // never said this is the wrong document, only that it has not finished
        // reading it (extraction is a queued job — and with the default
        // `INGEST_QUEUE=fixture` no worker consumes it at all, so `received`
        // would never flip). Claiming a verdict here is how a client with the
        // RIGHT receipt gets told to send a different one.
        const asked = latest?.items.find((i) => i.transactionId === transactionId) ?? null;
        return { kind: 'pending', item: asked };
      } catch (error) {
        const failure = faultFrom(error);
        if (alive.current) setFault(failure);
        return { kind: 'failed', fault: failure };
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [synthetic, token],
  );

  return { live: API_ENABLED, view, busy, fault, clearFault, requestCode, codeRequested, verify, upload };
}

/* ── the seed-data implementation ─────────────────────────────────────────── */

interface SyntheticPortal {
  open: () => PortalView;
  upload: (page: CapturedPage, transactionId: string | null) => { view: PortalView; outcome: UploadOutcome };
}

/**
 * The same journey against `AppContext`.
 *
 * The link token stands in for the chase id, which is what the accountant's
 * chase screen already links by, so a demo can walk from the SMS outbox to the
 * portal without an API. Marking an item received is the app's existing
 * closure — the same call the accountant's own button makes — and the ingested
 * file lands in the practice inbox, so the accountant sees the upload arrive.
 */
function useSyntheticPortal(linkToken: string | null): SyntheticPortal {
  const { chases, ingest, setChaseItemStatus } = useAppContext();

  const chase = useMemo(() => {
    const outstanding = chases.filter((c) => c.items.some((i) => i.status === 'requested'));
    return chases.find((c) => c.id === linkToken) ?? outstanding[0] ?? chases[0] ?? null;
  }, [chases, linkToken]);

  const toView = useCallback(
    (): PortalView => ({
      businessName: chase?.clientName ?? '',
      statementRequests: [],
      items: (chase?.items ?? []).map((item) => ({
        transactionId: item.missingItemId,
        label: item.supplier,
        // The seed carries pounds already; the API path is the only one that
        // has pence to convert, and it converts them in `api/portal.ts`.
        amount: item.amount,
        date: item.date,
        received: item.status === 'received',
      })),
      expiresAt: new Date(Date.now() + (chase?.linkExpiresInHours ?? 24) * 3_600_000).toISOString(),
    }),
    [chase],
  );

  const open = useCallback(() => toView(), [toView]);

  const upload = useCallback(
    (page: CapturedPage, transactionId: string | null) => {
      const item = chase?.items.find((i) => i.missingItemId === transactionId) ?? null;
      if (chase) {
        ingest([{ name: page.filename, size: page.blob.size }], chase.clientId, 'portal', {
          limit: PORTAL_UPLOAD_LIMIT,
          uploader: `${chase.recipientName} (secure link)`,
        });
        if (item) setChaseItemStatus(chase.id, item.missingItemId, 'received');
      }

      const view: PortalView = {
        ...toView(),
        items: toView().items.map((i) => (i.transactionId === transactionId ? { ...i, received: true } : i)),
      };
      const answered = view.items.find((i) => i.transactionId === transactionId) ?? null;
      return {
        view,
        outcome: answered ? ({ kind: 'matched', item: answered } as const) : ({ kind: 'unmatched', item: null } as const),
      };
    },
    [chase, ingest, setChaseItemStatus, toView],
  );

  return useMemo(() => ({ open, upload }), [open, upload]);
}
