import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import { setPortalAddOn, type Country } from '../../api/taxEstimate';

/**
 * The Plan section's add-ons (D51 Document Vault, D52 tax estimate): what each
 * costs, whether it is on, and a button to add or remove it. Lazy from
 * `LivePortalSettings`, so the billing call only downloads when Plan is open.
 *
 * ⚠ The button tells Stripe; the webhook decides. So after a press the row
 * says "Updating…" and re-reads the portal home until the flag flips (up to a
 * minute), rather than flipping a switch locally that Stripe has not confirmed.
 */

type AddOn = 'TAX_ESTIMATE' | 'DOCUMENT_VAULT';

const m = defineMessages({
  title: { id: 'portal.addOns.title', defaultMessage: 'Add-ons' },
  taxName: { id: 'portal.addOns.taxName', defaultMessage: 'Tax estimate' },
  taxBody: {
    id: 'portal.addOns.taxBody',
    defaultMessage: 'An estimate of your {country, select, AU {BAS (GST)} other {VAT return}} and company tax, for reference. It cannot be submitted.',
  },
  taxPrice: { id: 'portal.addOns.taxPrice', defaultMessage: '{country, select, AU {A$30 per month} other {£15 + VAT per month}}' },
  vaultName: { id: 'portal.addOns.vaultName', defaultMessage: 'Document Vault' },
  vaultBody: { id: 'portal.addOns.vaultBody', defaultMessage: 'Your own searchable archive of everything you send, with ZIP download and a copy to your own drive.' },
  vaultPrice: { id: 'portal.addOns.vaultPrice', defaultMessage: '£2 + VAT per month' },
  on: { id: 'portal.addOns.on', defaultMessage: 'On' },
  off: { id: 'portal.addOns.off', defaultMessage: 'Off' },
  add: { id: 'portal.addOns.add', defaultMessage: 'Add' },
  remove: { id: 'portal.addOns.remove', defaultMessage: 'Remove' },
  updating: { id: 'portal.addOns.updating', defaultMessage: 'Updating — Stripe is confirming…' },
  needsPlan: { id: 'portal.addOns.needsPlan', defaultMessage: 'Add-ons go on top of a running subscription.' },
  failed: { id: 'portal.addOns.failed', defaultMessage: 'That did not go through: {reason}' },
});

export interface PortalAddOnsProps {
  readonly token: string;
  readonly businessId: string;
  readonly country: Country;
  readonly addOns: { readonly taxEstimate: boolean; readonly documentVault: boolean };
  readonly subscriptionActive: boolean;
  /** Re-reads the portal home. */
  readonly onChanged: () => void;
}

export function PortalAddOns({ token, businessId, country, addOns, subscriptionActive, onChanged }: PortalAddOnsProps) {
  const intl = useIntl();
  const [pending, setPending] = useState<{ addOn: AddOn; enabled: boolean; since: number } | null>(null);
  const [busy, setBusy] = useState<AddOn | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const isOn = (addOn: AddOn) => (addOn === 'TAX_ESTIMATE' ? addOns.taxEstimate : addOns.documentVault);

  useEffect(() => {
    if (pending === null) return;
    if (isOn(pending.addOn) === pending.enabled || Date.now() - pending.since > 60_000) {
      setPending(null);
      return;
    }
    const timer = window.setInterval(() => changed.current(), 3_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `isOn` reads `addOns`, listed
  }, [pending, addOns.taxEstimate, addOns.documentVault]);

  const toggle = async (addOn: AddOn) => {
    const enabled = !isOn(addOn);
    setBusy(addOn);
    setFault(null);
    try {
      await setPortalAddOn(token, businessId, addOn, enabled);
      setPending({ addOn, enabled, since: Date.now() });
      changed.current();
    } catch (error) {
      setFault(error instanceof NtProblemError ? `${error.code} — ${error.detail ?? error.title}` : String(error));
    } finally {
      setBusy(null);
    }
  };

  const rows: { addOn: AddOn; name: string; body: string; price: string }[] = [
    {
      addOn: 'TAX_ESTIMATE',
      name: intl.formatMessage(m.taxName),
      body: intl.formatMessage(m.taxBody, { country }),
      price: intl.formatMessage(m.taxPrice, { country }),
    },
  ];
  // The vault is sold in pounds only so far; an A$ subscription cannot carry a £ item.
  if (country === 'GB') {
    rows.push({ addOn: 'DOCUMENT_VAULT', name: intl.formatMessage(m.vaultName), body: intl.formatMessage(m.vaultBody), price: intl.formatMessage(m.vaultPrice) });
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      <h3 className="text-[14px] font-semibold text-white">{intl.formatMessage(m.title)}</h3>
      {rows.map((row) => {
        const on = isOn(row.addOn);
        const waiting = pending?.addOn === row.addOn;
        return (
          <div key={row.addOn} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-raised px-4 py-3">
            <div className="min-w-[200px] flex-1">
              <p className="text-[14px] font-semibold text-white">
                {row.name} <span className="ml-2 text-[12px] font-normal text-zinc-400">{row.price}</span>
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">{row.body}</p>
            </div>
            {waiting ? (
              <span role="status" className="flex items-center gap-2 text-[12px] text-zinc-300">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                {intl.formatMessage(m.updating)}
              </span>
            ) : (
              <div className="flex items-center gap-3">
                <span className={`text-[12px] font-semibold ${on ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {intl.formatMessage(on ? m.on : m.off)}
                </span>
                <button
                  type="button"
                  disabled={!subscriptionActive || busy !== null}
                  onClick={() => void toggle(row.addOn)}
                  className={
                    on
                      ? 'rounded-full border border-white/10 px-4 py-2 text-[12px] font-semibold text-zinc-200 hover:bg-card disabled:opacity-40'
                      : 'rounded-full bg-brand px-4 py-2 text-[12px] font-bold text-brand-on hover:bg-brand-hover disabled:opacity-40'
                  }
                >
                  {busy === row.addOn ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : intl.formatMessage(on ? m.remove : m.add)}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!subscriptionActive && <p className="text-[12px] text-zinc-500">{intl.formatMessage(m.needsPlan)}</p>}
      {fault !== null && (
        <p role="alert" className="text-[13px] font-semibold text-red-400">
          {intl.formatMessage(m.failed, { reason: fault })}
        </p>
      )}
    </div>
  );
}
