import { useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, Send } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { Client, MissingItem } from '../../lib/types';

const m = defineMessages({
  // MessageEditor
  messageLabel: { id: 'shell.chaseComposer.messageLabel', defaultMessage: 'Message text' },
  // "{chars} characters" is not a `plural` argument on purpose: the source said
  // "1 characters" and #65 extracts copy rather than correcting it. The segment
  // count was a concatenated 's' and had to become ICU (§12.6).
  counts: {
    id: 'shell.chaseComposer.counts',
    defaultMessage: '{chars} characters · {segments, plural, one {# text} other {# texts}}',
  },
  countsUnicode: {
    id: 'shell.chaseComposer.countsUnicode',
    defaultMessage:
      '{chars} characters · {segments, plural, one {# text} other {# texts}} · non-standard characters, 70 per text',
  },
  resetAction: { id: 'shell.chaseComposer.resetAction', defaultMessage: 'Reset to suggested' },
  linkGone: {
    id: 'shell.chaseComposer.linkGone',
    defaultMessage: 'The upload link has gone. Without it there is nowhere for the client to send the document.',
  },

  // ChaseComposer
  nothingOutstanding: {
    id: 'shell.chaseComposer.nothingOutstanding',
    defaultMessage:
      'Nothing outstanding to chase for this scope — every detected gap is either received, chased or suppressed.',
  },
  previewHeading: {
    id: 'shell.chaseComposer.previewHeading',
    defaultMessage:
      '{count, plural, one {Message preview (SMS) — # recipient} other {Message preview (SMS) — # recipients}}',
  },
  // Not a `plural`: the source read "1 items" for a single row and this is an
  // extraction, not a rewrite.
  itemsPill: { id: 'shell.chaseComposer.itemsPill', defaultMessage: '{count} items' },
  itemsHeading: { id: 'shell.chaseComposer.itemsHeading', defaultMessage: 'Items being chased' },
  policyHeading: { id: 'shell.chaseComposer.policyHeading', defaultMessage: 'Policy' },
  channelLabel: { id: 'shell.chaseComposer.channelLabel', defaultMessage: 'Channel' },
  channelValue: {
    id: 'shell.chaseComposer.channelValue',
    defaultMessage: 'SMS only — no WhatsApp or email chases',
  },
  linkSecurityLabel: { id: 'shell.chaseComposer.linkSecurityLabel', defaultMessage: 'Link security' },
  linkSecurityValue: {
    id: 'shell.chaseComposer.linkSecurityValue',
    defaultMessage: 'Signed short-lived URL + OTP to registered mobile',
  },
  portalScopeLabel: { id: 'shell.chaseComposer.portalScopeLabel', defaultMessage: 'Portal scope' },
  portalScopeValue: {
    id: 'shell.chaseComposer.portalScopeValue',
    defaultMessage: 'Upload-only, limited to the requested items',
  },
  remindersLabel: { id: 'shell.chaseComposer.remindersLabel', defaultMessage: 'Auto-reminders' },
  remindersValue: {
    id: 'shell.chaseComposer.remindersValue',
    defaultMessage: '+3 days, then +7 days, then escalate',
  },
  suppressionLabel: { id: 'shell.chaseComposer.suppressionLabel', defaultMessage: 'Suppression' },
  suppressionValue: {
    id: 'shell.chaseComposer.suppressionValue',
    defaultMessage: 'Received · unavailable · dismissed · cash-coded',
  },
  appRequiredLabel: { id: 'shell.chaseComposer.appRequiredLabel', defaultMessage: 'App required' },
  appRequiredValue: { id: 'shell.chaseComposer.appRequiredValue', defaultMessage: 'No — OTP link' },
  titleOne: { id: 'shell.chaseComposer.titleOne', defaultMessage: 'Chase {client}' },
  titleMany: { id: 'shell.chaseComposer.titleMany', defaultMessage: 'Chase {count} clients' },
  editDone: { id: 'shell.chaseComposer.editDone', defaultMessage: 'Done editing' },
  editStart: { id: 'shell.chaseComposer.editStart', defaultMessage: 'Edit message' },
  subtitle: {
    id: 'shell.chaseComposer.subtitle',
    defaultMessage: 'SMS to primary contacts • {count, plural, one {# missing item} other {# missing items}}',
  },
  approveAction: { id: 'shell.chaseComposer.approveAction', defaultMessage: 'Approve & send' },
  success: {
    id: 'shell.chaseComposer.success',
    defaultMessage: 'Chase sent to {clientCount, plural, one {# client} other {# clients}} ({itemCount} items) via SMS.',
  },
  auditAction: { id: 'shell.chaseComposer.auditAction', defaultMessage: 'Sent chase' },
  auditScope: { id: 'shell.chaseComposer.auditScope', defaultMessage: '{count} items across {clients}' },

  // The one fragment of the SMS body that had to move (see `composeSms`).
  // Whole clause inside the arms rather than a bare "# item"/"# items": a
  // locale that puts the count last, or joins with something other than a
  // comma, can then rewrite the fragment instead of being handed the English
  // word order with a hole in it.
  smsTail: {
    id: 'shell.chaseComposer.smsTail',
    defaultMessage: '{count, plural, one {, plus # other item} other {, plus # other items}}',
  },
});

/**
 * One SMS per client naming the exact transactions — never one text per receipt.
 *
 * Deliberately NOT extracted by #65, with one exception. This is the chase
 * template, and CLAUDE.md puts "anything touching SMS sending or chase
 * templates" on the stop-and-ask list; `lib/seed`'s `generate.ts` holds a second
 * copy of the same wording, so extracting one and not the other would split the
 * template across two sources of truth. It needs a decision about where chase
 * wording lives before it can move into a catalogue.
 *
 * The exception is the "plus N other items" tail. That was a concatenated
 * `? '' : 's'`, which §12.6 forbids outright and which no translator can fix
 * from a catalogue — the plural rule is baked into the code, not the message.
 * It is ICU now, which is why this function takes an `intl`: it runs at module
 * scope and cannot call a hook. The rest of the wording is untouched and still
 * waiting on that decision, and `generate.ts` still carries the same
 * concatenation in its own copy of this template.
 */
function composeSms(client: Client, items: MissingItem[], intl: IntlShape) {
  const head = items[0];
  const rest = items.length - 1;
  const first = head
    ? `we're missing the ${head.detectedBy === 'statement-gap' ? 'bank statement' : 'receipt'} for ${head.supplier}${
        head.amount ? ` ${currency(head.amount)}` : ''
      } on ${head.date.replace(/ \d{4}$/, '')}`
    : 'we need some paperwork from you';
  // The `rest > 0` guard stays: a `plural` on zero renders "plus 0 other
  // items", and the tail is meant to be absent entirely for a single item.
  const tail = rest > 0 ? intl.formatMessage(m.smsTail, { count: rest }) : '';
  return `${client.name.replace(/ Ltd$/, '')} Accounts: ${first}${tail}. Upload securely: https://sec.ure/${client.id}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * How many texts this will actually be.
 *
 * SMS is billed and delivered in segments, and the boundary is not where
 * people expect: 160 characters for one message, but 153 each once it spills
 * into two, and a single curly quote or emoji drops the whole thing to 70.
 * An accountant lengthening a chase deserves to see the moment it becomes
 * three texts to their client rather than finding out on the invoice.
 */
export function smsSegments(text: string): {
  segments: number;
  unicode: boolean;
  perSegment: number;
  /** Billable units, which is not the same as characters. */
  used: number;
} {
  // The GSM 03.38 basic set, near enough: anything outside it forces UCS-2.
  const unicode = /[^\x20-\x7E\n\r£€@¡¿ÄÖÑÜäöñüàèéìòù]/.test(text);

  /**
   * Seven characters cost two septets each rather than one — the escape
   * table in GSM 03.38. A € in an amount or a [ in a reference therefore
   * takes two of the 160, so counting characters alone reports one text where
   * the carrier bills two.
   */
  const extended = (text.match(/[€{}[\]~^|\\]/g) ?? []).length;
  const used = unicode ? text.length : text.length + extended;

  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const perSegment = used <= single ? single : multi;
  const segments = used === 0 ? 0 : used <= single ? 1 : Math.ceil(used / multi);
  return { segments, unicode, perSegment, used };
}

/** The message, editable, with the two things that can go wrong called out. */
export function MessageEditor({ value, suggested, onChange, onReset }: {
  value: string;
  suggested: string;
  onChange: (text: string) => void;
  onReset: () => void;
}) {
  const intl = useIntl();
  const { segments, unicode } = smsSegments(value);
  // A chase without the upload link is a text asking for something with no way
  // to send it — the single most damaging edit possible here.
  const linkKept = /https?:\/\/\S+/.test(value);
  const changed = value !== suggested;

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        aria-label={intl.formatMessage(m.messageLabel)}
        className="w-full px-3 py-2.5 rounded-xl bg-raised border border-white/10 text-[13px] text-white font-mono leading-relaxed resize-y focus:outline-none focus:border-brand/50"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] font-bold">
        <span className={segments > 2 ? 'text-amber-400' : 'text-zinc-500'}>
          {intl.formatMessage(unicode ? m.countsUnicode : m.counts, { chars: value.length, segments })}
        </span>
        {changed && (
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <RotateCcw size={11} />
            {intl.formatMessage(m.resetAction)}
          </button>
        )}
      </div>

      {!linkKept && (
        <p className="flex items-start gap-2 text-[11.5px] font-semibold text-amber-400 leading-snug">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          {intl.formatMessage(m.linkGone)}
        </p>
      )}
    </div>
  );
}

/**
 * Chase composer (PRD stage 8). SMS-only by design; the secure link is signed
 * and short-lived with an OTP challenge, and is deliberately forwardable to
 * whoever physically holds the document.
 */
export function ChaseComposer({ clientIds, missingItemIds }: {
  clientIds: string[];
  /**
   * Narrows the chase to specific items. Without it the composer takes
   * everything outstanding for the client, which is right when the request
   * came from "chase this client" but wrong when someone picked three rows.
   *
   * `| undefined` is explicit because it is read off `MessagePayload`, which
   * makes it optional, so the caller passes a real `undefined`.
   */
  missingItemIds?: string[] | undefined;
}) {
  const { clients, missing, sendChase } = useAppContext();
  const intl = useIntl();
  /** Rewrites, per client. Absent means the suggested wording still stands. */
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);

  const wanted = missingItemIds?.length ? new Set(missingItemIds) : null;
  const targets = clients
    .filter((c) => (clientIds.length ? clientIds.includes(c.id) : true))
    .map((c) => ({
      client: c,
      items: missing.filter((m) => m.clientId === c.id && !m.chased && (!wanted || wanted.has(m.id))),
    }))
    .filter((t) => t.items.length > 0);

  const totalItems = targets.reduce((n, t) => n + t.items.length, 0);

  /**
   * Composed once for these items, not on every render.
   *
   * `composeSms` mints a link with `Math.random()`, so recomputing it in the
   * render body gave a different URL every time the component drew — the text
   * an accountant read was not the text that would go out. Memoised on what
   * the message actually depends on.
   *
   * The dependency is a derived IDENTITY STRING, not `targets` itself, because
   * `targets` is rebuilt every render and comparing it by reference would make
   * every render a recompute — which for THIS memo is not a harmless waste but
   * the bug itself, per the paragraph above. So when `exhaustive-deps` arrived
   * (it wasn't installed when this was written) it got the one thing it is
   * right about — `intl` in the array, and the expression hoisted to a named
   * variable it can see — and a disable for the one thing it cannot know:
   * that `targets` is keyed here by value on purpose.
   *
   * It sits ABOVE the targets-empty return, because a hook after a conditional
   * return changes the hook count between renders — the exact shape behind
   * "Rendered fewer hooks than expected" (#87). It is safe with empty targets:
   * it maps an empty array and its identity-string dep is ''.
   */
  const targetsIdentity = targets.map((t) => `${t.client.id}:${t.items.map((i) => i.id).join(',')}`).join('|');
  const suggested = useMemo(
    () => targets.map((t) => ({ ...t, sms: composeSms(t.client, t.items, intl) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targets is deliberately keyed by targetsIdentity (its value), not by reference: it is rebuilt every render, and a reference dep would re-mint the Math.random() SMS link each render — the bug this memo exists to stop.
    [targetsIdentity, intl],
  );

  if (targets.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        {intl.formatMessage(m.nothingOutstanding)}
      </div>
    );
  }

  const drafts = suggested.map((d) => ({ ...d, sms: edited[d.client.id] ?? d.sms }));

  const detail = (
    <>
      <ReviewSection title={intl.formatMessage(m.previewHeading, { count: drafts.length })}>
        <div className="flex flex-col gap-3">
          {drafts.map((d) => (
            <div key={d.client.id} className="bg-card border border-white/5 rounded-2xl p-4 shadow-inner">
              <div className="flex items-center justify-between gap-3 mb-2.5">
                <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                  {d.client.contactName} · {d.client.mobile}
                </span>
                <Pill tone="blue">{intl.formatMessage(m.itemsPill, { count: d.items.length })}</Pill>
              </div>
              {editing ? (
                <MessageEditor
                  value={d.sms}
                  suggested={suggested.find((x) => x.client.id === d.client.id)?.sms ?? d.sms}
                  onChange={(text) => setEdited((prev) => ({ ...prev, [d.client.id]: text }))}
                  onReset={() =>
                    setEdited((prev) => {
                      const next = { ...prev };
                      delete next[d.client.id];
                      return next;
                    })
                  }
                />
              ) : (
                <p className="text-[13px] text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap">{d.sms}</p>
              )}
            </div>
          ))}
        </div>
      </ReviewSection>

      <ReviewSection title={intl.formatMessage(m.itemsHeading)}>
        <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-56 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {drafts.flatMap((d) =>
            d.items.map((it) => (
              <div key={it.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-[13px]">
                <span className="text-zinc-400 truncate">
                  {it.supplier} · {it.date}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-zinc-600 font-bold uppercase tracking-wider">{it.detectedBy}</span>
                  <span className="text-white font-bold">{it.amount ? currency(it.amount) : '—'}</span>
                </span>
              </div>
            )),
          )}
        </div>
      </ReviewSection>

      <ReviewSection title={intl.formatMessage(m.policyHeading)}>
        <ReviewRows
          rows={[
            { label: intl.formatMessage(m.channelLabel), value: intl.formatMessage(m.channelValue) },
            { label: intl.formatMessage(m.linkSecurityLabel), value: intl.formatMessage(m.linkSecurityValue) },
            { label: intl.formatMessage(m.portalScopeLabel), value: intl.formatMessage(m.portalScopeValue) },
            { label: intl.formatMessage(m.remindersLabel), value: intl.formatMessage(m.remindersValue) },
            { label: intl.formatMessage(m.suppressionLabel), value: intl.formatMessage(m.suppressionValue) },
            { label: intl.formatMessage(m.appRequiredLabel), value: <Pill tone="blue">{intl.formatMessage(m.appRequiredValue)}</Pill> },
          ]}
        />
      </ReviewSection>
    </>
  );

  // Naming the one recipient beats a count of one. `drafts` is never empty
  // here — the nothing-to-chase case returned above.
  const only = drafts.length === 1 ? drafts[0] : undefined;

  return (
    <ReviewGate
      icon={Send}
      title={
        only
          ? intl.formatMessage(m.titleOne, { client: only.client.name })
          : intl.formatMessage(m.titleMany, { count: drafts.length })
      }
      onEdit={() => setEditing((v) => !v)}
      editLabel={intl.formatMessage(editing ? m.editDone : m.editStart)}
      subtitle={intl.formatMessage(m.subtitle, { count: totalItems })}
      detail={detail}
      approveLabel={intl.formatMessage(m.approveAction)}
      successMessage={intl.formatMessage(m.success, { clientCount: drafts.length, itemCount: totalItems })}
      auditAction={intl.formatMessage(m.auditAction)}
      auditScope={intl.formatMessage(m.auditScope, {
        count: totalItems,
        clients: drafts.map((d) => d.client.name).join(', '),
      })}
      onApprove={() => {
        // The approved wording is what goes, not a freshly composed one.
        drafts.forEach((d) => sendChase(d.client.id, d.items.map((i) => i.id), d.sms));
      }}
    />
  );
}
