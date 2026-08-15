import { useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, Send } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { Client, MissingItem } from '../../lib/types';

/** One SMS per client naming the exact transactions — never one text per receipt. */
function composeSms(client: Client, items: MissingItem[]) {
  const head = items[0];
  const rest = items.length - 1;
  const first = head
    ? `we're missing the ${head.detectedBy === 'statement-gap' ? 'bank statement' : 'receipt'} for ${head.supplier}${
        head.amount ? ` ${currency(head.amount)}` : ''
      } on ${head.date.replace(/ \d{4}$/, '')}`
    : 'we need some paperwork from you';
  const tail = rest > 0 ? `, plus ${rest} other item${rest === 1 ? '' : 's'}` : '';
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
        aria-label="Message text"
        className="w-full px-3 py-2.5 rounded-xl bg-[#202026] border border-white/10 text-[13px] text-white font-mono leading-relaxed resize-y focus:outline-none focus:border-[#14e3c4]/50"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] font-bold">
        <span className={segments > 2 ? 'text-amber-400' : 'text-zinc-500'}>
          {value.length} characters · {segments} text{segments === 1 ? '' : 's'}
          {unicode && ' · non-standard characters, 70 per text'}
        </span>
        {changed && (
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <RotateCcw size={11} />
            Reset to suggested
          </button>
        )}
      </div>

      {!linkKept && (
        <p className="flex items-start gap-2 text-[11.5px] font-semibold text-amber-400 leading-snug">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          The upload link has gone. Without it there is nowhere for the client to send the document.
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

  if (targets.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-[#16161a] p-5 text-sm text-zinc-400">
        Nothing outstanding to chase for this scope — every detected gap is either received, chased or suppressed.
      </div>
    );
  }

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
   * `targets` is rebuilt every render and comparing it by reference would defeat
   * the memo entirely. `react-hooks/exhaustive-deps` would flag this shape; the
   * plugin is not installed here yet, so there is nothing to suppress and a
   * disable directive for it is itself a lint error. Tracked with the other
   * missing plugins in eslint.config.js.
   */
  const suggested = useMemo(
    () => targets.map((t) => ({ ...t, sms: composeSms(t.client, t.items) })),
    [targets.map((t) => `${t.client.id}:${t.items.map((i) => i.id).join(',')}`).join('|')],
  );

  const drafts = suggested.map((d) => ({ ...d, sms: edited[d.client.id] ?? d.sms }));

  const detail = (
    <>
      <ReviewSection title={`Message preview (SMS) — ${drafts.length} recipient${drafts.length === 1 ? '' : 's'}`}>
        <div className="flex flex-col gap-3">
          {drafts.map((d) => (
            <div key={d.client.id} className="bg-[#16161a] border border-white/5 rounded-2xl p-4 shadow-inner">
              <div className="flex items-center justify-between gap-3 mb-2.5">
                <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                  {d.client.contactName} · {d.client.mobile}
                </span>
                <Pill tone="blue">{d.items.length} items</Pill>
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

      <ReviewSection title="Items being chased">
        <div className="bg-[#16161a] border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-56 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

      <ReviewSection title="Policy">
        <ReviewRows
          rows={[
            { label: 'Channel', value: 'SMS only — no WhatsApp or email chases' },
            { label: 'Link security', value: 'Signed short-lived URL + OTP to registered mobile' },
            { label: 'Portal scope', value: 'Upload-only, limited to the requested items' },
            { label: 'Auto-reminders', value: '+3 days, then +7 days, then escalate' },
            { label: 'Suppression', value: 'Received · unavailable · dismissed · cash-coded' },
            { label: 'App required', value: <Pill tone="blue">No — OTP link</Pill> },
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
      title={only ? `Chase ${only.client.name}` : `Chase ${drafts.length} clients`}
      onEdit={() => setEditing((v) => !v)}
      editLabel={editing ? 'Done editing' : 'Edit message'}
      subtitle={`SMS to primary contacts • ${totalItems} missing item${totalItems === 1 ? '' : 's'}`}
      detail={detail}
      approveLabel="Approve & send"
      successMessage={`Chase sent to ${drafts.length} client${drafts.length === 1 ? '' : 's'} (${totalItems} items) via SMS.`}
      auditAction="Sent chase"
      auditScope={`${totalItems} items across ${drafts.map((d) => d.client.name).join(', ')}`}
      onApprove={() => {
        // The approved wording is what goes, not a freshly composed one.
        drafts.forEach((d) => sendChase(d.client.id, d.items.map((i) => i.id), d.sms));
      }}
    />
  );
}
