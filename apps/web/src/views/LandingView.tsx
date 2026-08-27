import { defineMessages, useIntl } from 'react-intl';
import {
  ArrowRight,
  CheckCircle2,
  FileDown,
  Inbox,
  LogIn,
  MailQuestion,
  ScanLine,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { Wordmark } from '../assets/Wordmark';
import { linkProps } from '../lib/router';

/**
 * The public landing and pricing page at `/` (launch stage M3) — the app
 * lives at `/app`. This is the most public surface the product has, so D42
 * governs every sentence on it: the product produces a VT Transaction+ import
 * file the accountant imports themselves. It does not post to a ledger, does
 * not connect to a bank, does not sync with Xero and does not file with HMRC —
 * and this page says so out loud rather than leaving it to be inferred,
 * because a pricing page that implies otherwise is the worst place to lie.
 *
 * The price renders as "£8.50 + VAT per month", never a bare figure — prices
 * are stored exclusive of VAT and shown exclusive of VAT, labelled as such.
 *
 * The footer carries the company identity the Companies (Trading Disclosures)
 * Regulations require on the website: registered name, company number and
 * registered office, taken verbatim from Shakib's S6 drafts in `docs/legal/`.
 * The VAT registration number is not known yet (the drafts mark it
 * unresolved), so it renders as [PLACEHOLDER] — grep for it before launch,
 * exactly as M4 will for the legal pages.
 */

const m = defineMessages({
  wordmarkTitle: {
    id: 'landing.landingView.wordmarkTitle',
    defaultMessage: 'Neo Accounting',
    description: 'Accessible name for the product wordmark on the landing page. A product name — leave untranslated.',
  },
  headerNavLabel: { id: 'landing.landingView.headerNavLabel', defaultMessage: 'Landing page' },
  headerPricing: { id: 'landing.landingView.headerPricing', defaultMessage: 'Pricing' },
  headerSignIn: { id: 'landing.landingView.headerSignIn', defaultMessage: 'Sign in' },

  heroTitle: {
    id: 'landing.landingView.heroTitle',
    defaultMessage: 'Client paperwork in. A VT import file out. A human in between.',
  },
  heroLede: {
    id: 'landing.landingView.heroLede',
    defaultMessage:
      'UK accounting practices use Neo Accounting to collect their clients’ receipts and invoices, read and code them automatically, and chase the client for whatever is missing — then produce a VT Transaction+ import file with the original document reachable from every line. Nothing is booked until someone in your practice approves it.',
  },
  /**
   * ⚠ THIS CTA POINTED AT `/app` UNTIL LAUNCH M9, AND HAD TO — there was no
   * signup screen for it to point at, so the only honest word for the button
   * was "sign in". M9 built one, and a landing page whose primary action sends
   * a prospective customer to a login wall they cannot pass is the gap that
   * stage exists to close. `headerSignIn` above is still the door for someone
   * who already has an account.
   */
  heroCta: { id: 'landing.landingView.heroCta', defaultMessage: 'Create your account' },
  heroSecondary: { id: 'landing.landingView.heroSecondary', defaultMessage: 'See the price' },

  howTitle: { id: 'landing.landingView.howTitle', defaultMessage: 'How it works' },
  stepCollectTitle: { id: 'landing.landingView.stepCollectTitle', defaultMessage: 'Collect' },
  stepCollectBody: {
    id: 'landing.landingView.stepCollectBody',
    defaultMessage:
      'Your clients photograph receipts and upload invoices to their own secure portal. Everything lands in one inbox for your practice — no more shoeboxes, no more email threads.',
  },
  stepReadTitle: { id: 'landing.landingView.stepReadTitle', defaultMessage: 'Read and code' },
  stepReadBody: {
    id: 'landing.landingView.stepReadBody',
    defaultMessage:
      'Each document is read automatically: supplier, date, VAT and total are extracted and a coding is suggested, with the original image kept alongside the figures.',
  },
  stepChaseTitle: { id: 'landing.landingView.stepChaseTitle', defaultMessage: 'Chase' },
  stepChaseBody: {
    id: 'landing.landingView.stepChaseBody',
    defaultMessage:
      'When paperwork is missing, the client is chased by email with a secure upload link — so the asking, the reminding and the collecting stop being your team’s job.',
  },
  stepApproveTitle: { id: 'landing.landingView.stepApproveTitle', defaultMessage: 'Approve' },
  stepApproveBody: {
    id: 'landing.landingView.stepApproveBody',
    defaultMessage:
      'Your team reviews every extracted entry and corrects anything the reading got wrong. Nothing changes state without a named human approving it first.',
  },
  stepExportTitle: { id: 'landing.landingView.stepExportTitle', defaultMessage: 'Export for VT' },
  stepExportBody: {
    id: 'landing.landingView.stepExportBody',
    defaultMessage:
      'Download a VT Transaction+ import file of the approved entries. Every line carries a working link back to the source document, so the evidence is one click from the books.',
  },

  honestTitle: { id: 'landing.landingView.honestTitle', defaultMessage: 'Said plainly' },
  honestLede: {
    id: 'landing.landingView.honestLede',
    defaultMessage:
      'Neo Accounting produces an import file for VT Transaction+ that you download and import yourself. We would rather you know exactly where its edges are before you trust it with a client.',
  },
  honestDoesLabel: { id: 'landing.landingView.honestDoesLabel', defaultMessage: 'What it does' },
  honestDoes1: {
    id: 'landing.landingView.honestDoes1',
    defaultMessage: 'Collects, reads and codes client receipts and invoices',
  },
  honestDoes2: {
    id: 'landing.landingView.honestDoes2',
    defaultMessage: 'Chases clients by email for missing paperwork',
  },
  honestDoes3: {
    id: 'landing.landingView.honestDoes3',
    defaultMessage: 'Produces a VT Transaction+ import file, every line linked to its source document',
  },
  honestNotLabel: { id: 'landing.landingView.honestNotLabel', defaultMessage: 'What it does not do' },
  honestNot1: { id: 'landing.landingView.honestNot1', defaultMessage: 'It does not post to a ledger' },
  honestNot2: { id: 'landing.landingView.honestNot2', defaultMessage: 'It does not connect to your bank' },
  honestNot3: {
    id: 'landing.landingView.honestNot3',
    defaultMessage: 'It does not sync with Xero or any accounting software',
  },
  honestNot4: { id: 'landing.landingView.honestNot4', defaultMessage: 'It does not file with HMRC' },

  pricingTitle: { id: 'landing.landingView.pricingTitle', defaultMessage: 'Pricing' },
  pricingFigure: {
    id: 'landing.landingView.pricingFigure',
    defaultMessage: '£8.50 + VAT per month',
    description: 'The one price. Always the full phrase with "+ VAT" — never a bare figure; prices are stored and shown exclusive of VAT.',
  },
  pricingUnit: { id: 'landing.landingView.pricingUnit', defaultMessage: 'per client business' },
  pricingOneTier: {
    id: 'landing.landingView.pricingOneTier',
    defaultMessage: 'One plan. Billed monthly by card, with a VAT invoice for every charge. Cancel any time from the billing portal.',
  },
  pricingIncludes1: {
    id: 'landing.landingView.pricingIncludes1',
    defaultMessage: 'A secure upload portal for the client',
  },
  pricingIncludes2: {
    id: 'landing.landingView.pricingIncludes2',
    defaultMessage: 'Automatic reading and coding of every document',
  },
  pricingIncludes3: {
    id: 'landing.landingView.pricingIncludes3',
    defaultMessage: 'Email chasing for missing paperwork',
  },
  pricingIncludes4: {
    id: 'landing.landingView.pricingIncludes4',
    defaultMessage: 'Review and approval by your practice',
  },
  pricingIncludes5: {
    id: 'landing.landingView.pricingIncludes5',
    defaultMessage: 'VT Transaction+ export with a source link on every line',
  },

  supportTitle: { id: 'landing.landingView.supportTitle', defaultMessage: 'Support' },
  supportBody: {
    id: 'landing.landingView.supportBody',
    defaultMessage:
      'Support is by email at {email}. We reply within 24 hours. Support hours are 06:00–18:00 UK time.',
  },

  footerNavLabel: { id: 'landing.landingView.footerNavLabel', defaultMessage: 'Legal' },
  footerTerms: { id: 'landing.landingView.footerTerms', defaultMessage: 'Terms of Service' },
  footerPrivacy: { id: 'landing.landingView.footerPrivacy', defaultMessage: 'Privacy Notice' },
  footerDpa: { id: 'landing.landingView.footerDpa', defaultMessage: 'Data Processing Terms' },
  footerRefunds: { id: 'landing.landingView.footerRefunds', defaultMessage: 'Refunds and Cancellation' },
  footerCompanyName: {
    id: 'landing.landingView.footerCompanyName',
    defaultMessage: 'NEOVOGENT AI SOLUTIONS UK LTD, trading as Neovogent',
    description: 'The registered company name — a legal identity, leave untranslated.',
  },
  footerCompanyNumber: {
    id: 'landing.landingView.footerCompanyNumber',
    defaultMessage: 'Company number 15946429',
  },
  footerRegisteredOffice: {
    id: 'landing.landingView.footerRegisteredOffice',
    defaultMessage:
      'Registered office: Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham B15 1NP, United Kingdom',
  },
  footerVat: {
    id: 'landing.landingView.footerVat',
    defaultMessage: 'VAT registration number: [PLACEHOLDER]',
    description: 'The VAT registration number is not known yet — Shakib supplies it before launch (docs/legal marks it unresolved). Grep for [PLACEHOLDER] before publishing.',
  },
});

const SUPPORT_EMAIL = 'support@neovogent.com';

const STEPS = [
  { icon: Inbox, title: m.stepCollectTitle, body: m.stepCollectBody },
  { icon: ScanLine, title: m.stepReadTitle, body: m.stepReadBody },
  { icon: MailQuestion, title: m.stepChaseTitle, body: m.stepChaseBody },
  { icon: UserCheck, title: m.stepApproveTitle, body: m.stepApproveBody },
  { icon: FileDown, title: m.stepExportTitle, body: m.stepExportBody },
] as const;

const DOES = [m.honestDoes1, m.honestDoes2, m.honestDoes3] as const;
const DOES_NOT = [m.honestNot1, m.honestNot2, m.honestNot3, m.honestNot4] as const;
const INCLUDES = [
  m.pricingIncludes1,
  m.pricingIncludes2,
  m.pricingIncludes3,
  m.pricingIncludes4,
  m.pricingIncludes5,
] as const;

const LEGAL_LINKS = [
  { to: '/legal/terms-of-service', label: m.footerTerms },
  { to: '/legal/privacy-notice', label: m.footerPrivacy },
  { to: '/legal/data-processing-terms', label: m.footerDpa },
  { to: '/legal/refund-and-cancellation', label: m.footerRefunds },
] as const;

export function LandingView() {
  const intl = useIntl();

  return (
    <div className="min-h-dvh bg-ground text-white font-sans selection:bg-brand/30 px-safe">
      <div className="max-w-5xl mx-auto px-5 sm:px-8">
        <header className="flex items-center justify-between gap-4 py-6">
          <Wordmark title={intl.formatMessage(m.wordmarkTitle)} size={20} className="text-white" />
          <nav aria-label={intl.formatMessage(m.headerNavLabel)} className="flex items-center gap-2 sm:gap-4">
            <a
              href="#pricing"
              className="px-3 py-2 text-[13px] font-semibold text-zinc-400 hover:text-white transition-colors rounded-full"
            >
              {intl.formatMessage(m.headerPricing)}
            </a>
            <a
              {...linkProps('/app')}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-card border border-white/10 hover:border-brand/40 transition-colors"
            >
              <LogIn size={14} strokeWidth={2.5} aria-hidden="true" />
              {intl.formatMessage(m.headerSignIn)}
            </a>
          </nav>
        </header>

        <main>
          <section className="pt-14 pb-16 sm:pt-24 sm:pb-24 max-w-3xl">
            <h1 className="font-sans font-extrabold tracking-tight text-4xl sm:text-5xl leading-[1.08] text-white">
              {intl.formatMessage(m.heroTitle)}
            </h1>
            <p className="mt-6 text-[16px] sm:text-[17px] text-zinc-400 leading-relaxed">
              {intl.formatMessage(m.heroLede)}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                {...linkProps('/signup')}
                className="flex items-center gap-2 px-7 py-3.5 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
              >
                {intl.formatMessage(m.heroCta)}
                <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" />
              </a>
              <a
                href="#pricing"
                className="px-7 py-3.5 rounded-full text-[14px] font-bold text-zinc-300 border border-white/10 hover:border-brand/40 transition-colors"
              >
                {intl.formatMessage(m.heroSecondary)}
              </a>
            </div>
          </section>

          <section aria-labelledby="landing-how" className="pb-16 sm:pb-24">
            <h2
              id="landing-how"
              className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest mb-6"
            >
              {intl.formatMessage(m.howTitle)}
            </h2>
            <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                return (
                  <li
                    key={step.title.id}
                    className="rounded-3xl bg-card border border-white/5 p-6 flex flex-col gap-3"
                  >
                    <span className="w-10 h-10 rounded-2xl bg-brand/10 text-brand flex items-center justify-center">
                      <Icon size={18} strokeWidth={2.25} aria-hidden="true" />
                    </span>
                    <h3 className="text-[15px] font-bold text-white tracking-tight">
                      {/* The step number is data (an index), not copy — the
                          visible title is the message beside it. */}
                      <span className="text-zinc-600 tabular-nums mr-2" aria-hidden="true">{i + 1}</span>
                      {intl.formatMessage(step.title)}
                    </h3>
                    <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(step.body)}</p>
                  </li>
                );
              })}
            </ol>
          </section>

          <section aria-labelledby="landing-honest" className="pb-16 sm:pb-24">
            <div className="rounded-3xl bg-card border border-white/5 p-6 sm:p-10">
              <h2 id="landing-honest" className="text-2xl font-extrabold tracking-tight text-white">
                {intl.formatMessage(m.honestTitle)}
              </h2>
              <p className="mt-3 max-w-2xl text-[14px] text-zinc-400 leading-relaxed">
                {intl.formatMessage(m.honestLede)}
              </p>
              <div className="mt-8 grid gap-8 sm:grid-cols-2">
                <div>
                  <h3 className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest mb-4">
                    {intl.formatMessage(m.honestDoesLabel)}
                  </h3>
                  <ul className="flex flex-col gap-3">
                    {DOES.map((item) => (
                      <li key={item.id} className="flex items-start gap-3 text-[14px] text-zinc-300 leading-relaxed">
                        <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-brand" aria-hidden="true" />
                        {intl.formatMessage(item)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest mb-4">
                    {intl.formatMessage(m.honestNotLabel)}
                  </h3>
                  <ul className="flex flex-col gap-3">
                    {DOES_NOT.map((item) => (
                      <li key={item.id} className="flex items-start gap-3 text-[14px] text-zinc-300 leading-relaxed">
                        <XCircle size={16} className="shrink-0 mt-0.5 text-zinc-600" aria-hidden="true" />
                        {intl.formatMessage(item)}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>

          <section id="pricing" aria-labelledby="landing-pricing" className="pb-16 sm:pb-24 scroll-mt-6">
            <h2
              id="landing-pricing"
              className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest mb-6"
            >
              {intl.formatMessage(m.pricingTitle)}
            </h2>
            <div className="rounded-3xl bg-card border border-brand/20 p-6 sm:p-10 max-w-2xl">
              <p className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                {intl.formatMessage(m.pricingFigure)}
              </p>
              <p className="mt-1 text-[13px] font-bold text-brand uppercase tracking-widest">
                {intl.formatMessage(m.pricingUnit)}
              </p>
              <ul className="mt-8 flex flex-col gap-3">
                {INCLUDES.map((item) => (
                  <li key={item.id} className="flex items-start gap-3 text-[14px] text-zinc-300 leading-relaxed">
                    <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-brand" aria-hidden="true" />
                    {intl.formatMessage(item)}
                  </li>
                ))}
              </ul>
              <p className="mt-8 text-[13px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.pricingOneTier)}
              </p>
              <a
                {...linkProps('/signup')}
                className="mt-6 inline-flex items-center gap-2 px-7 py-3.5 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
              >
                {intl.formatMessage(m.heroCta)}
                <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" />
              </a>
            </div>
          </section>

          <section aria-labelledby="landing-support" className="pb-16 sm:pb-24">
            <h2
              id="landing-support"
              className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest mb-4"
            >
              {intl.formatMessage(m.supportTitle)}
            </h2>
            <p className="max-w-2xl text-[14px] text-zinc-400 leading-relaxed">
              {intl.formatMessage(m.supportBody, {
                email: (
                  <a
                    key="support-email"
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="font-semibold text-brand hover:text-brand-hover transition-colors"
                  >
                    {SUPPORT_EMAIL}
                  </a>
                ),
              })}
            </p>
          </section>
        </main>

        <footer className="border-t border-white/5 py-10 flex flex-col gap-6 pb-safe-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <Wordmark title={intl.formatMessage(m.wordmarkTitle)} size={14} className="text-zinc-400" />
            <nav aria-label={intl.formatMessage(m.footerNavLabel)}>
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {LEGAL_LINKS.map((link) => (
                  <li key={link.to}>
                    <a
                      {...linkProps(link.to)}
                      className="text-[12px] font-semibold text-zinc-500 hover:text-white transition-colors"
                    >
                      {intl.formatMessage(link.label)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="flex flex-col gap-1 text-[11px] text-zinc-600 leading-relaxed">
            <p>{intl.formatMessage(m.footerCompanyName)}</p>
            <p>
              {intl.formatMessage(m.footerCompanyNumber)}
              <span aria-hidden="true"> · </span>
              {intl.formatMessage(m.footerVat)}
            </p>
            <p>{intl.formatMessage(m.footerRegisteredOffice)}</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
