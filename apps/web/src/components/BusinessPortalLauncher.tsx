import { useState } from 'react';
import { X, Building2, ArrowRight, Send, Search, Smartphone } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { Pill } from './DynamicComponents/DataTable';
import { newBusinessAccount, newMember } from '../lib/business';
import type { Client } from '../lib/types';

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

  /**
   * Clients with something sitting on a client-side approval stage. This is
   * the practice's way into the approver's own screen — the real one arrives
   * by SMS, and nobody in the practice ever holds that link.
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
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl max-h-[80vh] rounded-[32px] border border-white/5 bg-card shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="p-6 border-b border-white/5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-sans font-bold text-xl text-white tracking-tight">Business portal</h2>
            <p className="text-[12px] text-zinc-500 mt-1">
              Where your clients send documents from. Open one to see their side.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors shrink-0">
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
                action: 'Invited a business to the portal',
                scope: `${inviting.name} — ${mobile || email || 'no contact details'}`,
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
                  placeholder="Search clients"
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
                    className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-ground/60 border border-white/5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shrink-0">
                        <Building2 size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-white truncate">{c.name}</div>
                        <div className="text-[12px] text-zinc-500 truncate">
                          {account
                            ? `${account.contactName} · created ${account.createdAt}`
                            : 'No portal account yet'}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {account ? (
                        <>
                          {account.status === 'invited' ? (
                            <Pill tone="amber">Invited</Pill>
                          ) : account.origin === 'self-signup' ? (
                            <Pill tone="blue">Self signed-up</Pill>
                          ) : (
                            <Pill tone="green">Active</Pill>
                          )}
                          <button
                            onClick={() => {
                              openBusinessPortal(account.id);
                              onClose();
                            }}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                          >
                            Open
                            <ArrowRight size={13} strokeWidth={2.5} />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setInviting(c)}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                        >
                          <Send size={13} />
                          Invite
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visible.length === 0 && (
                <p className="text-[13px] text-zinc-500 text-center py-10">No clients match that search.</p>
              )}
            </div>

            {awaitingSignOff.length > 0 && (
              <div className="p-5 border-t border-white/5 bg-ground/40 flex flex-col gap-3">
                <div>
                  <div className="text-[13px] font-bold text-white">Waiting on a client to approve</div>
                  <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
                    These sit on a stage only the business can clear. The approver gets an SMS link — open it here to
                    see exactly what they see.
                  </p>
                </div>
                {awaitingSignOff.map(({ client, items, request }) => (
                  <div key={client.id} className="p-4 rounded-2xl bg-card border border-white/5 flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-[13px] font-bold text-white truncate">{client.name}</div>
                      <div className="text-[12px] text-zinc-500 truncate">
                        {items.length} item{items.length === 1 ? '' : 's'} · {items.map((i) => i.supplier).join(', ')}
                      </div>
                    </div>
                    {/* Sending and looking are two different acts. */}
                    <span className="shrink-0 flex items-center gap-2">
                      {!request && (
                        <button
                          onClick={() => sendApprovalRequest(client.id)}
                          disabled={!client.mobile}
                          title={client.mobile ? undefined : 'No mobile on file for this client'}
                          className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Send size={13} strokeWidth={2.5} />
                          Send the request
                        </button>
                      )}
                      <button
                        onClick={() => { onClose(); openApprovalLink(request?.id ?? `appr-req-${client.id}-0`); }}
                        disabled={!request}
                        title={request ? 'See exactly what the approver sees' : 'Send the request first'}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-brand bg-brand/10 border border-brand/25 hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Smartphone size={13} strokeWidth={2.5} />
                        Open the link
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="p-4 border-t border-white/5 flex items-center justify-between gap-4">
              <p className="text-[11px] text-zinc-600 leading-relaxed">
                A business can also sign itself up and be linked to you afterwards.
              </p>
              <button
                onClick={() => {
                  openBusinessPortal(null);
                  onClose();
                }}
                className="shrink-0 text-[12px] font-bold text-brand hover:underline"
              >
                Open the sign-up screen →
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
  const [contactName, setContactName] = useState(client.contactName ?? '');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState(client.mobile ?? '');

  return (
    <div className="p-6 flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-bold text-white tracking-tight">Invite {client.name}</h3>
        <p className="text-[12px] text-zinc-500 mt-1">
          They get a link by text. The account stays in Invited until they first sign in.
        </p>
      </div>

      <Field label="Contact name" value={contactName} onChange={setContactName} placeholder="John Doe" />
      <Field label="Mobile" value={mobile} onChange={setMobile} placeholder="+44 7700 900123" />
      <Field label="Email" value={email} onChange={setEmail} placeholder="john@business.co.uk" />

      {!mobile.trim() && (
        <p className="text-[12px] text-amber-400 font-semibold">
          Without a mobile number the invite text cannot be sent.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          onClick={onCancel}
          className="px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white rounded-full transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onCreate(contactName.trim() || 'Primary contact', email.trim(), mobile.trim())}
          className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-[0_0_15px_rgba(20,227,196,0.3)]"
        >
          <Send size={15} strokeWidth={2.5} />
          Create & send invite
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
