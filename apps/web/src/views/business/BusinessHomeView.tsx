import { useMemo } from 'react';
import { Camera, Upload, AlertCircle, Clock, CheckCircle2, FileText, ShieldCheck, Eye, X, UserPlus, Check } from 'lucide-react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { commonActions } from '../../i18n/common';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { currency } from '../../lib/resolver';
import type { BusinessAccount, MissingItem } from '../../lib/types';
import { useQueryParam } from '../../lib/router';
import { DocumentPreview } from '../../components/DynamicComponents/DocumentPreview';
import { useConfirm } from '../../components/DynamicComponents/ConfirmProvider';
import { channelLabel } from '../../lib/channels';

const m = defineMessages({
  statusProcessing: { id: 'portal.businessHomeView.statusProcessing', defaultMessage: 'Processing' },
  statusReview: { id: 'portal.businessHomeView.statusReview', defaultMessage: 'With your accountant' },
  statusReady: { id: 'portal.businessHomeView.statusReady', defaultMessage: 'Accepted' },
  statusPublished: { id: 'portal.businessHomeView.statusPublished', defaultMessage: 'Filed' },
  statusRejected: { id: 'portal.businessHomeView.statusRejected', defaultMessage: 'Needs another copy' },

  greeting: { id: 'portal.businessHomeView.greeting', defaultMessage: 'Hello {name}' },
  greetingAnonymous: { id: 'portal.businessHomeView.greetingAnonymous', defaultMessage: 'Hello there' },
  waitingOn: {
    id: 'portal.businessHomeView.waitingOn',
    defaultMessage: 'Your accountant is waiting on {count, plural, one {# document} other {# documents}}.',
  },
  nothingOutstanding: {
    id: 'portal.businessHomeView.nothingOutstanding',
    defaultMessage: 'Nothing outstanding — your accountant has everything they asked for.',
  },

  statRequested: { id: 'portal.businessHomeView.statRequested', defaultMessage: 'Requested' },
  statSent: { id: 'portal.businessHomeView.statSent', defaultMessage: 'Sent from here' },
  statProcessing: { id: 'portal.businessHomeView.statProcessing', defaultMessage: 'Processing' },
  statRejected: { id: 'portal.businessHomeView.statRejected', defaultMessage: 'Needs a new copy' },

  approvalsHeading: {
    id: 'portal.businessHomeView.approvalsHeading',
    defaultMessage: '{count, plural, one {# item needs your approval} other {# items need your approval}}',
  },
  approvalsDetail: {
    id: 'portal.businessHomeView.approvalsDetail',
    defaultMessage: '{items} — your accountant cannot publish these until you have signed them off.',
  },
  approvalsAction: { id: 'portal.businessHomeView.approvalsAction', defaultMessage: 'Review and approve' },

  proposedUsersHeadingOne: {
    id: 'portal.businessHomeView.proposedUsersHeadingOne',
    defaultMessage: 'Your accountant wants to add someone to your account',
  },
  proposedUsersHeadingMany: {
    id: 'portal.businessHomeView.proposedUsersHeadingMany',
    defaultMessage: 'Your accountant wants to add {count, plural, other {# people}} to your account',
  },
  proposedUsersDetail: {
    id: 'portal.businessHomeView.proposedUsersDetail',
    defaultMessage: 'Nothing has been sent to them. They can only send documents for {business} once you say yes.',
  },
  memberCanUpload: { id: 'portal.businessHomeView.memberCanUpload', defaultMessage: 'Can send documents' },
  memberCanSeeTotals: { id: 'portal.businessHomeView.memberCanSeeTotals', defaultMessage: 'Can see totals' },
  memberTotalsHidden: { id: 'portal.businessHomeView.memberTotalsHidden', defaultMessage: 'Totals hidden' },
  proposedUserAskedByWithTotals: {
    id: 'portal.businessHomeView.proposedUserAskedByWithTotals',
    defaultMessage: 'Asked for by {who} {when}. They will be able to see what your business spends.',
  },
  proposedUserAskedByNoTotals: {
    id: 'portal.businessHomeView.proposedUserAskedByNoTotals',
    defaultMessage: 'Asked for by {who} {when}. They will not see any of your figures.',
  },
  defaultInviter: { id: 'portal.businessHomeView.defaultInviter', defaultMessage: 'your accountant' },
  declineUserTitle: {
    id: 'portal.businessHomeView.declineUserTitle',
    defaultMessage: 'Say no to adding {name}?',
  },
  declineUserDetail: {
    id: 'portal.businessHomeView.declineUserDetail',
    defaultMessage: 'Your accountant is told, and nothing is sent to this person.',
  },
  declineConfirmLabel: { id: 'portal.businessHomeView.declineConfirmLabel', defaultMessage: 'Yes, decline' },
  declineUserAction: { id: 'portal.businessHomeView.declineUserAction', defaultMessage: 'No, decline' },
  addUserTitle: {
    id: 'portal.businessHomeView.addUserTitle',
    defaultMessage: 'Let {name} send documents for {business}?',
  },
  addUserDetailWithTotals: {
    id: 'portal.businessHomeView.addUserDetailWithTotals',
    defaultMessage: 'They join as {role} and will see your figures.',
  },
  addUserDetailNoTotals: {
    id: 'portal.businessHomeView.addUserDetailNoTotals',
    defaultMessage: 'They join as {role} and will not see your figures.',
  },
  addUserConsequence: {
    id: 'portal.businessHomeView.addUserConsequence',
    defaultMessage: 'Their invite goes {channel} to {recipient} as soon as you approve.',
  },
  defaultInviteRecipient: {
    id: 'portal.businessHomeView.defaultInviteRecipient',
    defaultMessage: 'their email',
  },
  addUserConfirmLabel: { id: 'portal.businessHomeView.addUserConfirmLabel', defaultMessage: 'Yes, add them' },
  approveAction: { id: 'portal.businessHomeView.approveAction', defaultMessage: 'Approve' },

  proposedChangesHeadingOne: {
    id: 'portal.businessHomeView.proposedChangesHeadingOne',
    defaultMessage: 'Your accountant wants to change a detail on your record',
  },
  proposedChangesHeadingMany: {
    id: 'portal.businessHomeView.proposedChangesHeadingMany',
    defaultMessage: 'Your accountant wants to change {count, plural, other {# details}} on your record',
  },
  proposedChangesDetail: {
    id: 'portal.businessHomeView.proposedChangesDetail',
    defaultMessage:
      "Nothing has changed yet. These are your business's own details, so they only update if you say yes.",
  },
  changeAskedBy: {
    id: 'portal.businessHomeView.changeAskedBy',
    defaultMessage: 'Asked for by {who} {when}.',
  },
  changeAskedByMobile: {
    id: 'portal.businessHomeView.changeAskedByMobile',
    defaultMessage: 'Asked for by {who} {when}. Every chase and sign-in code would go to this number instead.',
  },
  declineChangeTitle: {
    id: 'portal.businessHomeView.declineChangeTitle',
    defaultMessage: 'Leave {label} as it is?',
  },
  declineChangeDetail: {
    id: 'portal.businessHomeView.declineChangeDetail',
    defaultMessage: 'Your accountant is told you declined the change to "{to}".',
  },
  declineChangeAction: { id: 'portal.businessHomeView.declineChangeAction', defaultMessage: 'No, keep it' },
  changeTitle: {
    id: 'portal.businessHomeView.changeTitle',
    defaultMessage: 'Change {label} to "{to}"?',
  },
  changeDetail: { id: 'portal.businessHomeView.changeDetail', defaultMessage: 'It is currently {from}.' },
  changeMobileConsequence: {
    id: 'portal.businessHomeView.changeMobileConsequence',
    defaultMessage: 'Chases, approvals and sign-in codes will go to the new number from now on.',
  },
  changeConfirmLabel: { id: 'portal.businessHomeView.changeConfirmLabel', defaultMessage: 'Yes, change it' },

  captureHeading: { id: 'portal.businessHomeView.captureHeading', defaultMessage: 'Capture a document' },
  captureDetail: {
    id: 'portal.businessHomeView.captureDetail',
    defaultMessage: 'Photograph a receipt or invoice with your camera',
  },
  uploadHeading: { id: 'portal.businessHomeView.uploadHeading', defaultMessage: 'Upload a file' },
  uploadDetail: {
    id: 'portal.businessHomeView.uploadDetail',
    defaultMessage: 'PDF, photo or spreadsheet from this device',
  },

  waitingPanelTitle: {
    id: 'portal.businessHomeView.waitingPanelTitle',
    defaultMessage: 'What your accountant is waiting for',
  },
  waitingChasedJustNow: {
    id: 'portal.businessHomeView.waitingChasedJustNow',
    defaultMessage: 'Last chased just now by SMS',
  },
  waitingChasedHoursAgo: {
    id: 'portal.businessHomeView.waitingChasedHoursAgo',
    defaultMessage: 'Last chased {hours}h ago by SMS',
  },
  waitingDetected: {
    id: 'portal.businessHomeView.waitingDetected',
    defaultMessage: 'Detected from your bank feed and supplier statements',
  },
  waitingEmpty: {
    id: 'portal.businessHomeView.waitingEmpty',
    defaultMessage: "Nothing outstanding. You're all caught up.",
  },
  requestRequested: { id: 'portal.businessHomeView.requestRequested', defaultMessage: 'Requested' },
  requestSpotted: { id: 'portal.businessHomeView.requestSpotted', defaultMessage: 'Spotted' },
  requestSendAction: { id: 'portal.businessHomeView.requestSendAction', defaultMessage: 'Send it' },
  requestsMore: { id: 'portal.businessHomeView.requestsMore', defaultMessage: '+ {count} more' },

  sentPanelTitle: { id: 'portal.businessHomeView.sentPanelTitle', defaultMessage: 'Recently sent' },
  sentPanelSubtitle: {
    id: 'portal.businessHomeView.sentPanelSubtitle',
    defaultMessage: 'Status updates as your accountant works through them',
  },
  sentEmpty: {
    id: 'portal.businessHomeView.sentEmpty',
    defaultMessage: 'Nothing sent yet. Capture or upload your first document.',
  },
  sentViaPortal: { id: 'portal.businessHomeView.sentViaPortal', defaultMessage: 'via this portal' },
  sentViaSource: { id: 'portal.businessHomeView.sentViaSource', defaultMessage: 'via {source}' },

  privacyNote: {
    id: 'portal.businessHomeView.privacyNote',
    defaultMessage:
      'You only ever see your own business here. Your accountant handles the coding and filing — nothing you send is published to the accounting software until they have reviewed it.',
  },

  reasonBankTransaction: {
    id: 'portal.businessHomeView.reasonBankTransaction',
    defaultMessage: 'a payment left your account with no receipt',
  },
  reasonSupplierStatement: {
    id: 'portal.businessHomeView.reasonSupplierStatement',
    defaultMessage: 'on a supplier statement but not sent to us',
  },
  reasonStatementGap: {
    id: 'portal.businessHomeView.reasonStatementGap',
    defaultMessage: 'a gap in your bank statements',
  },
  reasonLedgerAttachment: {
    id: 'portal.businessHomeView.reasonLedgerAttachment',
    defaultMessage: 'no copy attached in the ledger',
  },
  reasonRecurring: {
    id: 'portal.businessHomeView.reasonRecurring',
    defaultMessage: 'you usually send this one every month',
  },
});

// The keys are pipeline states — machine values. Only `label` is copy, so it
// holds a descriptor and is formatted where it is rendered.
const STATUS_TONE = {
  processing: { tone: 'blue' as const, label: m.statusProcessing },
  review: { tone: 'amber' as const, label: m.statusReview },
  ready: { tone: 'green' as const, label: m.statusReady },
  published: { tone: 'green' as const, label: m.statusPublished },
  rejected: { tone: 'red' as const, label: m.statusRejected },
};

/**
 * What the business sees first: what its accountant is still waiting on, and
 * what it has already sent. Everything here is the same pipeline state the
 * practice sees — phrased from the client's side of the relationship.
 */
export function BusinessHomeView({
  account,
  onGo,
}: {
  account: BusinessAccount;
  onGo: (tab: 'Home' | 'Upload' | 'Capture' | 'Settings') => void;
}) {
  const {
    missing, documents, chases,
    clientSideApprovals, approvalRequests, sendApprovalRequest, openApprovalLink, reviewProposedUser,
    clientDetailChanges, reviewClientDetailChange,
  } = useAppContext();
  const confirm = useConfirm();
  const intl = useIntl();

  /**
   * Wireframe screen 19: "an approver who happens to have a business login
   * sees the same pending items in their workspace too — but SMS is the
   * delivery channel". This is that second view of the same queue.
   */
  // ?doc=<id> — the viewer is a link here too.
  const [previewId, setPreviewId] = useQueryParam('doc');
  const preview = previewId ? documents.find((d) => d.id === previewId) ?? null : null;

  const toApprove = clientSideApprovals(account.clientId);
  const approvalRequest = approvalRequests.find((r) => r.clientId === account.clientId);

  /**
   * People the accountant has proposed for this business. They are waiting
   * here rather than already having access, because the practice does not get
   * to decide who works at the company.
   */
  const proposedUsers = account.members.filter((member) => member.status === 'pending-client-approval');
  /** Edits the accountant wants to make to this business's own record. */
  const proposedChanges = clientDetailChanges.filter((c) => c.clientId === account.clientId && c.status === 'pending');

  const requests = useMemo(
    () => missing.filter((item) => item.clientId === account.clientId),
    [missing, account.clientId],
  );

  const myDocs = useMemo(
    () => documents.filter((d) => d.clientId === account.clientId).slice(0, 8),
    [documents, account.clientId],
  );

  const chase = chases.find((c) => c.clientId === account.clientId);
  const sent = documents.filter((d) => d.clientId === account.clientId && d.source === 'portal').length;
  const processing = documents.filter((d) => d.clientId === account.clientId && d.status === 'processing').length;
  const rejected = documents.filter((d) => d.clientId === account.clientId && d.status === 'rejected').length;

  const firstName = account.contactName.split(' ')[0];

  return (
    <div className="p-8 max-w-5xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">
          {firstName
            ? intl.formatMessage(m.greeting, { name: firstName })
            : intl.formatMessage(m.greetingAnonymous)}
        </h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          {requests.length > 0
            ? intl.formatMessage(m.waitingOn, { count: requests.length })
            : intl.formatMessage(m.nothingOutstanding)}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={AlertCircle} label={intl.formatMessage(m.statRequested)} value={requests.length} tone={requests.length ? 'amber' : 'zinc'} />
        <Stat icon={Upload} label={intl.formatMessage(m.statSent)} value={sent} tone="zinc" />
        <Stat icon={Clock} label={intl.formatMessage(m.statProcessing)} value={processing} tone="zinc" />
        <Stat icon={AlertCircle} label={intl.formatMessage(m.statRejected)} value={rejected} tone={rejected ? 'red' : 'zinc'} />
      </div>

      {toApprove.length > 0 && (
        <div className="rounded-[24px] border border-brand/25 bg-brand/[0.07] overflow-hidden">
          <div className="p-5 flex items-start gap-3">
            <span className="w-10 h-10 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
              <ShieldCheck size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white">
                {intl.formatMessage(m.approvalsHeading, { count: toApprove.length })}
              </div>
              <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                {intl.formatMessage(m.approvalsDetail, {
                  items: toApprove.map((a) => `${a.supplier} ${currency(a.total)}`).join(' · '),
                })}
              </p>
            </div>
          </div>
          <div className="px-5 pb-5">
            <button
              onClick={() => {
                if (!approvalRequest) sendApprovalRequest(account.clientId);
                // Sending is a state update, so the id is only knowable on the
                // next tick when this is the first time.
                setTimeout(() => openApprovalLink(approvalRequest?.id ?? `appr-req-${account.clientId}-0`), 0);
              }}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
            >
              <ShieldCheck size={15} strokeWidth={2.5} />
              {intl.formatMessage(m.approvalsAction)}
            </button>
          </div>
        </div>
      )}

      {proposedUsers.length > 0 && (
        <div className="rounded-[24px] border border-brand/25 bg-brand/[0.07] overflow-hidden">
          <div className="p-5 flex items-start gap-3 border-b border-brand/15">
            <span className="w-10 h-10 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
              <UserPlus size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white">
                {proposedUsers.length === 1
                  ? intl.formatMessage(m.proposedUsersHeadingOne)
                  : intl.formatMessage(m.proposedUsersHeadingMany, { count: proposedUsers.length })}
              </div>
              <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                {intl.formatMessage(m.proposedUsersDetail, { business: account.businessName })}
              </p>
            </div>
          </div>

          <div className="p-5 flex flex-col gap-3">
            {proposedUsers.map((member) => (
              <div key={member.id} className="p-4 rounded-2xl bg-card border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white shrink-0">
                    {member.name.trim().charAt(0).toUpperCase() || '?'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-white truncate">{member.name}</div>
                    <div className="text-[12px] text-zinc-500 truncate">{member.email || member.mobile}</div>
                  </div>
                  <span className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                    <Pill tone="blue">{member.role}</Pill>
                    {member.canUpload && <Pill tone="green">{intl.formatMessage(m.memberCanUpload)}</Pill>}
                    {member.canSeeTotals ? (
                      <Pill tone="amber">{intl.formatMessage(m.memberCanSeeTotals)}</Pill>
                    ) : (
                      <Pill>{intl.formatMessage(m.memberTotalsHidden)}</Pill>
                    )}
                  </span>
                </div>

                <p className="text-[12px] text-zinc-500 leading-relaxed">
                  {intl.formatMessage(
                    member.canSeeTotals ? m.proposedUserAskedByWithTotals : m.proposedUserAskedByNoTotals,
                    {
                      who: member.invitedBy ?? intl.formatMessage(m.defaultInviter),
                      when: member.invitedAt ?? '',
                    },
                  )}
                </p>

                <div className="flex items-center gap-2 justify-end flex-wrap">
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        tone: 'red',
                        title: intl.formatMessage(m.declineUserTitle, { name: member.name }),
                        detail: intl.formatMessage(m.declineUserDetail),
                        confirmLabel: intl.formatMessage(m.declineConfirmLabel),
                      });
                      if (ok) reviewProposedUser(account.id, member.id, 'decline', 'Declined by the business');
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                  >
                    <X size={13} />
                    {intl.formatMessage(m.declineUserAction)}
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        title: intl.formatMessage(m.addUserTitle, {
                          name: member.name,
                          business: account.businessName,
                        }),
                        detail: intl.formatMessage(
                          member.canSeeTotals ? m.addUserDetailWithTotals : m.addUserDetailNoTotals,
                          { role: member.role },
                        ),
                        consequence: intl.formatMessage(m.addUserConsequence, {
                          channel: intl.formatMessage(channelLabel('user-invite')),
                          recipient: member.email || intl.formatMessage(m.defaultInviteRecipient),
                        }),
                        confirmLabel: intl.formatMessage(m.addUserConfirmLabel),
                      });
                      if (ok) reviewProposedUser(account.id, member.id, 'approve');
                    }}
                    className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                  >
                    <Check size={13} strokeWidth={3} />
                    {intl.formatMessage(m.approveAction)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {proposedChanges.length > 0 && (
        <div className="rounded-[24px] border border-brand/25 bg-brand/[0.07] overflow-hidden">
          <div className="p-5 flex items-start gap-3 border-b border-brand/15">
            <span className="w-10 h-10 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
              <FileText size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white">
                {proposedChanges.length === 1
                  ? intl.formatMessage(m.proposedChangesHeadingOne)
                  : intl.formatMessage(m.proposedChangesHeadingMany, { count: proposedChanges.length })}
              </div>
              <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                {intl.formatMessage(m.proposedChangesDetail)}
              </p>
            </div>
          </div>

          <div className="p-5 flex flex-col gap-3">
            {proposedChanges.map((c) => (
              <div key={c.id} className="p-4 rounded-2xl bg-card border border-white/5 flex flex-col gap-3">
                <div>
                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{c.label}</div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap text-[13.5px]">
                    <span className="text-zinc-500 line-through">{c.from}</span>
                    <span className="text-zinc-600">→</span>
                    <span className="text-white font-bold">{c.to}</span>
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-2">
                    {intl.formatMessage(c.field === 'mobile' ? m.changeAskedByMobile : m.changeAskedBy, {
                      who: c.requestedBy,
                      when: c.requestedAt,
                    })}
                  </p>
                </div>

                <div className="flex items-center gap-2 justify-end flex-wrap">
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        tone: 'red',
                        title: intl.formatMessage(m.declineChangeTitle, { label: c.label.toLowerCase() }),
                        detail: intl.formatMessage(m.declineChangeDetail, { to: c.to }),
                        confirmLabel: intl.formatMessage(m.declineConfirmLabel),
                      });
                      if (ok) reviewClientDetailChange(c.id, 'decline', 'Declined by the business');
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                  >
                    <X size={13} />
                    {intl.formatMessage(m.declineChangeAction)}
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        title: intl.formatMessage(m.changeTitle, { label: c.label.toLowerCase(), to: c.to }),
                        detail: intl.formatMessage(m.changeDetail, { from: c.from }),
                        ...(c.field === 'mobile'
                          ? { consequence: intl.formatMessage(m.changeMobileConsequence) }
                          : {}),
                        confirmLabel: intl.formatMessage(m.changeConfirmLabel),
                      });
                      if (ok) reviewClientDetailChange(c.id, 'approve');
                    }}
                    className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                  >
                    <Check size={13} strokeWidth={3} />
                    {intl.formatMessage(m.approveAction)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={() => onGo('Capture')}
          className="flex items-center gap-4 p-5 rounded-2xl border border-white/5 bg-card hover:border-brand/40 transition-colors text-left group"
        >
          <span className="w-12 h-12 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
            <Camera size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">{intl.formatMessage(m.captureHeading)}</span>
            <span className="block text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.captureDetail)}</span>
          </span>
        </button>
        <button
          onClick={() => onGo('Upload')}
          className="flex items-center gap-4 p-5 rounded-2xl border border-white/5 bg-card hover:border-brand/40 transition-colors text-left"
        >
          <span className="w-12 h-12 rounded-2xl bg-raised border border-white/5 flex items-center justify-center text-zinc-300 shrink-0">
            <Upload size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">{intl.formatMessage(m.uploadHeading)}</span>
            <span className="block text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.uploadDetail)}</span>
          </span>
        </button>
      </div>

      <Panel
        title={intl.formatMessage(m.waitingPanelTitle)}
        subtitle={
          chase
            ? chase.hoursSinceSent === 0
              ? intl.formatMessage(m.waitingChasedJustNow)
              : intl.formatMessage(m.waitingChasedHoursAgo, { hours: chase.hoursSinceSent })
            : intl.formatMessage(m.waitingDetected)
        }
      >
        {requests.length === 0 ? (
          <Empty icon={CheckCircle2} message={intl.formatMessage(m.waitingEmpty)} />
        ) : (
          <div className="flex flex-col gap-2">
            {requests.slice(0, 8).map((req) => (
              <div
                key={req.id}
                className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-ground/60 border border-white/5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white truncate">{req.supplier}</div>
                  <div className="text-[12px] text-zinc-500 mt-0.5">
                    {req.date} · {currency(req.amount)} · {intl.formatMessage(REASON[req.detectedBy])}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {req.chased ? (
                    <Pill tone="amber">{intl.formatMessage(m.requestRequested)}</Pill>
                  ) : (
                    <Pill>{intl.formatMessage(m.requestSpotted)}</Pill>
                  )}
                  <button
                    onClick={() => onGo('Capture')}
                    className="px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                  >
                    {intl.formatMessage(m.requestSendAction)}
                  </button>
                </div>
              </div>
            ))}
            {requests.length > 8 && (
              <p className="text-[12px] text-zinc-600 font-semibold px-1">
                {intl.formatMessage(m.requestsMore, { count: requests.length - 8 })}
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel title={intl.formatMessage(m.sentPanelTitle)} subtitle={intl.formatMessage(m.sentPanelSubtitle)}>
        {myDocs.length === 0 ? (
          <Empty icon={FileText} message={intl.formatMessage(m.sentEmpty)} />
        ) : (
          <div className="flex flex-col gap-2">
            {myDocs.map((d) => {
              const s = STATUS_TONE[d.status];
              return (
                // Openable, not a static row: it is the business's own paperwork,
                // and seeing what was read off it is how they catch a wrong total
                // before their accountant has to ask.
                <button
                  key={d.id}
                  onClick={() => setPreviewId(d.id)}
                  className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-ground/60 border border-white/5 hover:border-white/20 transition-colors text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white truncate">{d.supplier}</div>
                    <div className="text-[12px] text-zinc-500 mt-0.5 truncate">
                      {d.date} · {d.total ? currency(d.total) : '—'} ·{' '}
                      {d.source === 'portal'
                        ? intl.formatMessage(m.sentViaPortal)
                        : intl.formatMessage(m.sentViaSource, { source: d.source })}
                    </div>
                  </div>
                  <span className="flex items-center gap-2 shrink-0">
                    <Pill tone={s.tone}>{intl.formatMessage(s.label)}</Pill>
                    <Eye size={15} className="text-zinc-600" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-card/60">
        <ShieldCheck size={16} className="text-zinc-500 mt-0.5 shrink-0" />
        <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.privacyNote)}</p>
      </div>

      {/* The same viewer the practice sees: the original alongside every value
          read off it, with the confidence on each. */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm overflow-y-auto p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onClick={() => setPreviewId(null)}
        >
          <div className="min-h-full flex flex-col items-center justify-center gap-3" onClick={(e) => e.stopPropagation()}>
            <DocumentPreview document={preview} />
            <button
              onClick={() => setPreviewId(null)}
              className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-raised border border-white/10 hover:border-white/25 transition-colors"
            >
              <X size={15} />
              {intl.formatMessage(commonActions.close)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Keyed by the detection engine — a machine value — so only the phrasing is a
// message, formatted where the row is rendered.
const REASON: Record<MissingItem['detectedBy'], MessageDescriptor> = {
  'bank-transaction': m.reasonBankTransaction,
  'supplier-statement': m.reasonSupplierStatement,
  'statement-gap': m.reasonStatementGap,
  'ledger-attachment': m.reasonLedgerAttachment,
  recurring: m.reasonRecurring,
};

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  tone: 'amber' | 'red' | 'zinc';
}) {
  const tones = {
    amber: 'text-amber-400',
    red: 'text-red-400',
    zinc: 'text-white',
  };
  return (
    <div className="p-4 rounded-2xl border border-white/5 bg-card">
      <Icon size={16} className="text-zinc-500" />
      <div className={`text-2xl font-bold mt-3 tracking-tight ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/5 bg-card p-6">
      <div className="mb-4">
        <h2 className="text-[15px] font-bold text-white tracking-tight">{title}</h2>
        {subtitle && <p className="text-[12px] text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({
  icon: Icon,
  message,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon size={24} className="text-zinc-700" />
      <p className="text-[13px] text-zinc-500 mt-3 font-medium">{message}</p>
    </div>
  );
}
