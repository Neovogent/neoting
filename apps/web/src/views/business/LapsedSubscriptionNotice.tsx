import { CreditCard, Loader2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

/**
 * The lapsed-subscription state (D48) — shown BEFORE the upload control on
 * every surface that has one, never as a refusal after the client has
 * photographed a receipt.
 *
 * ## ⚠ THIS USED TO BE A DEAD END, AND THAT WAS THE BUG
 *
 * The copy read *"Your subscription is not active, so new documents cannot be
 * sent. Your accountant can help you restart it."* — which told the person D48
 * makes the PAYER to telephone somebody else about their own subscription. And
 * it was not even necessary: `POST /billing/checkout-sessions` is contracted,
 * implemented, and explicitly accepts the portal bearer (`PortalSession.
 * businessId` exists for exactly this). The button below is that call.
 *
 * Two things the copy may not do:
 *
 * - **It may not name a price without naming VAT.** £8.50 is exclusive
 *   (§24.5); the VAT amount and the gross total are Stripe's to show, on the
 *   page this button opens.
 * - **It may not promise the subscription is live afterwards.** Reaching the
 *   Stripe return address is not proof of payment — the subscription is active
 *   when the webhook says so.
 */

const m = defineMessages({
  heading: { id: 'portal.lapsedSubscription.heading', defaultMessage: 'Your subscription is not active' },
  body: {
    id: 'portal.lapsedSubscription.body',
    defaultMessage:
      'New documents cannot be sent until it is running again. Everything you have already sent is safe and your accountant still has it.',
  },
  // Never a bare figure — exclusive of VAT and labelled as such (§24.5).
  price: { id: 'portal.lapsedSubscription.price', defaultMessage: '£8.50 + VAT per month' },
  action: { id: 'portal.lapsedSubscription.action', defaultMessage: 'Restart my subscription' },
  working: { id: 'portal.lapsedSubscription.working', defaultMessage: 'Opening Stripe…' },
  note: {
    id: 'portal.lapsedSubscription.note',
    defaultMessage:
      'Payment is taken on Stripe’s own pages, where the VAT and the total are shown before you commit. No card details are stored here.',
  },
});

export function LapsedSubscriptionNotice({
  onSubscribe,
  busy,
}: {
  readonly onSubscribe: () => void;
  readonly busy: boolean;
}) {
  const intl = useIntl();

  return (
    <section role="alert" className="rounded-[28px] border border-amber-500/25 bg-amber-500/[0.06] p-5 md:p-6">
      <h2 className="text-[15px] font-bold text-amber-300 tracking-tight">{intl.formatMessage(m.heading)}</h2>
      <p className="text-[13px] text-zinc-300 mt-2 leading-relaxed">{intl.formatMessage(m.body)}</p>
      <p className="text-[13px] text-white font-bold mt-3">{intl.formatMessage(m.price)}</p>
      <button
        onClick={onSubscribe}
        disabled={busy}
        className="mt-4 flex items-center gap-2 px-5 py-3 rounded-full bg-brand text-brand-on text-[14px] font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-hover transition-colors"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} strokeWidth={2.5} />}
        {busy ? intl.formatMessage(m.working) : intl.formatMessage(m.action)}
      </button>
      <p className="text-[12px] text-zinc-500 mt-3 leading-relaxed">{intl.formatMessage(m.note)}</p>
    </section>
  );
}
