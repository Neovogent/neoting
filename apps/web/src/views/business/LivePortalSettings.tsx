import { lazy, Suspense, type ReactNode } from 'react';
import { Bell, Building2, Camera, CreditCard, KeyRound, Loader2, LogOut, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import type { SubscriptionStatus } from '@neoting/contracts/model';
import type { BusinessPortalHome } from '../../api/onboarding';
import { SectionStrip } from '../../components/DynamicComponents/SectionStrip';
import { PortalPill } from './PortalStatusPill';
import { Panel } from './LivePortalHome';
import { sectionsForTab } from './portalTabs';

/**
 * ⚠ **Lazy, and it is a BUDGET rule rather than a tidy-up.** The portal route is
 * the surface this product promises will load on a bad connection in a car park,
 * and it is the tightest budget in the app. `LivePortalPeople` brings the four
 * generated client functions and their Zod schemas with it, so the whole of it
 * lands on a chunk that is fetched only when a client actually opens People —
 * which most never will.
 */
const LivePortalPeople = lazy(() => import('./LivePortalPeople'));

/**
 * Settings the business owns — and, much more importantly, only the ones it
 * can actually change.
 *
 * ## ⚠ WHY MOST OF THIS SCREEN IS READ-ONLY, AND WHY THAT IS THE CORRECT BUILD
 *
 * The prototype's Settings tab has toggles for notification preferences,
 * capture defaults, business details and a member list. **None of those has a
 * server path in this release.** Rendering them as live controls would write to
 * React state, look like it worked, and evaporate on reload — and this repo's
 * rule is that a control whose write the next poll reverts is worse than no
 * control at all. So what is here is what is true:
 *
 * | section | what it does |
 * |---|---|
 * | Business | states the name on file. Read-only; the practice owns the record. |
 * | Plan | **real** — status, renewal, and both Stripe doors (checkout, customer portal). |
 * | Sending | explains what happens to a document. No settings; the capture preference is on the Capture tab and lasts one visit. |
 * | Notifications | states how the accountant contacts them. No preferences exist to change. |
 * | People | states how anyone else would sign in. Adding someone is the accountant's, and there is no portal operation for it. |
 * | Security | **real** — how sign-in works, when this session ends, and sign out. |
 *
 * ## The plan section IS correct here, unlike in the prototype
 *
 * The prototype deliberately has no billing section because in that design the
 * practice is the payer. D48 makes the CLIENT the payer at £8.50 + VAT per
 * month, so the person reading this screen is the person being charged, and a
 * portal that could not show them what they pay for — or let them stop — would
 * be a subscription they cannot leave.
 */

const m = defineMessages({
  sectionBusiness: { id: 'portal.livePortalSettings.sectionBusiness', defaultMessage: 'Business' },
  sectionPlan: { id: 'portal.livePortalSettings.sectionPlan', defaultMessage: 'Plan' },
  sectionSending: { id: 'portal.livePortalSettings.sectionSending', defaultMessage: 'Sending' },
  sectionNotifications: { id: 'portal.livePortalSettings.sectionNotifications', defaultMessage: 'Notifications' },
  sectionPeople: { id: 'portal.livePortalSettings.sectionPeople', defaultMessage: 'People' },
  sectionSecurity: { id: 'portal.livePortalSettings.sectionSecurity', defaultMessage: 'Security' },
  sectionsLabel: { id: 'portal.livePortalSettings.sectionsLabel', defaultMessage: 'Settings sections' },

  businessTitle: { id: 'portal.livePortalSettings.businessTitle', defaultMessage: 'Your business' },
  businessSubtitle: {
    id: 'portal.livePortalSettings.businessSubtitle',
    defaultMessage: 'Held by your accountant — ask them to change any of it',
  },
  businessNameLabel: { id: 'portal.livePortalSettings.businessNameLabel', defaultMessage: 'Business name' },
  signedInAsLabel: { id: 'portal.livePortalSettings.signedInAsLabel', defaultMessage: 'Signed in as' },
  businessNote: {
    id: 'portal.livePortalSettings.businessNote',
    defaultMessage:
      'These details are on your accountant’s record of you, not on this portal, so they are shown here and changed there. Tell them and it changes everywhere at once.',
  },

  planTitle: { id: 'portal.livePortalSettings.planTitle', defaultMessage: 'Your plan' },
  planSubtitle: {
    id: 'portal.livePortalSettings.planSubtitle',
    defaultMessage: 'One plan — everything your accountant set up here is included',
  },
  planStatusLabel: { id: 'portal.livePortalSettings.planStatusLabel', defaultMessage: 'Status' },
  planRenewsLabel: { id: 'portal.livePortalSettings.planRenewsLabel', defaultMessage: 'Renews on' },
  planPriceLabel: { id: 'portal.livePortalSettings.planPriceLabel', defaultMessage: 'Price' },
  // Never a bare figure: exclusive of VAT and labelled as such (§24.5).
  planPriceValue: { id: 'portal.livePortalSettings.planPriceValue', defaultMessage: '£8.50 + VAT per month' },
  planPriceNote: {
    id: 'portal.livePortalSettings.planPriceNote',
    defaultMessage: 'Shown excluding VAT. The VAT and the total are on your Stripe invoice, in sterling.',
  },
  planManageAction: { id: 'portal.livePortalSettings.planManageAction', defaultMessage: 'Manage billing in Stripe' },
  planManageNote: {
    id: 'portal.livePortalSettings.planManageNote',
    defaultMessage:
      'Card changes, invoices and cancellation are all on Stripe’s own billing pages — nothing about your card is stored here.',
  },
  planSubscribeAction: { id: 'portal.livePortalSettings.planSubscribeAction', defaultMessage: 'Start my subscription' },
  planWorking: { id: 'portal.livePortalSettings.planWorking', defaultMessage: 'Opening Stripe…' },
  // ⚠ The one honest thing to say when the server did not send a plan: this is
  // "we were not told", not "you have not paid".
  planUnknown: {
    id: 'portal.livePortalSettings.planUnknown',
    defaultMessage: 'Your plan details are not available on this screen yet.',
  },
  planActiveWithoutDetail: {
    id: 'portal.livePortalSettings.planActiveWithoutDetail',
    defaultMessage: 'Your subscription is running and you can send documents.',
  },
  planLapsedWithoutDetail: {
    id: 'portal.livePortalSettings.planLapsedWithoutDetail',
    defaultMessage: 'Your subscription is not running, so new documents cannot be sent.',
  },

  statusIncomplete: { id: 'portal.livePortalSettings.statusIncomplete', defaultMessage: 'Not finished' },
  statusIncompleteExpired: { id: 'portal.livePortalSettings.statusIncompleteExpired', defaultMessage: 'Expired' },
  statusTrialing: { id: 'portal.livePortalSettings.statusTrialing', defaultMessage: 'Trial' },
  statusActive: { id: 'portal.livePortalSettings.statusActive', defaultMessage: 'Active' },
  statusPastDue: { id: 'portal.livePortalSettings.statusPastDue', defaultMessage: 'Payment overdue' },
  statusCanceled: { id: 'portal.livePortalSettings.statusCanceled', defaultMessage: 'Cancelled' },
  statusUnpaid: { id: 'portal.livePortalSettings.statusUnpaid', defaultMessage: 'Unpaid' },
  statusPaused: { id: 'portal.livePortalSettings.statusPaused', defaultMessage: 'Paused' },

  sendingTitle: { id: 'portal.livePortalSettings.sendingTitle', defaultMessage: 'How documents are handled' },
  sendingSubtitle: {
    id: 'portal.livePortalSettings.sendingSubtitle',
    defaultMessage: 'What happens after you press send',
  },
  sendingClassifyTitle: {
    id: 'portal.livePortalSettings.sendingClassifyTitle',
    defaultMessage: 'You never have to sort them',
  },
  sendingClassifyBody: {
    id: 'portal.livePortalSettings.sendingClassifyBody',
    defaultMessage:
      'Bills, receipts and sales invoices can all go in together. Your accountant sees what was read off each one and can correct it — nothing is filed on a guess.',
  },
  sendingCaptureTitle: {
    id: 'portal.livePortalSettings.sendingCaptureTitle',
    defaultMessage: 'Camera preferences are on the Capture tab',
  },
  sendingCaptureBody: {
    id: 'portal.livePortalSettings.sendingCaptureBody',
    defaultMessage:
      '“Send as I shoot” lives beside the shutter, and it lasts for this visit only — there is nowhere to save it yet, so it is not offered as though there were.',
  },
  sendingLimitTitle: { id: 'portal.livePortalSettings.sendingLimitTitle', defaultMessage: 'Size and formats' },
  sendingLimitBody: {
    id: 'portal.livePortalSettings.sendingLimitBody',
    defaultMessage:
      'Up to 25MB per document — PDF, JPG, PNG, HEIC, a Word document or a CSV/Excel statement. Photographs are made smaller on your phone before they are sent, so a bad signal is not a bad receipt.',
  },

  notificationsTitle: { id: 'portal.livePortalSettings.notificationsTitle', defaultMessage: 'When we contact you' },
  notificationsSubtitle: {
    id: 'portal.livePortalSettings.notificationsSubtitle',
    defaultMessage: 'Everything comes by email',
  },
  notificationsBody: {
    id: 'portal.livePortalSettings.notificationsBody',
    defaultMessage:
      'Your accountant emails the address you signed in with when something is missing, and your sign-in codes come the same way. There is no texting on this product.',
  },
  // ⚠ Named as absent rather than rendered as dead toggles. There is no portal
  // operation for a notification preference, and a switch that goes nowhere is
  // worse than no switch.
  notificationsUnavailable: {
    id: 'portal.livePortalSettings.notificationsUnavailable',
    defaultMessage:
      'There are no preferences to change here yet. If the emails are going to the wrong address, tell your accountant — they hold the record.',
  },

  peopleTitle: { id: 'portal.livePortalSettings.peopleTitle', defaultMessage: 'Who can send documents' },
  // ⚠ `peopleSubtitle` and `peopleBody` are RETIRED (2 Sep 2026). They read
  // "Managed by your accountant" and "they cannot be added from this screen",
  // which the product owner ruled wrong: the client's own manager, HR lead or
  // owner adds their staff. The section is `LivePortalPeople` now and carries
  // its own copy. The title stays — it is still the honest name for the list.
  peopleLoading: { id: 'portal.livePortalSettings.peopleLoading', defaultMessage: 'Loading your people…' },

  securityTitle: { id: 'portal.livePortalSettings.securityTitle', defaultMessage: 'Sign-in' },
  securitySubtitle: {
    id: 'portal.livePortalSettings.securitySubtitle',
    defaultMessage: 'Protects everything you send from this portal',
  },
  securityBody: {
    id: 'portal.livePortalSettings.securityBody',
    defaultMessage:
      'There is no password. Each time you sign in, a six-digit code is emailed to your registered address and it works once.',
  },
  // The bearer really does die with the tab, so the copy says so — a client
  // handing their phone to somebody at the till should know that.
  securitySessionBody: {
    id: 'portal.livePortalSettings.securitySessionBody',
    defaultMessage:
      'This sign-in is held in this tab and nowhere else. Closing the tab ends it, and nothing is left on the phone.',
  },
  securityExpiresLabel: { id: 'portal.livePortalSettings.securityExpiresLabel', defaultMessage: 'This visit ends' },
  securityExpiresUnknown: { id: 'portal.livePortalSettings.securityExpiresUnknown', defaultMessage: 'When you close the tab' },
  securityAccessTitle: { id: 'portal.livePortalSettings.securityAccessTitle', defaultMessage: 'What your accountant can do' },
  securityAccessBody: {
    id: 'portal.livePortalSettings.securityAccessBody',
    defaultMessage:
      'They see the documents you send and the figures read off them. They cannot sign in as you, and you only ever see your own business here.',
  },
  signOutAction: { id: 'portal.livePortalSettings.signOutAction', defaultMessage: 'Sign out' },

  fault: {
    id: 'portal.livePortalSettings.fault',
    defaultMessage: 'We could not open Stripe. Try again in a moment — if it keeps failing, tell your accountant.',
  },
});

/**
 * The icon and label for each section.
 *
 * ⚠ **The ORDER and the KEYS are `portalTabs.ts`'s, not this file's** — that
 * module owns the address mapping, and a second list here would be a second
 * opinion about which sections exist. Keying a `Record` off it means a section
 * added there and forgotten here fails to compile rather than rendering a pill
 * with no icon and, worse, an address that opens nothing. What lives here is
 * only what a URL cannot carry: the icon, and the translated label.
 */
const SECTION_CHROME: Record<string, { icon: typeof Building2; label: MessageDescriptor }> = {
  Business: { icon: Building2, label: m.sectionBusiness },
  Plan: { icon: CreditCard, label: m.sectionPlan },
  Sending: { icon: Camera, label: m.sectionSending },
  Notifications: { icon: Bell, label: m.sectionNotifications },
  People: { icon: Users, label: m.sectionPeople },
  Security: { icon: KeyRound, label: m.sectionSecurity },
};

const SECTIONS = sectionsForTab('Settings').map((key) => ({ key, ...SECTION_CHROME[key]! }));

/** Keyed by the contract's enum — machine values, so only the label is copy. */
const STATUS_LABEL: Record<SubscriptionStatus, MessageDescriptor> = {
  INCOMPLETE: m.statusIncomplete,
  INCOMPLETE_EXPIRED: m.statusIncompleteExpired,
  TRIALING: m.statusTrialing,
  ACTIVE: m.statusActive,
  PAST_DUE: m.statusPastDue,
  CANCELED: m.statusCanceled,
  UNPAID: m.statusUnpaid,
  PAUSED: m.statusPaused,
};

const STATUS_TONE: Record<SubscriptionStatus, 'green' | 'amber' | 'red' | 'neutral'> = {
  INCOMPLETE: 'amber',
  INCOMPLETE_EXPIRED: 'red',
  TRIALING: 'green',
  ACTIVE: 'green',
  PAST_DUE: 'amber',
  CANCELED: 'red',
  UNPAID: 'red',
  PAUSED: 'amber',
};

export function LivePortalSettings({
  home,
  email,
  busy,
  fault,
  section,
  onSection,
  sessionToken,
  onSubscribe,
  onManageBilling,
  onSignOut,
}: {
  readonly home: BusinessPortalHome;
  readonly email: string;
  readonly busy: boolean;
  readonly fault: string | null;
  /**
   * ⚠ **The section is an ADDRESS now, not `useState`.** It was local state, so
   * `/portal/settings` always opened on Business and **People could not be
   * linked at all** — an accountant telling a client "go to Settings, then
   * People" had no address to send, and a client who got there could not send it
   * on to their bookkeeper. `portalTabs.ts` maps it; this component renders it.
   */
  readonly section: string;
  readonly onSection: (next: string) => void;
  /** The portal bearer, for the one section that reads a server list. Never persisted. */
  readonly sessionToken: string | null;
  readonly onSubscribe: () => void;
  readonly onManageBilling: () => void;
  readonly onSignOut: () => void;
}) {
  const intl = useIntl();

  return (
    <div className="flex flex-col md:flex-row min-w-0 h-full">
      <aside
        data-tour="portal-settings"
        aria-label={intl.formatMessage(m.sectionsLabel)}
        className="hidden md:block w-56 shrink-0 border-r border-white/5 py-8 px-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <nav className="flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => onSection(s.key)}
              {...(section === s.key ? { 'aria-current': 'true' as const } : {})}
              className={`px-4 py-2.5 rounded-xl text-left text-sm font-semibold transition-all flex items-center gap-3 ${
                section === s.key
                  ? 'bg-card text-white border border-white/5'
                  : 'text-zinc-400 hover:text-white hover:bg-card/50 border border-transparent'
              }`}
            >
              <s.icon size={15} className={section === s.key ? 'text-brand' : ''} />
              {intl.formatMessage(s.label)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="md:hidden shrink-0 border-b border-white/5 pt-2">
        <SectionStrip
          tourKey="portal-settings"
          items={SECTIONS.map((s) => ({ key: s.key, icon: s.icon, label: intl.formatMessage(s.label) }))}
          active={section}
          onSelect={onSection}
        />
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto p-4 md:p-8 pb-safe-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div
          key={section}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl flex flex-col gap-5"
        >
          {section === 'Business' && (
            <Panel title={intl.formatMessage(m.businessTitle)} subtitle={intl.formatMessage(m.businessSubtitle)}>
              <Row label={intl.formatMessage(m.businessNameLabel)} value={home.businessName} />
              <Row label={intl.formatMessage(m.signedInAsLabel)} value={email} />
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">{intl.formatMessage(m.businessNote)}</p>
            </Panel>
          )}

          {section === 'Plan' && (
            <Panel title={intl.formatMessage(m.planTitle)} subtitle={intl.formatMessage(m.planSubtitle)}>
              {home.plan !== null ? (
                <>
                  <Row
                    label={intl.formatMessage(m.planStatusLabel)}
                    value={
                      <PortalPill tone={STATUS_TONE[home.plan.status]}>
                        {intl.formatMessage(STATUS_LABEL[home.plan.status])}
                      </PortalPill>
                    }
                  />
                  {home.plan.currentPeriodEnd !== null && (
                    <Row
                      label={intl.formatMessage(m.planRenewsLabel)}
                      value={intl.formatDate(home.plan.currentPeriodEnd, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'Europe/London',
                      })}
                    />
                  )}
                </>
              ) : (
                <>
                  {/* No plan object: say what IS known — whether documents can
                      be sent — and say plainly that the rest is not available,
                      rather than presenting silence as "not subscribed". */}
                  <p className="text-[13px] text-zinc-300 leading-relaxed">
                    {intl.formatMessage(
                      home.subscriptionActive ? m.planActiveWithoutDetail : m.planLapsedWithoutDetail,
                    )}
                  </p>
                  <p className="text-[12px] text-zinc-500 leading-relaxed mt-2">{intl.formatMessage(m.planUnknown)}</p>
                </>
              )}

              <Row
                label={intl.formatMessage(m.planPriceLabel)}
                value={<span className="text-white font-semibold">{intl.formatMessage(m.planPriceValue)}</span>}
              />
              <p className="text-[12px] text-zinc-600 leading-relaxed mt-1">{intl.formatMessage(m.planPriceNote)}</p>

              <div className="flex flex-col gap-2 mt-4">
                {home.subscriptionActive ? (
                  <button
                    onClick={onManageBilling}
                    disabled={busy}
                    className="self-start flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} strokeWidth={2.5} />}
                    {busy ? intl.formatMessage(m.planWorking) : intl.formatMessage(m.planManageAction)}
                  </button>
                ) : (
                  <button
                    onClick={onSubscribe}
                    disabled={busy}
                    className="self-start flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} strokeWidth={2.5} />}
                    {busy ? intl.formatMessage(m.planWorking) : intl.formatMessage(m.planSubscribeAction)}
                  </button>
                )}
                {fault !== null && (
                  <p role="alert" className="text-[13px] font-semibold text-red-400 leading-relaxed">
                    {intl.formatMessage(m.fault)}
                  </p>
                )}
                <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.planManageNote)}</p>
              </div>
            </Panel>
          )}

          {section === 'Sending' && (
            <Panel title={intl.formatMessage(m.sendingTitle)} subtitle={intl.formatMessage(m.sendingSubtitle)}>
              <div className="flex flex-col gap-3">
                <Note title={intl.formatMessage(m.sendingClassifyTitle)} body={intl.formatMessage(m.sendingClassifyBody)} />
                <Note title={intl.formatMessage(m.sendingCaptureTitle)} body={intl.formatMessage(m.sendingCaptureBody)} />
                <Note title={intl.formatMessage(m.sendingLimitTitle)} body={intl.formatMessage(m.sendingLimitBody)} />
              </div>
            </Panel>
          )}

          {section === 'Notifications' && (
            <Panel
              title={intl.formatMessage(m.notificationsTitle)}
              subtitle={intl.formatMessage(m.notificationsSubtitle)}
            >
              <p className="text-[13px] text-zinc-300 leading-relaxed">{intl.formatMessage(m.notificationsBody)}</p>
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-3">
                {intl.formatMessage(m.notificationsUnavailable)}
              </p>
            </Panel>
          )}

          {/* ⚠ The one section on this screen that is NOT read-only, and the
              exception is the point: it said "Managed by your accountant … they
              cannot be added from this screen", which the product owner ruled
              wrong on 2 Sep 2026. It has a server path now — four contracted
              operations with the authority enforced in the service — so the
              rule this file states everywhere else is satisfied rather than
              bent: this control's write is not reverted by the next poll. */}
          {section === 'People' && (
            <Suspense
              fallback={
                <Panel title={intl.formatMessage(m.peopleTitle)}>
                  <p className="text-[13px] text-zinc-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                    {intl.formatMessage(m.peopleLoading)}
                  </p>
                </Panel>
              }
            >
              <LivePortalPeople sessionToken={sessionToken} />
            </Suspense>
          )}

          {section === 'Security' && (
            <>
              <Panel title={intl.formatMessage(m.securityTitle)} subtitle={intl.formatMessage(m.securitySubtitle)}>
                <p className="text-[13px] text-zinc-300 leading-relaxed">{intl.formatMessage(m.securityBody)}</p>
                <p className="text-[13px] text-zinc-300 leading-relaxed mt-3">
                  {intl.formatMessage(m.securitySessionBody)}
                </p>
                <div className="mt-4">
                  <Row
                    label={intl.formatMessage(m.securityExpiresLabel)}
                    value={
                      home.expiresAt === null
                        ? intl.formatMessage(m.securityExpiresUnknown)
                        : intl.formatTime(home.expiresAt, {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'Europe/London',
                          })
                    }
                  />
                </div>
                <button
                  onClick={onSignOut}
                  className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                >
                  <LogOut size={15} />
                  {intl.formatMessage(m.signOutAction)}
                </button>
              </Panel>
              <Panel title={intl.formatMessage(m.securityAccessTitle)}>
                <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.securityAccessBody)}</p>
              </Panel>
            </>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-white/5 last:border-0">
      <span className="text-[13px] text-zinc-400">{label}</span>
      <span className="text-[13px] text-zinc-200 text-right break-words min-w-0">{value}</span>
    </div>
  );
}

function Note({ title, body }: { title: string; body: string }) {
  return (
    <div className="p-4 rounded-2xl bg-ground/60 border border-white/5">
      <div className="text-sm font-bold text-white">{title}</div>
      <div className="text-[12px] text-zinc-500 mt-1 leading-relaxed">{body}</div>
    </div>
  );
}
