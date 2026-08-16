import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

const ROLES = ['Practice Admin', 'Client Admin', 'Standard User'];

const PERMISSIONS = ['Publish', 'Approve', 'Chase', 'Connect bank', 'Export', 'Delete'];

/**
 * Colleague invite (PRD sections 3.3 & 7): three-tier role model plus
 * per-permission toggles and role-based field hiding for non-finance submitters.
 */
export function UserInviteForm() {
  const { clients } = useAppContext();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(ROLES[2]);
  const [permissions, setPermissions] = useState<string[]>(['Chase']);
  const [clientAccess, setClientAccess] = useState<string[]>([]);
  const [hideFields, setHideFields] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const isAdmin = role !== 'Standard User';
  const accessLabel = isAdmin ? 'All clients (role default)' : clientAccess.length ? `${clientAccess.length} assigned` : 'None yet';

  return (
    <div className="w-full max-w-xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
          <UserPlus size={20} />
        </div>
        <div>
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">Invite a colleague</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">Role + per-permission toggles</p>
        </div>
      </div>

      <div className="p-6 flex flex-col gap-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Full name" value={name} onChange={setName} placeholder="Sam Patel" />
          <Field label="Work email" value={email} onChange={setEmail} placeholder="sam@practice.co.uk" />
        </div>

        <div>
          <Label>Role</Label>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((r) => (
              <Chip key={r} active={role === r} onClick={() => setRole(r)}>
                {r}
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <Label>Permissions</Label>
          <div className="flex flex-wrap gap-2">
            {PERMISSIONS.map((p) => (
              <Chip key={p} active={permissions.includes(p)} onClick={() => toggle(permissions, setPermissions, p)}>
                {p}
              </Chip>
            ))}
          </div>
        </div>

        {!isAdmin && (
          <div>
            <Label>Client access</Label>
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
            <div className="text-sm font-bold text-white">Hide finance fields</div>
            <div className="text-[12px] text-zinc-500 mt-0.5">For non-finance submitters — they see capture, not coding.</div>
          </div>
          <div className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${hideFields ? 'bg-brand' : 'bg-white/10'}`}>
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${hideFields ? 'left-6' : 'left-1'}`} />
          </div>
        </button>
      </div>

      <div className="p-4 bg-raised/50">
        <ReviewGate
          icon={UserPlus}
          title={name.trim() || 'New colleague'}
          subtitle={`${role} • ${accessLabel}`}
          detail={
            <>
              <ReviewSection title="Invitation that will be sent">
                <ReviewRows
                  rows={[
                    { label: 'Name', value: name.trim() || '—' },
                    { label: 'Email', value: email.trim() || '—' },
                    { label: 'Role', value: role },
                    { label: 'Client access', value: accessLabel },
                    { label: 'Permissions', value: permissions.length ? permissions.join(', ') : 'None' },
                    { label: 'Finance fields', value: hideFields ? <Pill tone="blue">Hidden</Pill> : 'Visible' },
                  ]}
                />
              </ReviewSection>
              <p className="text-[12px] text-zinc-500 leading-relaxed">
                The invite email goes out on approval. Roles are set per account and can be changed later; the account
                owner cannot be deactivated.
              </p>
            </>
          }
          approveLabel="Approve & invite"
          successMessage={`Invitation sent to ${email.trim() || 'the new colleague'} as ${role}.`}
          auditAction="Invited colleague"
          auditScope={`${name.trim() || 'unnamed'} — ${role}`}
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
          ? 'bg-brand text-white border-brand shadow-[0_0_12px_rgba(20,227,196,0.25)]'
          : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      {children}
    </button>
  );
}
