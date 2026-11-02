import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import { initialParams, setPortalAddOn, usePortalTaxEstimate, type Country, type EstimateParams } from '../../api/taxEstimate';
import { TaxEstimatePanel } from '../../components/DynamicComponents/TaxEstimatePanel';

/**
 * The client's own Tax estimate tab (D52). The client pays for the add-on, so
 * the client sees it — and, when they may manage the plan, adds it from here.
 *
 * Adding it is a 202: Stripe is told, and the webhook switches it on a few
 * seconds later. Until then the tab polls and says so, rather than showing
 * the offer again as if nothing had happened.
 */

const m = defineMessages({
  offerTitle: { id: 'portal.tax.offerTitle', defaultMessage: 'See what your tax is likely to be' },
  offerBody: {
    id: 'portal.tax.offerBody',
    defaultMessage:
      'An estimate of your {country, select, AU {BAS (GST)} other {VAT return}} and your company tax, worked out from the receipts, invoices and bank statements you have already sent, with a range and a score for how complete it is. It is for reference only and cannot be submitted.',
  },
  offerPrice: { id: 'portal.tax.offerPrice', defaultMessage: '{country, select, AU {A$30 a month} other {£15 a month plus VAT}}, added to your plan.' },
  offerAction: { id: 'portal.tax.offerAction', defaultMessage: 'Add it to my plan' },
  offerWorking: { id: 'portal.tax.offerWorking', defaultMessage: 'Adding it…' },
  offerWaiting: {
    id: 'portal.tax.offerWaiting',
    defaultMessage: 'Added. Stripe is confirming the change; this page will update by itself in a few seconds.',
  },
  offerNotOwner: {
    id: 'portal.tax.offerNotOwner',
    defaultMessage: 'Ask the person who manages your plan to add it from Settings → Plan.',
  },
  offerNoPlan: { id: 'portal.tax.offerNoPlan', defaultMessage: 'Start your subscription first; the estimate is added on top of it.' },
  offerFailed: { id: 'portal.tax.offerFailed', defaultMessage: 'That did not go through: {reason}' },
});

export interface LivePortalTaxProps {
  readonly token: string;
  readonly businessId: string | null;
  readonly businessName: string;
  readonly country: Country;
  readonly canManageBilling: boolean;
  readonly subscriptionActive: boolean;
  /** Re-reads the portal home, so the Plan section shows the add-on too. */
  readonly onChanged: () => void;
}

export function LivePortalTax({ token, businessId, businessName, country, canManageBilling, subscriptionActive, onChanged }: LivePortalTaxProps) {
  const intl = useIntl();
  const [params, setParams] = useState<EstimateParams>(() => initialParams());
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const query = usePortalTaxEstimate(token, params, waitingSince !== null);
  // A ref, so a parent that hands a fresh callback every render does not restart the wait.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // Stop waiting once the add-on is on, or after a minute — the offer then
  // comes back rather than a spinner that never ends.
  useEffect(() => {
    if (waitingSince === null) return;
    if (query.data?.active === true) {
      setWaitingSince(null);
      changed.current();
      return;
    }
    const left = 60_000 - (Date.now() - waitingSince);
    const timer = window.setTimeout(() => setWaitingSince(null), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [query.data?.active, waitingSince]);

  const add = async () => {
    if (businessId === null) return;
    setBusy(true);
    setFault(null);
    try {
      await setPortalAddOn(token, businessId, 'TAX_ESTIMATE', true);
      setWaitingSince(Date.now());
    } catch (error) {
      setFault(error instanceof NtProblemError ? `${error.code} — ${error.detail ?? error.title}` : String(error));
    } finally {
      setBusy(false);
    }
  };

  const offer = (
    <div className="rounded-2xl border border-white/10 bg-card p-5">
      <h3 className="text-[16px] font-semibold text-white">{intl.formatMessage(m.offerTitle)}</h3>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-300">{intl.formatMessage(m.offerBody, { country })}</p>
      <p className="mt-2 text-[14px] font-semibold text-white">{intl.formatMessage(m.offerPrice, { country })}</p>
      <div className="mt-4 flex flex-col gap-2">
        {waitingSince !== null ? (
          <p role="status" className="flex items-center gap-2 text-[13px] text-zinc-300">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            {intl.formatMessage(m.offerWaiting)}
          </p>
        ) : !subscriptionActive ? (
          <p className="text-[13px] text-zinc-400">{intl.formatMessage(m.offerNoPlan)}</p>
        ) : !canManageBilling ? (
          <p className="text-[13px] text-zinc-400">{intl.formatMessage(m.offerNotOwner)}</p>
        ) : (
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || businessId === null}
            className="self-start rounded-full bg-brand px-5 py-2.5 text-[13px] font-bold text-brand-on hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? intl.formatMessage(m.offerWorking) : intl.formatMessage(m.offerAction)}
          </button>
        )}
        {fault !== null && (
          <p role="alert" className="text-[13px] font-semibold text-red-400">
            {intl.formatMessage(m.offerFailed, { reason: fault })}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <TaxEstimatePanel
        country={country}
        view={query.data}
        loading={query.isPending}
        error={query.error}
        params={params}
        onParams={setParams}
        subject={businessName}
        inactive={offer}
      />
    </div>
  );
}
