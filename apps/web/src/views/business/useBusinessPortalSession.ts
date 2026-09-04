import { useCallback, useEffect, useRef, useState } from 'react';

import { NtProblemError } from '@neoting/contracts';

import {
  fetchBusinessPortalHome,
  fetchPortalDocuments,
  openBillingPortal,
  openOnboardingSession,
  requestSignInCode,
  startSubscriptionCheckout,
  type BusinessPortalHome,
  type PortalSentPage,
} from '../../api/onboarding';
import { sendPortalUpload, type PortalUploadFile } from '../../api/portal';
import { compressImage } from '../../lib/capture';
import { SESSION_EXPIRED_CODE, sendFaultFor, type PortalSendFault } from './portalSendFault';
// The bearer's home in sessionStorage — and, since 5 Sep 2026, where the setup
// journey ADOPTS its own session so Stripe's return leg lands the client inside
// their portal. `portal-session-store.ts` carries the argument; the extraction
// exists so the onboarding chunk does not import this whole hook.
import { storedBearer, storedExpiry, storeSession } from './portal-session-store';
import { mimeTypeFor } from './portalUploadRules';

/**
 * The business portal's session, for a client signing in to their OWN
 * workspace.
 *
 * ## Why this is not the setup journey
 *
 * `useOnboardingJourney` is the FIRST visit: it walks a client through the
 * emailed setup link, their profile and the subscription, once. This is every
 * visit after that — and until 29 Aug 2026 there was no such thing, because
 * signing in required the setup token and **the invite expires after seven
 * days**. A client who onboarded, subscribed and came back a fortnight later
 * was locked out of their own workspace with no route back that did not involve
 * telephoning their accountant. The contract's `setupToken` is optional now, so
 * the address alone names the workspace.
 *
 * ## The bearer lives in React state plus `sessionStorage` — never anywhere durable
 *
 * Until 2 Sep 2026 it was React state alone, "the same rule the chase portal
 * follows", and every reload signed the client out — a fresh emailed code per
 * F5, found on the first real walkthrough. That was stricter than the rule it
 * cited: the intended lifetime was always "dies with the tab" (no standing
 * credential on a phone that gets handed round the till), and losing the
 * session to a RELOAD was an artifact of where the state lived, not a property
 * anyone argued for. `sessionStorage` has exactly the stated lifetime — gone
 * when the tab closes, never shared across tabs, never on disk beyond the
 * session — so the bearer now survives a reload and nothing else.
 *
 * Not `localStorage` and not a cookie, still: both outlive the tab, and the
 * server-side hour (`PORTAL_SESSION_TTL_MS`) is the backstop, not the fence.
 * ⚠ The CHASE portal keeps the memory-only rule unchanged — that bearer is an
 * anonymous delegated grant from a link, and stays as strict as it was.
 *
 * ## Every refusal is the same refusal
 *
 * `POST /portal/sign-in-codes` answers `202` whatever happened — an unknown
 * address, an address on two businesses and a real send are one outcome, and
 * the email is what distinguishes them. So the code step is reached even for an
 * address that will never receive anything, and **no copy on this journey may
 * say whether an account exists.**
 *
 * ## Three things this hook does that the first version did not
 *
 * - **It polls.** Nothing did, so an ask raised by the accountant while the tab
 *   was open never appeared — a client sat on a screen saying "nothing
 *   outstanding" while a chase went out by email.
 * - **It watches its own expiry.** `openOnboardingSession` returns `expiresAt`
 *   and the first version discarded it, so the sixty-minute bearer simply
 *   started failing and the copy blamed the UPLOAD ("That did not send"). A
 *   client re-photographed a receipt to fix a session problem. The expiry is
 *   now its own state with its own sentence.
 * - **It sends the real bytes, downscaled.** Photographs go through
 *   `compressImage` — the same encoder the chase portal uses — before they
 *   leave the device.
 */

export type SignInStep = 'address' | 'code' | 'in' | 'resuming';


/**
 * What one send produced.
 *
 * ⚠ `fault` used to be a pre-formatted English string, and the two surfaces
 * that call this **discarded it** — the client read "N photos did not send"
 * over a lapsed subscription, an expired session and a storage outage alike.
 * It is a machine value now precisely so the view has to render it through
 * react-intl and cannot quietly drop it on the floor again. See
 * `portalSendFault.ts` for what each reason means and what it must not claim.
 */
export interface PortalSendOutcome {
  readonly ok: boolean;
  readonly fault: PortalSendFault | null;
}

export interface BusinessPortalSession {
  readonly step: SignInStep;
  readonly email: string;
  readonly home: BusinessPortalHome | null;
  /** What the client has sent, newest first. Null until the first read lands. */
  readonly documents: PortalSentPage | null;
  /** The document list's own failure, kept apart so it cannot fell the screen. */
  readonly documentsFault: string | null;
  readonly busy: boolean;
  /** Plain English plus its `NT-` code, or null. Never says whether an account exists. */
  readonly error: string | null;
  /**
   * True once the bearer has expired or the server has refused it as expired.
   * The screen asks for a new code instead of blaming whatever the client was
   * doing at the time.
   */
  readonly expired: boolean;
  requestCode(email: string): Promise<void>;
  submitCode(otp: string): Promise<void>;
  /** Re-read the home figures and the document list. */
  refresh(): Promise<void>;
  /** A picked file: compressed if it is an image, then sent. */
  upload(file: File, transactionId: string | null): Promise<PortalSendOutcome>;
  /** Bytes already in hand — a camera frame the Capture tab encoded. */
  send(file: PortalUploadFile, transactionId: string | null): Promise<PortalSendOutcome>;
  /** Stripe-hosted checkout for a lapsed subscription (D48). Redirects the tab. */
  startCheckout(): Promise<void>;
  /** Stripe's own customer portal — card, invoices, cancellation. Redirects. */
  manageBilling(): Promise<void>;
  signOut(): void;
  /** The bearer, for the surfaces that need it directly. Lives in state + sessionStorage, nowhere durable. */
  readonly token: string | null;
}

/**
 * How often the portal re-reads what its accountant is waiting for.
 *
 * Slower than the practice app's five seconds, deliberately: this screen runs
 * on a phone on mobile data, and the beat it exists to catch — an ask raised
 * while the tab is open — is measured in minutes, not seconds. It also pauses
 * while the tab is hidden and catches up the moment it comes back, which is the
 * common case on a phone that keeps being locked.
 */
const POLL_MS = 20_000;

// `SESSION_EXPIRED_CODE` is `portalSendFault.ts`'s — one definition, because a
// second copy of the code that ends a session is exactly the drift that leaves
// one path expiring the bearer and another reporting a generic failure.

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof NtProblemError) {
    // The code in front of the words (frontend ten, item 5) — an accountant
    // reading this over the phone needs something to quote.
    return `${error.code} — ${error.detail ?? fallback}`;
  }
  return fallback;
}

/**
 * Whether the server has told us this bearer is finished.
 *
 * ⚠ Two tests, not one, and the second is #243's. `NT-OTP-002` is the expiry
 * the server NAMES; a bare `401` on a portal read is the same fact arriving
 * without that code, and treating it as an ordinary failure is the trap #243
 * reported — the dead bearer is held, "we could not refresh this" prints for
 * ever, and the client has no way to reach the one action that fixes it. Any
 * 401 here ends the session.
 */
function isExpiryRefusal(error: unknown): boolean {
  if (!(error instanceof NtProblemError)) return false;
  return error.code === SESSION_EXPIRED_CODE || error.status === 401;
}

export function useBusinessPortalSession(): BusinessPortalSession {
  const [token, setToken] = useState<string | null>(storedBearer);
  const [step, setStep] = useState<SignInStep>(token === null ? 'address' : 'resuming');
  const [email, setEmail] = useState('');
  // Restored alongside the bearer, so the client-side expiry watch below still
  // works after a reload rather than only in the tab that signed in.
  const [expiresAt, setExpiresAt] = useState<string | null>(storedExpiry);
  const [expired, setExpired] = useState(false);
  const [home, setHome] = useState<BusinessPortalHome | null>(null);
  const [documents, setDocuments] = useState<PortalSentPage | null>(null);
  const [documentsFault, setDocumentsFault] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The resume is spent once — a StrictMode double-mount must not ask twice.
  const resumed = useRef(false);

  useEffect(() => {
    if (resumed.current || step !== 'resuming' || token === null) return;
    resumed.current = true;
    void fetchBusinessPortalHome(token)
      .then((loaded) => {
        if (loaded === null) throw new Error('no summary');
        setHome(loaded);
        setStep('in');
      })
      .catch(() => {
        // Expired, revoked, or the hour ran out — the stored bearer is dead.
        // Dropping to the address form with no error banner is deliberate:
        // "your session ended" is the normal morning-after state, not a fault.
        // ⚠ Deliberately NOT `expire()`: that raises `expired`, which is the
        // sentence for a session that ended UNDER the client mid-visit. A
        // resume that finds yesterday's bearer dead is the ordinary way this
        // starts, and it must open the sign-in form saying nothing.
        storeSession(null, null);
        setToken(null);
        setExpiresAt(null);
        setStep('address');
      });
  }, [step, token]);

  // Nothing may set state after the client has closed the tab or navigated
  // away mid-upload — the sends below outlive a tab change on a phone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * End the session because the bearer is finished.
   *
   * ⚠ The token is DROPPED, not merely flagged. It cannot do anything any more,
   * and a dead credential kept in state is a dead credential kept in state.
   */
  const expire = useCallback(() => {
    // The stored copy goes with the state copy, or a reload would resume a
    // bearer this call has just declared dead.
    storeSession(null, null);
    setToken(null);
    setExpiresAt(null);
    setHome(null);
    setDocuments(null);
    setDocumentsFault(null);
    setExpired(true);
    setStep('address');
    setError(null);
  }, []);

  const requestCode = useCallback(async (address: string) => {
    setBusy(true);
    setError(null);
    setExpired(false);
    try {
      await requestSignInCode(address);
      setEmail(address);
      // ⚠ ALWAYS advances, because the server always answers 202. Branching on
      // anything here would turn this screen into an oracle for "is this
      // address registered", which is exactly what the uniform 202 prevents.
      setStep('code');
    } catch (caught) {
      // A throw here is a 400 (malformed address) or a 429 (too many asks),
      // never "no such account".
      setError(messageFor(caught, 'That did not send. Check the address and try again.'));
    } finally {
      setBusy(false);
    }
  }, []);

  const submitCode = useCallback(
    async (otp: string) => {
      setBusy(true);
      setError(null);
      try {
        const session = await openOnboardingSession(email, otp);
        const loaded = await fetchBusinessPortalHome(session.token);
        // ⚠ NULL IS A DEAD END, SO IT GETS A MESSAGE RATHER THAN A STEP.
        //
        // `fetchBusinessPortalHome` answers null when the context carries no
        // summary — the CHASE case, which an onboarding session should never
        // be. Advancing to 'in' with no home would render the code form again,
        // so a client whose code WORKED would retype it for ever with nothing
        // on screen to say why.
        if (loaded === null) {
          setError('We could not open your portal. Ask your accountant to check your account.');
          return;
        }
        setToken(session.token);
        // The session's own clock, kept rather than discarded — see the note at
        // the top of this file for what discarding it cost.
        setExpiresAt(session.expiresAt);
        setExpired(false);
        storeSession(session.token, session.expiresAt);
        setHome(loaded);
        setStep('in');
      } catch (caught) {
        // Every verification failure is one 401 by design — wrong code, expired
        // code, unknown address, an address on two businesses. The copy must
        // not try to tell them apart, because the server deliberately did not.
        setError(messageFor(caught, 'That code did not work. Ask for a new one and try again.'));
      } finally {
        setBusy(false);
      }
    },
    [email],
  );

  const refresh = useCallback(async () => {
    if (token === null) return;
    try {
      const loaded = await fetchBusinessPortalHome(token);
      if (!alive.current) return;
      if (loaded !== null) setHome(loaded);
    } catch (caught) {
      if (!alive.current) return;
      // A 401 mid-visit means the server-side hour ran out. Holding the dead
      // bearer and printing "could not refresh" forever is a trap — end the
      // session, so the next action is the address form asking for a fresh
      // code. `expire()` is what does it (it also clears the stored bearer and
      // raises `expired`, which is the flag the view renders its own react-intl
      // sentence from — never a hard-coded English string from this hook).
      if (isExpiryRefusal(caught)) {
        expire();
        return;
      }
      setError(messageFor(caught, 'We could not refresh this. Your paperwork is safe.'));
      return;
    }

    // ⚠ The document list is read SECOND and its failure is kept apart. It is
    // the newest thing on this surface and the likeliest to be missing from a
    // server that has not caught up; letting its 404 clear the home figures
    // would take the whole portal down for a panel.
    try {
      const sent = await fetchPortalDocuments(token);
      if (!alive.current) return;
      setDocuments(sent);
      setDocumentsFault(null);
    } catch (caught) {
      if (!alive.current) return;
      if (isExpiryRefusal(caught)) {
        expire();
        return;
      }
      setDocumentsFault(messageFor(caught, 'We could not load what you have sent. Nothing is lost.'));
    }
  }, [token, expire]);

  /* ── the poll ───────────────────────────────────────────────────────────── */

  // The first read of the document list, as soon as there is a session. The
  // sign-in path deliberately does not wait for it: a slow list must not hold
  // up the screen the client signed in to see.
  useEffect(() => {
    if (token === null) return;
    void refresh();
  }, [token, refresh]);

  useEffect(() => {
    if (token === null) return undefined;

    const tick = () => {
      // Nothing is asked for while the tab is in the background. On a phone
      // that is most of the session, and the catch-up below covers the return.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    };

    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [token, refresh]);

  // The bearer's own clock. The server is the authority and answers
  // `NT-OTP-002` regardless; this is what stops the client discovering it by
  // watching an upload fail.
  useEffect(() => {
    if (token === null || expiresAt === null) return undefined;
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(remaining)) return undefined;
    if (remaining <= 0) {
      expire();
      return undefined;
    }
    const id = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(id);
  }, [token, expiresAt, expire]);

  /* ── sending ────────────────────────────────────────────────────────────── */

  const send = useCallback(
    async (file: PortalUploadFile, transactionId: string | null): Promise<PortalSendOutcome> => {
      if (token === null) {
        // No bearer at all: the session ended before the client pressed send.
        // `expire()` returns the whole portal to the sign-in step, which is the
        // message — so the tray says nothing on top of it.
        expire();
        return { ok: false, fault: { reason: 'expired', code: SESSION_EXPIRED_CODE, detail: null } };
      }
      setBusy(true);
      setError(null);
      try {
        // ⚠ `transactionId` is a DECLARATION, not an instruction. The server
        // records which ask the client tapped and then re-derives the match
        // from the extraction (supplier + amount + date) — so this closes an
        // ask only if the document really answers it, and no copy on this
        // surface may promise that a send closes the row it was started from.
        await sendPortalUpload(token, file, transactionId);
        await refresh();
        return { ok: true, fault: null };
      } catch (caught) {
        const fault = sendFaultFor(caught);
        if (fault.reason === 'expired') {
          expire();
          return { ok: false, fault };
        }
        // ⚠ The session-wide `error` is deliberately NOT set here any more. It
        // renders on the sign-in screen and the Settings tab and on neither of
        // the two surfaces that send, so all it ever did was leave a stale
        // upload failure waiting to surprise the client on a later tab. The
        // caller has the fault and renders it where the client is looking.
        return { ok: false, fault };
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [token, refresh, expire],
  );

  const upload = useCallback(
    async (file: File, transactionId: string | null): Promise<PortalSendOutcome> => {
      // A modern phone photograph is 4–8 MB of receipt that reads perfectly
      // well at a tenth of that, and this is the surface most likely to be on
      // bad mobile data. Non-images pass through untouched — re-encoding a PDF
      // as a JPEG would throw away the text layer extraction wants.
      const page = await compressImage(file);
      // The declared MIME is checked against the server's allowlist, and a
      // browser that hands over an empty `type` — iOS, routinely, for HEIC —
      // would otherwise turn the commonest phone photograph into a 400.
      const mimeType = page.blob.type || mimeTypeFor(file);
      return send({ filename: page.filename, mimeType, bytes: page.blob }, transactionId);
    },
    [send],
  );

  /* ── the money doors, both Stripe's ─────────────────────────────────────── */

  const businessId = home?.businessId ?? null;

  const startCheckout = useCallback(async () => {
    if (token === null || businessId === null) {
      setError('We could not open the checkout. Nothing has been charged — ask your accountant.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Back to the portal, not to the one-time setup link the client may no
      // longer hold. The bearer dies with the redirect by design, so the
      // return leg lands on the sign-in screen with a banner.
      const url = await startSubscriptionCheckout(token, businessId, window.location.pathname);
      window.location.assign(url);
    } catch (caught) {
      if (alive.current) {
        setError(messageFor(caught, 'We could not open the checkout. Nothing has been charged.'));
        setBusy(false);
      }
    }
  }, [token, businessId]);

  const manageBilling = useCallback(async () => {
    if (token === null || businessId === null) {
      setError('We could not open the billing page. Try again in a moment.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = await openBillingPortal(businessId, token);
      window.location.assign(url);
    } catch (caught) {
      if (alive.current) {
        setError(messageFor(caught, 'We could not open the billing page. Try again in a moment.'));
        setBusy(false);
      }
    }
  }, [token, businessId]);

  const signOut = useCallback(() => {
    // Dropping the state and the sessionStorage copy together IS the sign-out.
    storeSession(null, null);
    setToken(null);
    setExpiresAt(null);
    setExpired(false);
    setHome(null);
    setDocuments(null);
    setDocumentsFault(null);
    setEmail('');
    setStep('address');
    setError(null);
  }, []);

  return {
    step,
    email,
    home,
    documents,
    documentsFault,
    busy,
    error,
    expired,
    requestCode,
    submitCode,
    refresh,
    upload,
    send,
    startCheckout,
    manageBilling,
    signOut,
    token,
  };
}
