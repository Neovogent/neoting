import { useCallback, useEffect, useRef, useState } from 'react';

import { NtProblemError } from '@neoting/contracts';

import {
  fetchBusinessPortalHome,
  openOnboardingSession,
  requestSignInCode,
  type BusinessPortalHome,
} from '../../api/onboarding';
import { sendPortalUpload } from '../../api/portal';

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
 */

export type SignInStep = 'address' | 'code' | 'in' | 'resuming';

/**
 * Where the bearer survives a reload. `sessionStorage`, deliberately — see the
 * module header. The try/catch is for browsers where storage access throws
 * (private modes, storage-partitioned iframes); there the portal degrades to
 * the old behaviour, memory-only.
 */
const BEARER_KEY = 'nt-business-portal-bearer';

function storedBearer(): string | null {
  try {
    return window.sessionStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

function storeBearer(token: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(BEARER_KEY);
    else window.sessionStorage.setItem(BEARER_KEY, token);
  } catch {
    /* memory-only fallback */
  }
}

export interface BusinessPortalSession {
  readonly step: SignInStep;
  readonly email: string;
  readonly home: BusinessPortalHome | null;
  readonly busy: boolean;
  /** Plain English plus its `NT-` code, or null. Never says whether an account exists. */
  readonly error: string | null;
  requestCode(email: string): Promise<void>;
  submitCode(otp: string): Promise<void>;
  /** Re-read the home figures — after an upload, or on demand. */
  refresh(): Promise<void>;
  upload(file: File): Promise<boolean>;
  signOut(): void;
  /** The bearer, for the surfaces that need it directly. Lives in state + sessionStorage, nowhere durable. */
  readonly token: string | null;
}

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof NtProblemError) {
    // The code in front of the words (frontend ten, item 5) — an accountant
    // reading this over the phone needs something to quote.
    return `${error.code} — ${error.detail ?? fallback}`;
  }
  return fallback;
}

export function useBusinessPortalSession(): BusinessPortalSession {
  const [token, setToken] = useState<string | null>(storedBearer);
  const [step, setStep] = useState<SignInStep>(token === null ? 'address' : 'resuming');
  const [email, setEmail] = useState('');
  const [home, setHome] = useState<BusinessPortalHome | null>(null);
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
        storeBearer(null);
        setToken(null);
        setStep('address');
      });
  }, [step, token]);

  const requestCode = useCallback(async (address: string) => {
    setBusy(true);
    setError(null);
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
        storeBearer(session.token);
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
      setHome(await fetchBusinessPortalHome(token));
    } catch (caught) {
      // A 401 mid-visit means the server-side hour ran out. Holding the dead
      // bearer and printing "could not refresh" forever is a trap — sign out,
      // so the next action is the address form asking for a fresh code.
      if (caught instanceof NtProblemError && caught.status === 401) {
        storeBearer(null);
        setToken(null);
        setHome(null);
        setStep('address');
        setError('Your session ended. Sign in again with a fresh code.');
        return;
      }
      setError(messageFor(caught, 'We could not refresh this. Your paperwork is safe.'));
    }
  }, [token]);

  const upload = useCallback(
    async (file: File): Promise<boolean> => {
      if (token === null) return false;
      setBusy(true);
      setError(null);
      try {
        // `transactionId` is null: this is a client sending paperwork in, not
        // answering a chased line. The pipeline matches it afterwards.
        await sendPortalUpload(token, { filename: file.name, mimeType: file.type, bytes: file }, null);
        await refresh();
        return true;
      } catch (caught) {
        setError(messageFor(caught, 'That did not send. Nothing was uploaded — try again.'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [token, refresh],
  );

  const signOut = useCallback(() => {
    // Dropping the state and the sessionStorage copy together IS the sign-out.
    storeBearer(null);
    setToken(null);
    setHome(null);
    setEmail('');
    setStep('address');
    setError(null);
  }, []);

  return { step, email, home, busy, error, requestCode, submitCode, refresh, upload, signOut, token };
}
