import { useState } from 'react';
import { X, Building2, ArrowRight, Send, Search, Smartphone } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { commonActions, commonLabels, commonPlaceholders } from '../i18n/common';
import { Pill } from './DynamicComponents/DataTable';
import { newBusinessAccount, newMember } from '../lib/business';
import type { Client } from '../lib/types';

/**
 * `accountLine` and `noAccount` are two whole messages rather than one with a
 * conditional: "Priya Nair · created 02 Mar 2026" and "No portal account yet"
 * are different statements, not one statement with a hole in it.
 *
 * Not extracted here: `'You (Practice Admin)'` and `'Primary contact'`. Those
 * are written onto the account record, not rendered from this file, and the
 * seeded accounts in `lib/business.ts` carry the same literals — extracting one
 * end of that pair would only make the two disagree.
 */
const m = defineMessages({
  heading: { id: 'shell.businessPortalLauncher.heading', defaultMessage: 'Business portal' },
  subheading: {
    id: 'shell.businessPortalLauncher.subheading',
    defaultMessage: 'Where your clients send documents from. Open one to see their side.',
  },
  auditAction: {
    id: 'shell.businessPortalLauncher.auditAction',
    defaultMessage: 'Invited a business to the portal',
  },
  auditScope: { id: 'shell.businessPortalLauncher.auditScope', defaultMessage: '{client} — {contact}' },
  auditNoContact: { id: 'shell.businessPortalLauncher.auditNoContact', defaultMessage: 'no contact details' },
  searchPlaceholder: { id: 'shell.businessPortalLauncher.searchPlaceholder', defaultMessage: 'Search clients' },
  accountLine: {
    id: 'shell.businessPortalLauncher.accountLine',
    defaultMessage: '{contact} · created {date}',
  },
  noAccount: { id: 'shell.businessPortalLauncher.noAccount', defaultMessage: 'No portal account yet' },
  statusInvited: { id: 'shell.businessPortalLauncher.statusInvited', defaultMessage: 'Invited' },
  statusSelfSignup: { id: 'shell.businessPortalLauncher.statusSelfSignup', defaultMessage: 'Self signed-up' },
  statusActive: { id: 'shell.businessPortalLauncher.statusActive', defaultMessage: 'Active' },
  openAction: { id: 'shell.businessPortalLauncher.openAction', defaultMessage: 'Open' },
  inviteAction: { id: 'shell.businessPortalLauncher.inviteAction', defaultMessage: 'Invite' },
  noMatches: { id: 'shell.businessPortalLauncher.noMatches', defaultMessage: 'No clients match that search.' },
  awaitingHeading: {
    id: 'shell.businessPortalLauncher.awaitingHeading',
    defaultMessage: 'Waiting on a client to approve',
  },
  awaitingNote: {
    id: 'shell.businessPortalLauncher.awaitingNote',
    defaultMessage:
      'These sit on a stage only the business can clear. The approver gets a secure link by email — open it here to see exactly what they see.',
  },
  awaitingItems: {
    id: 'shell.businessPortalLauncher.awaitingItems',
    defaultMessage: '{count, plural, one {# item} other {# items}} · {suppliers}',
  },
  noMobile: {
    id: 'shell.businessPortalLauncher.noMobile',
    defaultMessage: 'No mobile on file for this client',
  },
  sendRequest: { id: 'shell.businessPortalLauncher.sendRequest', defaultMessage: 'Send the request' },
  openLinkHint: {
    id: 'shell.businessPortalLauncher.openLinkHint',
    defaultMessage: 'See exactly what the approver sees',
  },
  sendFirstHint: { id: 'shell.businessPortalLauncher.sendFirstHint', defaultMessage: 'Send the request first' },
  openLink: { id: 'shell.businessPortalLauncher.openLink', defaultMessage: 'Open the link' },
  selfSignupNote: {
    id: 'shell.businessPortalLauncher.selfSignupNote',
    defaultMessage: 'A business can also sign itself up and be linked to you afterwards.',
  },
  openSignUp: { id: 'shell.businessPortalLauncher.openSignUp', defaultMessage: 'Open the sign-up screen →' },
});

const inviteMessages = defineMessages({
  heading: { id: 'shell.inviteForm.heading', defaultMessage: 'Invite {client}' },
  note: {
    id: 'shell.inviteForm.note',
    defaultMessage: 'They get a link by email. The account stays in Invited until they first sign in.',
  },
  contactNameLabel: { id: 'shell.inviteForm.contactNameLabel', defaultMessage: 'Contact name' },
  emailPlaceholder: { id: 'shell.inviteForm.emailPlaceholder', defaultMessage: 'john@business.co.uk' },
  noMobileWarning: {
    id: 'shell.inviteForm.noMobileWarning',
    defaultMessage: 'Without a mobile number the invite cannot be sent.',
  },
  create: { id: 'shell.inviteForm.create', defaultMessage: 'Create & send invite' },
});

/**
 * The practice side of business-portal accounts: see which clients have one,
 * invite the ones that don't, and open a client's portal to see exactly what
 * they see.
 */
export function BusinessPortalLauncher({ onClose }: { onClose: () => void }) {
  const {
    clients, businessAccounts, openBusinessPortal, createBusinessAccount, logAudit,
    clientSideApprovals, approvalRequests, sendApprovalRequest, openApprovalLink,
  } = useAppContext();
  const intl = useIntl();

  /**
   * Clients with something sitting on a client-side approval stage. This is
   * the practice's way into the approver's own screen — the real one arrives
   * by email, and nobody in the practice ever holds that link.
   */
  const awaitingSignOff = clients
    .map((c) => ({ client: c, items: clientSideApprovals(c.id), request: approvalRequests.find((r) => r.clientId === c.id) }))
    .filter((row) => row.items.length > 0);

  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState<Client | null>(null);

  const accountFor = (clientId: string) => businessAccounts.find((a) => a.clientId === clientId);
  const visible = clients.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl max-h-[88dvh] rounded-[32px] border border-white/5 bg-card shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="p-6 border-b border-white/5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.heading)}</h2>
            <p className="text-[12px] text-zinc-500 mt-1">{intl.formatMessage(m.subheading)}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={intl.formatMessage(commonActions.close)}
            className="p-2 -m-2 rounded-full text-zinc-500 hover:text-white hover:bg-white/5 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {inviting ? (
          <InviteForm
            client={inviting}
            onCancel={() => setInviting(null)}
            onCreate={(contactName, email, mobile) => {
              const account = newBusinessAccount({
                clientId: inviting.id,
                businessName: inviting.name,
                contactName,
                email,
                mobile,
                origin: 'accountant-invite',
                createdBy: 'You (Practice Admin)',
                members: [{ ...newMember(contactName, email), role: 'Owner', canSeeTotals: true }],
              });
              createBusinessAccount(account);
              logAudit({
                action: intl.formatMessage(m.auditAction),
                scope: intl.formatMessage(m.auditScope, {
                  client: inviting.name,
                  contact: mobile || email || intl.formatMessage(m.auditNoContact),
                }),
                reviewOpened: false,
              });
              setInviting(null);
            }}
          />
        ) : (
          <>
            <div className="p-4 border-b border-white/5">
              <div className="relative">
                <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={intl.formatMessage(m.searchPlaceholder)}
                  className="w-full bg-ground border border-white/5 rounded-xl pl-11 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {visible.map((c) => {
                const account = accountFor(c.id);
                return (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-ground/60 border border-white/5 flex-wrap"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1 basis-48">
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shrink-0">
                        <Building2 size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-white truncate">{c.name}</div>
                        <div className="text-[12px] text-zinc-500 truncate">
                          {account
                            ? intl.formatMessage(m.accountLine, {
                                contact: account.contactName,
                                date: account.createdAt,
                              })
                            : intl.formatMessage(m.noAccount)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {account ? (
                        <>
                          {account.status === 'invited' ? (
                            <Pill tone="amber">{intl.formatMessage(m.statusInvited)}</Pill>
                          ) : account.origin === 'self-signup' ? (
                            <Pill tone="blue">{intl.formatMessage(m.statusSelfSignup)}</Pill>
                          ) : (
                            <Pill tone="green">{intl.formatMessage(m.statusActive)}</Pill>
                          )}
                          <button
                            onClick={() => {
                              openBusinessPortal(account.id);
                              onClose();
                            }}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                          >
                            {intl.formatMessage(m.openAction)}
                            <ArrowRight size={13} strokeWidth={2.5} />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setInviting(c)}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                        >
                          <Send size={13} />
                          {intl.formatMessage(m.inviteAction)}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visible.length === 0 && (
                <p className="text-[13px] text-zinc-500 text-center py-10">{intl.formatMessage(m.noMatches)}</p>
              )}
            </div>

            {awaitingSignOff.length > 0 && (
              <div className="p-5 border-t border-white/5 bg-ground/40 flex flex-col gap-3">
                <div>
                  <div className="text-[13px] font-bold text-white">{intl.formatMessage(m.awaitingHeading)}</div>
                  <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">{intl.formatMessage(m.awaitingNote)}</p>
                </div>
                {awaitingSignOff.map(({ client, items, request }) => (
                  <div key={client.id} className="p-4 rounded-2xl bg-card border border-white/5 flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-[13px] font-bold text-white truncate">{client.name}</div>
                      <div className="text-[12px] text-zinc-500 truncate">
                        {intl.formatMessage(m.awaitingItems, {
                          count: items.length,
                          suppliers: items.map((i) => i.supplier).join(', '),
                        })}
                      </div>
                    </div>
                    {/* Sending and looking are two different acts. */}
                    <span className="shrink-0 flex items-center gap-2">
                      {!request && (
                        <button
                          onClick={() => sendApprovalRequest(client.id)}
                          disabled={!client.mobile}
                          title={client.mobile ? undefined : intl.formatMessage(m.noMobile)}
                          className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Send size={13} strokeWidth={2.5} />
                          {intl.formatMessage(m.sendRequest)}
                        </button>
                      )}
                      <button
                        onClick={() => { onClose(); openApprovalLink(request?.id ?? `appr-req-${client.id}-0`); }}
                        disabled={!request}
                        title={intl.formatMessage(request ? m.openLinkHint : m.sendFirstHint)}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-brand bg-brand/10 border border-brand/25 hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Smartphone size={13} strokeWidth={2.5} />
                        {intl.formatMessage(m.openLink)}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="p-4 border-t border-white/5 flex items-center justify-between gap-4">
              <p className="text-[11px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.selfSignupNote)}</p>
              <button
                onClick={() => {
                  openBusinessPortal(null);
                  onClose();
                }}
                className="shrink-0 text-[12px] font-bold text-brand hover:underline"
              >
                {intl.formatMessage(m.openSignUp)}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function InviteForm({
  client,
  onCancel,
  onCreate,
}: {
  client: Client;
  onCancel: () => void;
  onCreate: (contactName: string, email: string, mobile: string) => void;
}) {
  const intl = useIntl();
  const [contactName, setContactName] = useState(client.contactName ?? '');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState(client.mobile ?? '');

  return (
    <div className="p-6 flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-bold text-white tracking-tight">
          {intl.formatMessage(inviteMessages.heading, { client: client.name })}
        </h3>
        <p className="text-[12px] text-zinc-500 mt-1">{intl.formatMessage(inviteMessages.note)}</p>
      </div>

      <Field
        label={intl.formatMessage(inviteMessages.contactNameLabel)}
        value={contactName}
        onChange={setContactName}
        placeholder={intl.formatMessage(commonPlaceholders.personName)}
      />
      <Field
        label={intl.formatMessage(commonLabels.mobile)}
        value={mobile}
        onChange={setMobile}
        placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
      />
      <Field
        label={intl.formatMessage(commonLabels.email)}
        value={email}
        onChange={setEmail}
        placeholder={intl.formatMessage(inviteMessages.emailPlaceholder)}
      />

      {!mobile.trim() && (
        <p className="text-[12px] text-amber-400 font-semibold">{intl.formatMessage(inviteMessages.noMobileWarning)}</p>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          onClick={onCancel}
          className="px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white rounded-full transition-colors"
        >
          {intl.formatMessage(commonActions.cancel)}
        </button>
        <button
          onClick={() => onCreate(contactName.trim() || 'Primary contact', email.trim(), mobile.trim())}
          className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn-strong"
        >
          <Send size={15} strokeWidth={2.5} />
          {intl.formatMessage(inviteMessages.create)}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}
