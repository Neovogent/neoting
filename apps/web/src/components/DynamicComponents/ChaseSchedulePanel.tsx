import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { defineMessages, useIntl } from 'react-intl';
import type { ChasePolicySettings, CreateActionProposalRequest } from '@neoting/contracts/model';
import { CHASE_POLICY_QUERY_KEY, useChasePolicy } from '../../api/chasePolicy';
import { errorLabel } from '../../api/slices';
import { Toggle } from './FormControls';
import { LiveProposalFlow } from './LiveProposalFlow';

const m = defineMessages({
  title: { id: 'settings.chaseSchedulePanel.title', defaultMessage: 'Chasing schedule' },
  subtitle: {
    id: 'settings.chaseSchedulePanel.subtitle',
    defaultMessage: 'Automatic reminders for unanswered document requests',
  },
  intro: {
    id: 'settings.chaseSchedulePanel.intro',
    defaultMessage:
      'When this is on, a request the client has not answered is sent again automatically — the same approved message with "Reminder:" in front and a working upload link. Changing the schedule, or switching it on or off, needs your super admin to approve it.',
  },
  loading: { id: 'settings.chaseSchedulePanel.loading', defaultMessage: 'Reading the current schedule…' },
  loadFailed: { id: 'settings.chaseSchedulePanel.loadFailed', defaultMessage: 'The schedule could not be read: {error}' },
  statusOn: { id: 'settings.chaseSchedulePanel.statusOn', defaultMessage: 'Currently ON — approved {date}' },
  statusOff: { id: 'settings.chaseSchedulePanel.statusOff', defaultMessage: 'Currently OFF — no reminder is sent automatically' },
  enabled: { id: 'settings.chaseSchedulePanel.enabled', defaultMessage: 'Send reminders automatically' },
  firstReminder: { id: 'settings.chaseSchedulePanel.firstReminder', defaultMessage: 'First reminder (days after sending)' },
  secondReminder: { id: 'settings.chaseSchedulePanel.secondReminder', defaultMessage: 'Second reminder (days after sending)' },
  maxReminders: { id: 'settings.chaseSchedulePanel.maxReminders', defaultMessage: 'Most reminders per request' },
  escalate: { id: 'settings.chaseSchedulePanel.escalate', defaultMessage: 'Tell us it is overdue after (days)' },
  quietFrom: { id: 'settings.chaseSchedulePanel.quietFrom', defaultMessage: 'Quiet hours from (UK time, hour)' },
  quietTo: { id: 'settings.chaseSchedulePanel.quietTo', defaultMessage: 'Quiet hours until (UK time, hour)' },
  invalid: {
    id: 'settings.chaseSchedulePanel.invalid',
    defaultMessage: 'The second reminder has to come after the first, and hours run from 0 to 23.',
  },
  stage: { id: 'settings.chaseSchedulePanel.stage', defaultMessage: 'Send this schedule for approval' },
});

type Draft = ChasePolicySettings & { enabled: boolean };

/**
 * Settings → Chasing, live (rush/chase-scheduler). The current schedule from
 * `GET /v1/chase-policy`, an editable draft, and the ordinary proposal flow:
 * submitting stages a `policy.activate` proposal carrying `chasePolicy`, and
 * `LiveProposalFlow` renders the server's own review card. Nothing here writes
 * the schedule — the approval does.
 */
export default function ChaseSchedulePanel() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const policy = useChasePolicy({ enabled: true });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (policy.data !== undefined && draft === null) {
      const { actionProposalId: _id, updatedAt: _at, ...settings } = policy.data;
      setDraft(settings);
    }
  }, [policy.data, draft]);

  const valid =
    draft !== null &&
    draft.secondReminderDays > draft.firstReminderDays &&
    [draft.quietHoursStart, draft.quietHoursEnd].every((h) => h >= 0 && h <= 23);

  const buildRequest = (): CreateActionProposalRequest => {
    const { enabled, ...chasePolicy } = draft!;
    return { kind: 'policy.activate', businessId: null, payload: { active: enabled, chasePolicy } };
  };

  const num = (label: string, key: keyof ChasePolicySettings, min: number, max: number) =>
    draft === null ? null : (
      <label className="block">
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
        <input
          type="number"
          min={min}
          max={max}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: Math.min(max, Math.max(min, Math.trunc(Number(e.target.value)))) })}
          className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors"
        />
      </label>
    );

  return (
    <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 pb-4 border-b border-white/5">
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(m.title)}</h3>
        <p className="text-[12px] text-zinc-500 mt-0.5 font-semibold uppercase tracking-wider">{intl.formatMessage(m.subtitle)}</p>
      </div>
      <div className="p-6 flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.intro)}</p>
        {policy.isPending && <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.loading)}</p>}
        {policy.isError && (
          <p role="alert" className="text-[13px] text-red-400">
            {intl.formatMessage(m.loadFailed, { error: errorLabel(policy.error) ?? '' })}
          </p>
        )}
        {policy.data !== undefined && (
          <p className="text-[13px] font-semibold text-zinc-300">
            {policy.data.enabled
              ? intl.formatMessage(m.statusOn, {
                  date: policy.data.updatedAt === null ? '' : intl.formatDate(policy.data.updatedAt, { dateStyle: 'long', timeZone: 'Europe/London' }),
                })
              : intl.formatMessage(m.statusOff)}
          </p>
        )}
        {draft !== null && (
          <>
            <Toggle label={intl.formatMessage(m.enabled)} value={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
            <div className="grid grid-cols-2 gap-4">
              {num(intl.formatMessage(m.firstReminder), 'firstReminderDays', 1, 60)}
              {num(intl.formatMessage(m.secondReminder), 'secondReminderDays', 2, 90)}
              {num(intl.formatMessage(m.maxReminders), 'maxReminders', 0, 5)}
              {num(intl.formatMessage(m.escalate), 'escalateAfterDays', 1, 180)}
              {num(intl.formatMessage(m.quietFrom), 'quietHoursStart', 0, 23)}
              {num(intl.formatMessage(m.quietTo), 'quietHoursEnd', 0, 23)}
            </div>
            {!valid && <p className="text-[12px] text-amber-400">{intl.formatMessage(m.invalid)}</p>}
            <LiveProposalFlow
              buildRequest={buildRequest}
              clientName={null}
              stageLabel={intl.formatMessage(m.stage)}
              disabled={!valid}
              onExecuted={() => void queryClient.invalidateQueries({ queryKey: CHASE_POLICY_QUERY_KEY })}
            />
          </>
        )}
      </div>
    </div>
  );
}
