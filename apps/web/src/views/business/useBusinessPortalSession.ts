import { useCallback, useState } from 'react';

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
 * ## The bearer lives in React state and nowhere else
 *
 * Not `localStorage`, not a cookie, not a module singleton — the same rule the
 * chase portal follows and for the same reason: it is a credential over a
 * client's financial records held by a person who cannot re-prove anything, and
 * persisting it would leave a standing upload token on a phone that gets handed
 * round the till. It dies with the tab, which is the intended lifetime.
 *
 * ## Every refusal is the same refusal
 *
 * `POST /portal/sign-in-codes` answers `202` whatever happened — an unknown
 * address, an address on two businesses and a real send are one outcome, and
 * the email is what distinguishes them. So the code step is reached even for an
 * address that will never receive anything, and **no copy on this journey may
 * say whether an account exists.**
 */

export type SignInStep = 'address' | 'code' | 'in';

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
  /** The bearer, for the surfaces that need it directly. Never persisted. */
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
  const [step, setStep] = useState<SignInStep>('address');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [home, setHome] = useState<BusinessPortalHome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // The token is only ever in this state, so dropping it IS the sign-out.
    setToken(null);
    setHome(null);
    setEmail('');
    setStep('address');
    setError(null);
  }, []);

  return { step, email, home, busy, error, requestCode, submitCode, refresh, upload, signOut, token };
}
