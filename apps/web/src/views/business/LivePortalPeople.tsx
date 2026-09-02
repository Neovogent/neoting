import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { WorkspaceRole } from '@neoting/contracts/model';

import {
  fetchPortalPeople,
  invitePerson,
  type InvitePersonInput,
  isPortalAccessRole,
  PORTAL_ACCESS_ROLES,
  type PortalAccessRole,
  type PortalPersonRow,
  removePerson,
  updatePerson,
} from '../../api/portalPeople';
import { NtProblemError } from '@neoting/contracts';
import { Panel } from './LivePortalHome';

/**
 * **Settings → People** — the client's own access list (D45, D49).
 *
 * This screen said *"Managed by your accountant … they cannot be added from this
 * screen"* until 2 Sep 2026, and the product owner ruled that wrong. A
 * restaurant's manager knows who photographs the receipts; an accounting firm
 * does not, and making them the registrar put a support ticket between a new
 * starter and their first receipt.
 *
 * ## What this component may and may not decide
 *
 * **It decides nothing.** Every refusal below is the SERVER's, rendered — the
 * authority check, the last-owner rule, the duplicate address, the
 * self-removal. What is duplicated here is only what a form can answer without
 * asking (a blank name, an address with no `@`), so that the common mistakes are
 * caught before a round trip; the server checks all of them again and its answer
 * is what is shown.
 *
 * ⚠ **`canManagePeople` is a fact for HONEST DEGRADATION, never a gate.**
 * Governance §11.2: *"a UI that merely hides the button is not an implementation
 * of this."* A plain `BUSINESS_STANDARD` sees the whole list — who else can send
 * paperwork on your employer's behalf is not a secret from you — plus one line
 * saying who can change it. The section is never hidden.
 *
 * ## Two things both called "role", kept apart
 *
 * - **`jobTitle` is FREE TEXT.** *"A restaurant has a Head Chef and a site has a
 *   Foreman, and forcing those into 'Staff' loses the only thing that made the
 *   role worth recording."* Owner / Manager / Staff are SUGGESTIONS on this
 *   screen — a datalist, not a select — and nothing branches on it.
 * - **`access` is the AUTHORITY**, and it is the enum the last-owner rule keys
 *   on. A protection that can be defeated by retyping a label is not a
 *   protection.
 */

const m = defineMessages({
  title: { id: 'portal.livePortalPeople.title', defaultMessage: 'Who can send documents' },
  subtitle: {
    id: 'portal.livePortalPeople.subtitle',
    defaultMessage: 'Everyone here signs in with a six-digit code emailed to them. There is no password to share.',
  },
  loading: { id: 'portal.livePortalPeople.loading', defaultMessage: 'Loading your people…' },
  loadFailed: {
    id: 'portal.livePortalPeople.loadFailed',
    defaultMessage: 'We could not load your people. Try again in a moment.',
  },
  retry: { id: 'portal.livePortalPeople.retry', defaultMessage: 'Try again' },
  readOnly: {
    id: 'portal.livePortalPeople.readOnly',
    defaultMessage:
      'Only an owner or a user administrator at your business can add or remove people. Ask one of them if this needs to change.',
  },
  truncated: {
    id: 'portal.livePortalPeople.truncated',
    defaultMessage: 'Showing the first {count} people — there are more.',
  },
  addAction: { id: 'portal.livePortalPeople.addAction', defaultMessage: 'Add someone' },
  you: { id: 'portal.livePortalPeople.you', defaultMessage: 'You' },
  removed: { id: 'portal.livePortalPeople.removed', defaultMessage: 'Removed' },
  noEmail: { id: 'portal.livePortalPeople.noEmail', defaultMessage: 'No email address' },
  removeAction: { id: 'portal.livePortalPeople.removeAction', defaultMessage: 'Remove' },
  removeLastOwner: {
    id: 'portal.livePortalPeople.removeLastOwner',
    defaultMessage: 'This is your only owner — make someone else an owner first.',
  },
  removeSelf: {
    id: 'portal.livePortalPeople.removeSelf',
    defaultMessage: 'You cannot remove your own access. Ask another owner or user administrator.',
  },
  removeConfirm: {
    id: 'portal.livePortalPeople.removeConfirm',
    defaultMessage:
      'Remove {name}? They stop being able to send documents immediately. Anything they already sent stays with your accountant.',
  },
  canSend: { id: 'portal.livePortalPeople.canSend', defaultMessage: 'Can send documents' },
  canSeeTotals: { id: 'portal.livePortalPeople.canSeeTotals', defaultMessage: 'Can see totals' },
  accessOwner: { id: 'portal.livePortalPeople.accessOwner', defaultMessage: 'Owner' },
  accessUserAdmin: { id: 'portal.livePortalPeople.accessUserAdmin', defaultMessage: 'User administrator' },
  accessStandard: { id: 'portal.livePortalPeople.accessStandard', defaultMessage: 'Member' },
});

/**
 * The three business-level roles, in the words a client reads.
 *
 * ⚠ Keyed by the CONTRACT's enum, so only the label is copy. `WorkspaceRole`
 * also carries the FIRM's three roles, which this screen must never offer or
 * name — a client cannot hold one, and the server refuses them.
 */
const ACCESS_LABEL: Record<PortalAccessRole, { id: string; defaultMessage: string }> = {
  BUSINESS_ADMIN: m.accessOwner,
  USER_ADMIN: m.accessUserAdmin,
  BUSINESS_STANDARD: m.accessStandard,
};

export const PEOPLE_QUERY_KEY = ['portal', 'people'] as const;

export function LivePortalPeople({ sessionToken }: { readonly sessionToken: string | null }) {
  const intl = useIntl();
  const client = useQueryClient();
  const [editing, setEditing] = useState<PortalPersonRow | 'new' | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const query = useQuery({
    queryKey: PEOPLE_QUERY_KEY,
    queryFn: () => fetchPortalPeople(sessionToken ?? ''),
    enabled: sessionToken !== null,
  });

  const settle = async () => {
    await client.invalidateQueries({ queryKey: PEOPLE_QUERY_KEY });
  };

  const remove = useMutation({
    mutationFn: (personId: string) => removePerson(sessionToken ?? '', personId),
    onSuccess: settle,
    onError: (error: unknown) => setFault(faultOf(error)),
  });

  const people = query.data?.people ?? [];
  const canManage = query.data?.canManagePeople ?? false;
  // Only ACTIVE owners count. A deactivated one is not somebody who can promote
  // a replacement, so counting them would let the last real owner be removed
  // behind a revoked one — the same rule the server applies.
  const owners = people.filter((p) => p.isActive && p.access === 'BUSINESS_ADMIN');

  return (
    <>
      <Panel title={intl.formatMessage(m.title)} subtitle={intl.formatMessage(m.subtitle)}>
        {query.isPending && (
          <p className="text-[13px] text-zinc-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            {intl.formatMessage(m.loading)}
          </p>
        )}

        {query.isError && (
          <div role="alert" className="text-[13px] text-rose-300">
            <p>{faultOf(query.error) ?? intl.formatMessage(m.loadFailed)}</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-2 px-3 py-1.5 rounded-lg bg-raised text-zinc-200 text-[12px] font-semibold"
            >
              {intl.formatMessage(m.retry)}
            </button>
          </div>
        )}

        {query.isSuccess && (
          <>
            <ul className="flex flex-col">
              {people.map((person) => (
                <li
                  key={person.id}
                  className="flex items-center gap-3 py-3 border-b border-white/5 last:border-0 min-w-0"
                >
                  <span className="w-9 h-9 rounded-full bg-raised grid place-items-center shrink-0" aria-hidden>
                    <UserRound className="w-4 h-4 text-zinc-400" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[13px] font-semibold ${person.isActive ? 'text-white' : 'text-zinc-500'}`}>
                        {person.name ?? person.email ?? intl.formatMessage(m.noEmail)}
                      </span>
                      {person.isYou && (
                        <span className="text-[10px] uppercase tracking-wide text-brand font-bold">
                          {intl.formatMessage(m.you)}
                        </span>
                      )}
                      {!person.isActive && (
                        <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-bold">
                          {intl.formatMessage(m.removed)}
                        </span>
                      )}
                    </span>
                    <span className="block text-[12px] text-zinc-500 truncate" title={person.email ?? undefined}>
                      {[accessLabel(intl, person.access), person.jobTitle, person.email]
                        .filter((part): part is string => part !== null && part !== '')
                        .join(' · ')}
                    </span>
                  </span>

                  {canManage && person.isActive && (
                    <button
                      type="button"
                      // ⚠ Disabled with an EXPLANATORY title, never hidden. A
                      // control that vanishes teaches nothing; one that says why
                      // it cannot be used names the fix.
                      disabled={removeReason(intl, person, owners) !== null || remove.isPending}
                      title={removeReason(intl, person, owners) ?? undefined}
                      onClick={() => {
                        const name = person.name ?? person.email ?? '';
                        if (!window.confirm(intl.formatMessage(m.removeConfirm, { name }))) return;
                        setFault(null);
                        remove.mutate(person.id);
                      }}
                      className="shrink-0 p-2 rounded-lg text-zinc-400 hover:text-rose-300 hover:bg-raised disabled:opacity-40 disabled:hover:text-zinc-400 hit-area"
                      aria-label={intl.formatMessage(m.removeAction)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {query.data?.truncated === true && (
              <p className="mt-3 text-[12px] text-amber-300">
                {intl.formatMessage(m.truncated, { count: people.length })}
              </p>
            )}

            {canManage ? (
              <button
                type="button"
                onClick={() => {
                  setFault(null);
                  setEditing('new');
                }}
                className="mt-4 px-4 py-2.5 rounded-xl bg-brand text-brand-on text-[13px] font-bold flex items-center gap-2"
              >
                <Plus className="w-4 h-4" aria-hidden />
                {intl.formatMessage(m.addAction)}
              </button>
            ) : (
              // Honest degradation: the list is readable, and the sentence names
              // who can change it. The SERVER is what refuses the write.
              <p className="mt-4 text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.readOnly)}</p>
            )}

            {fault !== null && (
              <p role="alert" className="mt-3 text-[12px] text-rose-300">
                {fault}
              </p>
            )}
          </>
        )}
      </Panel>

      {editing !== null && sessionToken !== null && (
        <PortalPersonEditor
          sessionToken={sessionToken}
          person={editing === 'new' ? null : editing}
          people={people}
          owners={owners}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void settle();
          }}
        />
      )}
    </>
  );
}

/**
 * Why this person cannot be removed, or null when they can.
 *
 * Both reasons are the server's and are re-stated here only so the button can
 * explain itself BEFORE it is pressed — the server refuses either way, and its
 * refusal is what gets rendered if this is ever wrong.
 */
function removeReason(
  intl: ReturnType<typeof useIntl>,
  person: PortalPersonRow,
  owners: readonly PortalPersonRow[],
): string | null {
  if (person.isYou) return intl.formatMessage(m.removeSelf);
  if (owners.length === 1 && owners[0]?.id === person.id) return intl.formatMessage(m.removeLastOwner);
  return null;
}

function accessLabel(intl: ReturnType<typeof useIntl>, access: WorkspaceRole): string {
  // A role outside the three is not a state this surface can produce — the
  // server only ever serves a business-level role here — so it falls back to
  // Member rather than rendering a raw enum at a client.
  return intl.formatMessage(isPortalAccessRole(access) ? ACCESS_LABEL[access] : m.accessStandard);
}

/** The `NT-` code in front of the words (frontend ten, item 5). */
function faultOf(error: unknown): string | null {
  if (error instanceof NtProblemError) return `${error.code} — ${error.detail ?? error.title}`;
  return error instanceof Error ? error.message : null;
}

// ── The editor ─────────────────────────────────────────────────────────────

const e = defineMessages({
  addTitle: { id: 'portal.portalPersonEditor.addTitle', defaultMessage: 'Add someone' },
  editTitle: { id: 'portal.portalPersonEditor.editTitle', defaultMessage: 'Change what they can do' },
  nameLabel: { id: 'portal.portalPersonEditor.nameLabel', defaultMessage: 'Name' },
  emailLabel: { id: 'portal.portalPersonEditor.emailLabel', defaultMessage: 'Email address' },
  emailNote: {
    id: 'portal.portalPersonEditor.emailNote',
    defaultMessage: 'This is how they sign in, so it has to be their own — one address is one person.',
  },
  emailLocked: {
    id: 'portal.portalPersonEditor.emailLocked',
    defaultMessage: 'An email address cannot be changed. Remove this person and add them under the new one.',
  },
  jobTitleLabel: { id: 'portal.portalPersonEditor.jobTitleLabel', defaultMessage: 'Job title' },
  jobTitleNote: {
    id: 'portal.portalPersonEditor.jobTitleNote',
    defaultMessage: 'Anything you like — Head Chef, Foreman, Bookkeeper.',
  },
  accessLabel: { id: 'portal.portalPersonEditor.accessLabel', defaultMessage: 'What they can do here' },
  canSendLabel: { id: 'portal.portalPersonEditor.canSendLabel', defaultMessage: 'Can send documents' },
  canSeeTotalsLabel: { id: 'portal.portalPersonEditor.canSeeTotalsLabel', defaultMessage: 'Can see totals' },
  canSeeTotalsNote: {
    id: 'portal.portalPersonEditor.canSeeTotalsNote',
    defaultMessage: 'Leave this off for staff who photograph receipts but should not see the figures.',
  },
  save: { id: 'portal.portalPersonEditor.save', defaultMessage: 'Save' },
  saving: { id: 'portal.portalPersonEditor.saving', defaultMessage: 'Saving…' },
  cancel: { id: 'portal.portalPersonEditor.cancel', defaultMessage: 'Cancel' },
  errName: { id: 'portal.portalPersonEditor.errName', defaultMessage: 'Enter their name.' },
  errEmail: { id: 'portal.portalPersonEditor.errEmail', defaultMessage: 'Enter their email address.' },
  errEmailInvalid: {
    id: 'portal.portalPersonEditor.errEmailInvalid',
    defaultMessage: 'That does not look like an email address.',
  },
  errEmailTaken: {
    id: 'portal.portalPersonEditor.errEmailTaken',
    defaultMessage: 'Someone on this business already uses that email address.',
  },
  errLastOwner: {
    id: 'portal.portalPersonEditor.errLastOwner',
    defaultMessage: 'This is your only owner — make someone else an owner first.',
  },
  suggestOwner: { id: 'portal.portalPersonEditor.suggestOwner', defaultMessage: 'Owner' },
  suggestManager: { id: 'portal.portalPersonEditor.suggestManager', defaultMessage: 'Manager' },
  suggestStaff: { id: 'portal.portalPersonEditor.suggestStaff', defaultMessage: 'Staff' },
});

/**
 * Add or change one person.
 *
 * ⚠ **THE SAVE GATE REFUSES IN A FIXED ORDER**, and the order is the design
 * rather than an implementation detail: name → email → a valid email →
 * a duplicate email → the last-owner rule. A person filling in a form should be
 * told about the FIRST thing that is wrong, not the last, and a screen and a
 * server that disagree about which that is will contradict each other on every
 * slow connection. The server applies the same order.
 */
function PortalPersonEditor({
  sessionToken,
  person,
  people,
  owners,
  onClose,
  onSaved,
}: {
  readonly sessionToken: string;
  readonly person: PortalPersonRow | null;
  readonly people: readonly PortalPersonRow[];
  readonly owners: readonly PortalPersonRow[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const intl = useIntl();
  const [name, setName] = useState(person?.name ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [jobTitle, setJobTitle] = useState(person?.jobTitle ?? '');
  const [access, setAccess] = useState<PortalAccessRole>(
    person !== null && isPortalAccessRole(person.access) ? person.access : 'BUSINESS_STANDARD',
  );
  const [canSendDocuments, setCanSend] = useState(person?.canSendDocuments ?? true);
  const [canSeeTotals, setCanSeeTotals] = useState(person?.canSeeTotals ?? false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (person === null) {
        const input: InvitePersonInput = {
          name,
          email,
          jobTitle: jobTitle.trim() === '' ? null : jobTitle.trim(),
          access,
          canSendDocuments,
          canSeeTotals,
        };
        await invitePerson(sessionToken, input);
        return;
      }
      await updatePerson(sessionToken, person.id, {
        name: name.trim(),
        jobTitle: jobTitle.trim() === '' ? null : jobTitle.trim(),
        access,
        canSendDocuments,
        canSeeTotals,
      });
    },
    onSuccess: onSaved,
    onError: (err: unknown) => setError(faultOf(err)),
  });

  const submit = () => {
    const refusal = gateFor(intl, { name, email, access }, person, people, owners);
    setError(refusal);
    if (refusal === null) save.mutate();
  };

  return (
    <div className="mt-4">
      <Panel title={intl.formatMessage(person === null ? e.addTitle : e.editTitle)}>
        <div className="flex flex-col gap-4">
          <Field label={intl.formatMessage(e.nameLabel)}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              className="w-full px-3 py-2.5 rounded-xl bg-ground border border-white/5 text-[13px] text-white"
            />
          </Field>

          <Field
            label={intl.formatMessage(e.emailLabel)}
            note={intl.formatMessage(person === null ? e.emailNote : e.emailLocked)}
          >
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              // ⚠ Read-only on an EDIT, because the contract has no path to
              // change it: the address is the sign-in channel and the ingest
              // sender-map key at once, so changing it is removing one person
              // and inviting another.
              readOnly={person !== null}
              type="email"
              autoComplete="email"
              inputMode="email"
              className={`w-full px-3 py-2.5 rounded-xl bg-ground border border-white/5 text-[13px] ${
                person === null ? 'text-white' : 'text-zinc-500'
              }`}
            />
          </Field>

          <Field label={intl.formatMessage(e.jobTitleLabel)} note={intl.formatMessage(e.jobTitleNote)}>
            {/* Free text with SUGGESTIONS — a datalist, never a select. A site's
                Foreman must not be flattened into "Staff". */}
            <input
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
              list="portal-person-job-titles"
              className="w-full px-3 py-2.5 rounded-xl bg-ground border border-white/5 text-[13px] text-white"
            />
            <datalist id="portal-person-job-titles">
              <option value={intl.formatMessage(e.suggestOwner)} />
              <option value={intl.formatMessage(e.suggestManager)} />
              <option value={intl.formatMessage(e.suggestStaff)} />
            </datalist>
          </Field>

          <Field label={intl.formatMessage(e.accessLabel)}>
            <select
              value={access}
              onChange={(event) => setAccess(event.target.value as PortalAccessRole)}
              className="w-full px-3 py-2.5 rounded-xl bg-ground border border-white/5 text-[13px] text-white"
            >
              {PORTAL_ACCESS_ROLES.map((role) => (
                <option key={role} value={role}>
                  {intl.formatMessage(ACCESS_LABEL[role])}
                </option>
              ))}
            </select>
          </Field>

          <Toggle
            label={intl.formatMessage(e.canSendLabel)}
            checked={canSendDocuments}
            onChange={setCanSend}
          />
          <Toggle
            label={intl.formatMessage(e.canSeeTotalsLabel)}
            note={intl.formatMessage(e.canSeeTotalsNote)}
            checked={canSeeTotals}
            onChange={setCanSeeTotals}
          />

          {error !== null && (
            <p role="alert" className="text-[12px] text-rose-300">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={save.isPending}
              className="px-4 py-2.5 rounded-xl bg-brand text-brand-on text-[13px] font-bold disabled:opacity-60"
            >
              {intl.formatMessage(save.isPending ? e.saving : e.save)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-raised text-zinc-300 text-[13px] font-semibold"
            >
              {intl.formatMessage(e.cancel)}
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/**
 * The gate, in the order the screen states it and the server applies it.
 *
 * Exported for the test rather than reached through the DOM: the ORDER is the
 * thing worth pinning, and a rendering test can only observe whichever message
 * came out first.
 */
export function gateFor(
  intl: ReturnType<typeof useIntl>,
  draft: { name: string; email: string; access: PortalAccessRole },
  person: PortalPersonRow | null,
  people: readonly PortalPersonRow[],
  owners: readonly PortalPersonRow[],
): string | null {
  if (draft.name.trim() === '') return intl.formatMessage(e.errName);

  // The address is only collected on an invite; an edit cannot change it.
  if (person === null) {
    const email = draft.email.trim();
    if (email === '') return intl.formatMessage(e.errEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return intl.formatMessage(e.errEmailInvalid);
    // ⚠ Case-insensitive, and a DEACTIVATED person still holds their address:
    // reviving somebody is a different act from inviting a second person under
    // it, and two rows on one address would make "who sent this" ambiguous for
    // the ingest router (D45).
    const taken = people.some((p) => (p.email ?? '').trim().toLowerCase() === email.toLowerCase());
    if (taken) return intl.formatMessage(e.errEmailTaken);
  }

  // Last-owner, checked last because it is the only rung that depends on the
  // whole list rather than on this form.
  const demoting = person !== null && person.access === 'BUSINESS_ADMIN' && draft.access !== 'BUSINESS_ADMIN';
  if (demoting && owners.length === 1 && owners[0]?.id === person.id) return intl.formatMessage(e.errLastOwner);

  return null;
}

function Field({
  label,
  note,
  children,
}: {
  readonly label: string;
  readonly note?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-zinc-300">{label}</span>
      {children}
      {note !== undefined && <span className="text-[11px] text-zinc-500 leading-relaxed">{note}</span>}
    </label>
  );
}

function Toggle({
  label,
  note,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly note?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 hit-area"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-zinc-200 font-semibold">{label}</span>
        {note !== undefined && <span className="block text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{note}</span>}
      </span>
    </label>
  );
}

export default LivePortalPeople;
