import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import { commonLabels } from '../../i18n/common';

const m = defineMessages({
  heading: { id: 'shell.userInviteForm.heading', defaultMessage: 'Invite a colleague' },
  subheading: { id: 'shell.userInviteForm.subheading', defaultMessage: 'Role + per-permission toggles' },
  nameLabel: { id: 'shell.userInviteForm.nameLabel', defaultMessage: 'Full name' },
  namePlaceholder: { id: 'shell.userInviteForm.namePlaceholder', defaultMessage: 'Sam Patel' },
  emailLabel: { id: 'shell.userInviteForm.emailLabel', defaultMessage: 'Work email' },
  emailPlaceholder: { id: 'shell.userInviteForm.emailPlaceholder', defaultMessage: 'sam@practice.co.uk' },

  rolePracticeAdmin: { id: 'shell.userInviteForm.rolePracticeAdmin', defaultMessage: 'Practice Admin' },
  roleClientAdmin: { id: 'shell.userInviteForm.roleClientAdmin', defaultMessage: 'Client Admin' },
  roleStandardUser: { id: 'shell.userInviteForm.roleStandardUser', defaultMessage: 'Standard User' },

  permissionPublish: { id: 'shell.userInviteForm.permissionPublish', defaultMessage: 'Publish' },
  permissionApprove: { id: 'shell.userInviteForm.permissionApprove', defaultMessage: 'Approve' },
  permissionChase: { id: 'shell.userInviteForm.permissionChase', defaultMessage: 'Chase' },
  permissionConnectBank: { id: 'shell.userInviteForm.permissionConnectBank', defaultMessage: 'Connect bank' },
  permissionExport: { id: 'shell.userInviteForm.permissionExport', defaultMessage: 'Export' },
  permissionDelete: { id: 'shell.userInviteForm.permissionDelete', defaultMessage: 'Delete' },

  accessAll: { id: 'shell.userInviteForm.accessAll', defaultMessage: 'All clients (role default)' },
  // No plural: the string this replaces had none. Flagged in the report.
  accessAssigned: { id: 'shell.userInviteForm.accessAssigned', defaultMessage: '{count} assigned' },
  accessNone: { id: 'shell.userInviteForm.accessNone', defaultMessage: 'None yet' },

  hideFieldsLabel: { id: 'shell.userInviteForm.hideFieldsLabel', defaultMessage: 'Hide finance fields' },
  hideFieldsHint: {
    id: 'shell.userInviteForm.hideFieldsHint',
    defaultMessage: 'For non-finance submitters — they see capture, not coding.',
  },

  reviewTitleFallback: { id: 'shell.userInviteForm.reviewTitleFallback', defaultMessage: 'New colleague' },
  reviewSubtitle: { id: 'shell.userInviteForm.reviewSubtitle', defaultMessage: '{role} • {access}' },
  reviewSection: { id: 'shell.userInviteForm.reviewSection', defaultMessage: 'Invitation that will be sent' },
  rowName: { id: 'shell.userInviteForm.rowName', defaultMessage: 'Name' },
  rowPermissions: { id: 'shell.userInviteForm.rowPermissions', defaultMessage: 'Permissions' },
  rowFinanceFields: { id: 'shell.userInviteForm.rowFinanceFields', defaultMessage: 'Finance fields' },
  permissionsNone: { id: 'shell.userInviteForm.permissionsNone', defaultMessage: 'None' },
  financeHidden: { id: 'shell.userInviteForm.financeHidden', defaultMessage: 'Hidden' },
  financeVisible: { id: 'shell.userInviteForm.financeVisible', defaultMessage: 'Visible' },
  reviewNote: {
    id: 'shell.userInviteForm.reviewNote',
    defaultMessage:
      'The invite email goes out on approval. Roles are set per account and can be changed later; the account owner cannot be deactivated.',
  },
  approveLabel: { id: 'shell.userInviteForm.approveLabel', defaultMessage: 'Approve & invite' },
  successMessage: {
    id: 'shell.userInviteForm.successMessage',
    defaultMessage: 'Invitation sent to {email} as {role}.',
  },
  successEmailFallback: { id: 'shell.userInviteForm.successEmailFallback', defaultMessage: 'the new colleague' },
  auditAction: { id: 'shell.userInviteForm.auditAction', defaultMessage: 'Invited colleague' },
  auditScope: { id: 'shell.userInviteForm.auditScope', defaultMessage: '{name} — {role}' },
  auditNameFallback: { id: 'shell.userInviteForm.auditNameFallback', defaultMessage: 'unnamed' },
});

/**
 * A role and a permission are each two things at once: a value that is stored,
 * compared (`isAdmin`) and sent, and a label a human reads. They are kept apart
 * here so that translating the label can never change who counts as an admin —
 * the tables below hold the value, the descriptor holds the words.
 */
const ROLES = [
  { value: 'Practice Admin', label: m.rolePracticeAdmin },
  { value: 'Client Admin', label: m.roleClientAdmin },
  { value: 'Standard User', label: m.roleStandardUser },
] as const;

const PERMISSIONS = [
  { value: 'Publish', label: m.permissionPublish },
  { value: 'Approve', label: m.permissionApprove },
  { value: 'Chase', label: m.permissionChase },
  { value: 'Connect bank', label: m.permissionConnectBank },
  { value: 'Export', label: m.permissionExport },
  { value: 'Delete', label: m.permissionDelete },
] as const;

/**
 * Colleague invite (PRD sections 3.3 & 7): three-tier role model plus
 * per-permission toggles and role-based field hiding for non-finance submitters.
 */
export function UserInviteForm() {
  const { clients } = useAppContext();
  const intl = useIntl();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(ROLES[2].value);
  const [permissions, setPermissions] = useState<string[]>(['Chase']);
  const [clientAccess, setClientAccess] = useState<string[]>([]);
  const [hideFields, setHideFields] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const roleLabel = (value: string) => {
    const entry = ROLES.find((r) => r.value === value);
    return entry ? intl.formatMessage(entry.label) : value;
  };
  const permissionLabel = (value: string) => {
    const entry = PERMISSIONS.find((p) => p.value === value);
    return entry ? intl.formatMessage(entry.label) : value;
  };

  const isAdmin = role !== 'Standard User';
  const accessLabel = isAdmin
    ? intl.formatMessage(m.accessAll)
    : clientAccess.length
      ? intl.formatMessage(m.accessAssigned, { count: clientAccess.length })
      : intl.formatMessage(m.accessNone);

  return (
    <div className="w-full max-w-xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
          <UserPlus size={20} />
        </div>
        <div>
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(m.subheading)}
          </p>
        </div>
      </div>

      <div className="p-6 flex flex-col gap-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label={intl.formatMessage(m.nameLabel)}
            value={name}
            onChange={setName}
            placeholder={intl.formatMessage(m.namePlaceholder)}
          />
          <Field
            label={intl.formatMessage(m.emailLabel)}
            value={email}
            onChange={setEmail}
            placeholder={intl.formatMessage(m.emailPlaceholder)}
          />
        </div>

        <div>
          <Label>{intl.formatMessage(commonLabels.role)}</Label>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((r) => (
              <Chip key={r.value} active={role === r.value} onClick={() => setRole(r.value)}>
                {intl.formatMessage(r.label)}
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <Label>{intl.formatMessage(commonLabels.permissions)}</Label>
          <div className="flex flex-wrap gap-2">
            {PERMISSIONS.map((p) => (
              <Chip
                key={p.value}
                active={permissions.includes(p.value)}
                onClick={() => toggle(permissions, setPermissions, p.value)}
              >
                {intl.formatMessage(p.label)}
              </Chip>
            ))}
          </div>
        </div>

        {!isAdmin && (
          <div>
            <Label>{intl.formatMessage(commonLabels.clientAccess)}</Label>
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => (
                <Chip key={c.id} active={clientAccess.includes(c.id)} onClick={() => toggle(clientAccess, setClientAccess, c.id)}>
                  {c.name}
                </Chip>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={() => setHideFields((h) => !h)}
          className="bg-ground/40 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
        >
          <div>
            <div className="text-sm font-bold text-white">{intl.formatMessage(m.hideFieldsLabel)}</div>
            <div className="text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.hideFieldsHint)}</div>
          </div>
          <div className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${hideFields ? 'bg-brand' : 'bg-white/10'}`}>
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${hideFields ? 'left-6' : 'left-1'}`} />
          </div>
        </button>
      </div>

      <div className="p-4 bg-raised/50">
        <ReviewGate
          icon={UserPlus}
          title={name.trim() || intl.formatMessage(m.reviewTitleFallback)}
          subtitle={intl.formatMessage(m.reviewSubtitle, { role: roleLabel(role), access: accessLabel })}
          detail={
            <>
              <ReviewSection title={intl.formatMessage(m.reviewSection)}>
                <ReviewRows
                  rows={[
                    { label: intl.formatMessage(m.rowName), value: name.trim() || '—' },
                    { label: intl.formatMessage(commonLabels.email), value: email.trim() || '—' },
                    { label: intl.formatMessage(commonLabels.role), value: roleLabel(role) },
                    { label: intl.formatMessage(commonLabels.clientAccess), value: accessLabel },
                    {
                      label: intl.formatMessage(m.rowPermissions),
                      value: permissions.length
                        ? permissions.map(permissionLabel).join(', ')
                        : intl.formatMessage(m.permissionsNone),
                    },
                    {
                      label: intl.formatMessage(m.rowFinanceFields),
                      value: hideFields ? (
                        <Pill tone="blue">{intl.formatMessage(m.financeHidden)}</Pill>
                      ) : (
                        intl.formatMessage(m.financeVisible)
                      ),
                    },
                  ]}
                />
              </ReviewSection>
              <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.reviewNote)}</p>
            </>
          }
          approveLabel={intl.formatMessage(m.approveLabel)}
          successMessage={intl.formatMessage(m.successMessage, {
            email: email.trim() || intl.formatMessage(m.successEmailFallback),
            role: roleLabel(role),
          })}
          auditAction={intl.formatMessage(m.auditAction)}
          auditScope={intl.formatMessage(m.auditScope, {
            name: name.trim() || intl.formatMessage(m.auditNameFallback),
            role: roleLabel(role),
          })}
          onApprove={() => undefined}
        />
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">{children}</div>;
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
  placeholder: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

function Chip({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-2 rounded-full text-[13px] font-bold border transition-all ${
        active
          ? 'bg-brand text-white border-brand shadow-glow-pill'
          : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      {children}
    </button>
  );
}
