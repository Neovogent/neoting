import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NtProblemError } from '@neoting/contracts';
import { API_ENABLED } from '../../api/config';
import {
  fetchBusinessPortalHome,
  fetchSetupPreview,
  openOnboardingSession,
  requestSignInCode,
  startSubscriptionCheckout,
  updateBusinessProfile,
} from '../../api/onboarding';
import type { BusinessPortalHome, BusinessProfileUpdate, OnboardingSession, SetupPreview } from '../../api/onboarding';
import { useAppContext } from '../../context/AppContext';
import type { BusinessAccount } from '../../lib/types';
import { storeSession } from './portal-session-store';
import type { PortalFault } from './usePortalJourney';

/**
 * The invited client's onboarding journey (launch stage M6), as one hook with
 * two implementations behind it — the same shape as `usePortalJourney`, for
 * the same reason: live it is the contracted operations, on seed data it is
 * the app's own business-account state, and the view has one code path so the
 * synthetic demo keeps working end to end (METH_MODE §1).
 *
 * The steps, in the order §24.5 walks them — plus the details step (5 Sep
 * 2026, review item 4: the emailed link told the client they would fill in
 * their account information, and the journey asked them nothing between the
 * code and the payment):
 *
 *   email → code → welcome → details → subscribe → subscribed
 *
 * The bearer lives in this hook's state and nowhere else — the standing
 * portal rule (`api/portal.ts` has the argument in full). A page refresh ends
 * the session; the setup link in the email starts a fresh one, which is the
 * intended recovery, not a failure.
 */

export type OnboardingStep = 'email' | 'code' | 'welcome' | 'details' | 'subscribe' | 'subscribed';

export type SubscribeOutcome =
  /** The tab is being handed to Stripe's hosted checkout. */
  | { kind: 'redirected' }
  /** Seed data only: the subscription is written and the journey is done. */
  | { kind: 'subscribed' }
  /** `409 NT-BIL-002` — this business is already subscribed. Not a failure. */
  | { kind: 'already' }
  | { kind: 'failed'; fault: PortalFault };

export interface OnboardingJourney {
  /** Whether the app is talking to the API at all. Shown, not hidden. */
  live: boolean;
  step: OnboardingStep;
  /** The address the code went to — rendered back in the step-two copy. */
  email: string;
  /**
   * The REGISTERED address, off the setup token (5 Sep 2026). The email step
   * prefills from it, because a retyped address that differs from the
   * registered one fails silently by design — the uniform 202 sends nothing
   * and may not say why. Null while loading, on any failure, and always in
   * synthetic mode; the field is still editable either way.
   */
  prefilledEmail: string | null;
  /**
   * The business being set up.
   *
   * Known on seed data, and — since the portal-context widening — live too.
   * This used to be null live, with the copy kept generic because "no
   * contracted read answers it for an onboarding session". `GET /portal/context`
   * now does: a session with no chase is a client signed into their own
   * workspace, and it is answered with that workspace instead of a 401.
   */
  businessName: string | null;
  /**
   * The client's own portal, once they are signed in. Null until the session
   * exists, and null on the chase portal, which is answering a request rather
   * than browsing a workspace.
   */
  home: BusinessPortalHome | null;
  /** When the paid period renews — the synthetic subscribed screen shows it. */
  renewsOn: string | null;
  busy: boolean;
  fault: PortalFault | null;
  clearFault: () => void;
  /** Email in, `202` back, step moves to the code. False only on a fault. */
  sendCode: (email: string) => Promise<boolean>;
  /** The same request again, for a code that never arrived. */
  resendCode: () => Promise<boolean>;
  /** Back to step one, keeping nothing — the address may have been mistyped. */
  changeEmail: () => void;
  /** The six digits. True opens the session and lands on the welcome step. */
  verify: (otp: string) => Promise<boolean>;
  /** welcome → details. No request — just the journey moving on. */
  beginDetails: () => void;
  /**
   * The details step's Continue: send what was answered (PUT
   * /portal/business-profile), then move on. An EMPTY draft sends nothing at
   * all — the step is skippable by design, because a missing company number
   * must never stand between a client and their first receipt. False only on
   * a fault, and the journey stays on the step so nothing typed is lost.
   */
  saveDetails: (profile: BusinessProfileUpdate) => Promise<boolean>;
  /** The details step's Skip — straight on, nothing sent, nothing lost. */
  skipDetails: () => void;
  /** details → subscribe. No request — just the journey moving on. */
  beginSubscription: () => void;
  /**
   * True when the session itself said the business is already entitled — the
   * skip in `beginSubscription` lands on the subscribed step without
   * `subscribe()` ever running, so the view cannot learn it from an outcome.
   */
  alreadySubscribed: boolean;
  subscribe: () => Promise<SubscribeOutcome>;
  /** Into the business portal shell. Seed data only — live, the tab is with Stripe by then. */
  enterPortal: () => void;
}

const faultFrom = (error: unknown): PortalFault =>
  error instanceof NtProblemError
    ? { code: error.code, detail: error.detail ?? error.title }
    : { code: null, detail: null };

/** "27 Sep 2026" — the format every date in the seed cast already wears. */
const renewalDateFrom = (nowMs: number): string =>
  new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export function useOnboardingJourney(setupToken: string | null): OnboardingJourney {
  const synthetic = useSyntheticOnboarding();

  const [step, setStep] = useState<OnboardingStep>('email');
  const [email, setEmail] = useState('');
  const [session, setSession] = useState<OnboardingSession | null>(null);
  const [renewsOn, setRenewsOn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<PortalFault | null>(null);

  // Nothing may set state after the client has closed the tab — `subscribe`
  // ends in a whole-tab redirect, so the tail of that call runs unmounted.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const clearFault = useCallback(() => setFault(null), []);

  /**
   * The setup preview — what the token names, fetched once so the email step
   * can prefill the registered address and the shell can greet the client by
   * workspace before any session exists. A failure is deliberately silent:
   * the preview is a prefill, never a gate (`api/onboarding.ts`).
   */
  const [preview, setPreview] = useState<SetupPreview | null>(null);
  useEffect(() => {
    if (!API_ENABLED || setupToken === null) return;
    let cancelled = false;
    void fetchSetupPreview(setupToken).then((value) => {
      if (!cancelled) setPreview(value);
    });
    return () => {
      cancelled = true;
    };
  }, [setupToken]);

  const requestCode = useCallback(
    async (address: string): Promise<boolean> => {
      setBusy(true);
      setFault(null);
      try {
        if (API_ENABLED) {
          if (!setupToken) return false;
          await requestSignInCode(address, setupToken);
        }
        if (!alive.current) return false;
        setEmail(address);
        setStep('code');
        return true;
      } catch (error) {
        if (alive.current) setFault(faultFrom(error));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [setupToken],
  );

  const sendCode = useCallback((address: string) => requestCode(address), [requestCode]);
  const resendCode = useCallback(() => requestCode(email), [requestCode, email]);

  const changeEmail = useCallback(() => {
    setFault(null);
    setStep('email');
  }, []);

  const verify = useCallback(
    async (otp: string): Promise<boolean> => {
      setBusy(true);
      setFault(null);
      try {
        if (API_ENABLED) {
          if (!setupToken) return false;
          const opened = await openOnboardingSession(email, otp, setupToken);
          if (!alive.current) return false;
          setSession(opened);
          // Adopt the session into the client portal's own sessionStorage slot
          // (5 Sep 2026). An onboarding session IS an own-portal session — the
          // same code-to-the-registered-address credential /portal mints — and
          // sessionStorage is what survives the whole-tab Stripe redirect, so
          // the return leg and the "Open your portal" button land the client
          // INSIDE their portal instead of at a second sign-in. #243's rule
          // stands: sessionStorage, never localStorage, dies with the tab.
          storeSession(opened.token, opened.expiresAt);
        } else {
          synthetic.signIn();
        }
        if (!alive.current) return false;
        setStep('welcome');
        return true;
      } catch (error) {
        if (alive.current) setFault(faultFrom(error));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [setupToken, email, synthetic],
  );

  const beginDetails = useCallback(() => {
    setFault(null);
    setStep('details');
  }, []);

  const beginSubscription = useCallback(() => {
    setFault(null);
    // An already-entitled business skips the subscribe step (5 Sep 2026): a
    // client who reopens their setup link after paying used to be walked back
    // to the £8.50 screen and only learn at the checkout click (the
    // NT-BIL-002 refusal, which remains the server-side guard). The status
    // came with the session, so the journey can say so up front instead.
    if (session?.subscriptionStatus === 'ACTIVE' || session?.subscriptionStatus === 'TRIALING') {
      setStep('subscribed');
      return;
    }
    setStep('subscribe');
  }, [session]);

  const saveDetails = useCallback(
    async (profile: BusinessProfileUpdate): Promise<boolean> => {
      setBusy(true);
      setFault(null);
      try {
        // Only what was answered travels; an empty draft sends nothing at all
        // — the server's own empty-body rule, honoured before the wire. Live
        // only: synthetic mode has no record to write and the step simply
        // walks on (METH_MODE §1).
        if (API_ENABLED && session !== null && Object.keys(profile).length > 0) {
          await updateBusinessProfile(session.token, profile);
        }
        if (!alive.current) return false;
        // The same forward move as Skip — including the already-subscribed
        // jump straight to the subscribed step.
        beginSubscription();
        return true;
      } catch (error) {
        if (alive.current) setFault(faultFrom(error));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [session, beginSubscription],
  );

  const skipDetails = beginSubscription;

  const subscribe = useCallback(async (): Promise<SubscribeOutcome> => {
    setBusy(true);
    setFault(null);
    try {
      if (!API_ENABLED) {
        const settled = synthetic.subscribe();
        if (alive.current) {
          setRenewsOn(settled.renewsOn);
          setStep('subscribed');
        }
        return settled.outcome;
      }

      // The contract gap, degraded honestly: an onboarding session has no way
      // to learn its own businessId yet (`api/onboarding.ts` carries the full
      // note), so until the server sends one the checkout cannot be opened.
      // Nothing has been charged, and the copy says exactly that.
      if (!session?.businessId) {
        const blocked: PortalFault = { code: null, detail: null };
        if (alive.current) setFault(blocked);
        return { kind: 'failed', fault: blocked };
      }

      const url = await startSubscriptionCheckout(session.token, session.businessId);
      // The whole tab goes to Stripe: the checkout shows the VAT and the
      // gross total before the client commits, and no card detail ever
      // touches our origin. Everything after this line runs unmounted.
      window.location.assign(url);
      return { kind: 'redirected' };
    } catch (error) {
      const failure = faultFrom(error);
      // Already subscribed is an outcome, not a failure — the journey is
      // simply further along than the client thought.
      if (failure.code === 'NT-BIL-002') {
        if (alive.current) setStep('subscribed');
        return { kind: 'already' };
      }
      if (alive.current) setFault(failure);
      return { kind: 'failed', fault: failure };
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [session, synthetic]);

  // Live, the session was adopted into the portal's sessionStorage at verify,
  // so the portal address simply resumes it — a real navigation, because the
  // portal is a different shell, not a step of this journey.
  const enterPortal = useCallback(() => {
    if (API_ENABLED) {
      window.location.assign('/portal');
      return;
    }
    synthetic.enterPortal();
  }, [synthetic]);

  /**
   * The client's own workspace, read once the session exists.
   *
   * Fetched on the session rather than on the step, so it is already there when
   * they land on the welcome screen and does not re-request on every step
   * change. A failure is deliberately silent: the home is extra information on
   * a journey that must still complete without it, and a client mid-signup does
   * not need an error about a summary.
   */
  const [home, setHome] = useState<BusinessPortalHome | null>(null);
  useEffect(() => {
    if (!API_ENABLED || session === null) return;
    let cancelled = false;
    void fetchBusinessPortalHome(session.token)
      .then((value) => {
        if (!cancelled) setHome(value);
      })
      .catch(() => {
        if (!cancelled) setHome(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  return {
    live: API_ENABLED,
    step,
    email,
    prefilledEmail: API_ENABLED ? preview?.email ?? null : null,
    businessName: API_ENABLED ? home?.businessName ?? preview?.businessName ?? null : synthetic.businessName,
    home,
    renewsOn,
    busy,
    fault,
    clearFault,
    sendCode,
    resendCode,
    changeEmail,
    verify,
    beginDetails,
    saveDetails,
    skipDetails,
    beginSubscription,
    alreadySubscribed: session?.subscriptionStatus === 'ACTIVE' || session?.subscriptionStatus === 'TRIALING',
    subscribe,
    enterPortal,
  };
}

/* ── the seed-data implementation ─────────────────────────────────────────── */

interface SyntheticOnboarding {
  businessName: string | null;
  signIn: () => void;
  subscribe: () => { renewsOn: string | null; outcome: SubscribeOutcome };
  enterPortal: () => void;
}

/**
 * The same journey against `AppContext`.
 *
 * The account being onboarded is the one that still needs it: the seeded
 * invite if there is one, else the first account with no subscription, else
 * whatever exists — the same forgiving pick `useSyntheticPortal` makes, so a
 * demo walks through without a token. First sign-in activates an invited
 * account (the existing behaviour of the sign-in screen), and subscribing
 * writes the seed-side plan the settings Plan section reads back.
 */
function useSyntheticOnboarding(): SyntheticOnboarding {
  const { businessAccounts, activateBusinessAccount, updateBusinessAccount, openBusinessPortal } = useAppContext();

  const account: BusinessAccount | null = useMemo(
    () =>
      businessAccounts.find((a) => a.status === 'invited')
      ?? businessAccounts.find((a) => !a.subscription)
      ?? businessAccounts[0]
      ?? null,
    [businessAccounts],
  );

  const signIn = useCallback(() => {
    if (account && account.status === 'invited') activateBusinessAccount(account.id);
  }, [account, activateBusinessAccount]);

  const subscribe = useCallback((): { renewsOn: string | null; outcome: SubscribeOutcome } => {
    if (!account) return { renewsOn: null, outcome: { kind: 'failed', fault: { code: null, detail: null } } };
    if (account.subscription?.status === 'active') {
      return { renewsOn: account.subscription.renewsOn ?? null, outcome: { kind: 'already' } };
    }
    const renewsOn = renewalDateFrom(Date.now());
    updateBusinessAccount(account.id, { subscription: { status: 'active', renewsOn } });
    return { renewsOn, outcome: { kind: 'subscribed' } };
  }, [account, updateBusinessAccount]);

  const enterPortal = useCallback(() => {
    if (account) openBusinessPortal(account.id);
  }, [account, openBusinessPortal]);

  return useMemo(
    () => ({ businessName: account?.businessName ?? null, signIn, subscribe, enterPortal }),
    [account, signIn, subscribe, enterPortal],
  );
}
