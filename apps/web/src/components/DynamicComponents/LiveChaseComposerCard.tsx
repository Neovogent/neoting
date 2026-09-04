import { useMemo, useState } from 'react';
import { Check, MessageSquareText } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { composeChaseBody, toE164 } from '../../lib/demoIntents';
import { isUnexplained } from '../../lib/matching';
import { currency } from '../../lib/resolver';
import { LiveProposalFlow } from './LiveProposalFlow';
import { ReviewSection } from './ReviewGate';

const m = defineMessages({
  title: { id: 'shell.liveChaseComposer.title', defaultMessage: 'Chase {client} by email' },
  subtitle: {
    id: 'shell.liveChaseComposer.subtitle',
    defaultMessage: 'One grouped message covering every missing receipt — the review shows it exactly as it will send.',
  },
  pickClient: { id: 'shell.liveChaseComposer.pickClient', defaultMessage: 'Which client is this chase for?' },
  itemsSection: { id: 'shell.liveChaseComposer.itemsSection', defaultMessage: 'Missing receipts to chase' },
  noItems: {
    id: 'shell.liveChaseComposer.noItems',
    defaultMessage: 'Nothing to chase — every unmatched transaction for this client is either suppressed or already has its paperwork.',
  },
  recipientLabel: { id: 'shell.liveChaseComposer.recipientLabel', defaultMessage: 'Recipient mobile (optional)' },
  // UK-first wording (5 Sep 2026 review): the audience is a UK practice, so
  // the example is a UK mobile in both shapes `toE164` accepts. Other
  // countries still work with their + prefix; a per-locale example is the
  // translator's to write, which is what the catalogue is for.
  recipientInvalid: {
    id: 'shell.liveChaseComposer.recipientInvalid',
    defaultMessage: 'Enter a UK mobile — 07700 900123 or +44 7700 900123 — or leave it blank.',
  },
  recipientOptionalNote: {
    id: 'shell.liveChaseComposer.recipientOptionalNote',
    defaultMessage:
      'Left blank, the chase goes to the registered primary contact by email. A mobile adds SMS once it is switched on for your practice.',
  },
  draftSection: { id: 'shell.liveChaseComposer.draftSection', defaultMessage: 'Draft message' },
  draftNote: {
    id: 'shell.liveChaseComposer.draftNote',
    defaultMessage: 'The portal link is minted when the message is composed server-side; this draft carries the portal address without a signed token.',
  },
  stage: { id: 'shell.liveChaseComposer.stage', defaultMessage: 'Stage for review' },
  // The statement-request half (5 Sep 2026 review finding: "ask Zeplow for
  // their bank statement" landed on this card, whose only ask was receipts —
  // a client with no bank data yet gave it nothing to stage and the button
  // was a dead end). Same engine (c) request BankView's dialog stages; the
  // body is composed server-side at creation like every chase.
  statementSection: { id: 'shell.liveChaseComposer.statementSection', defaultMessage: 'Or request a bank statement' },
  statementNote: {
    id: 'shell.liveChaseComposer.statementNote',
    defaultMessage:
      'Asks the client for one month’s statement — the email carries their secure upload link, and the message is composed at review.',
  },
  statementMonthLabel: { id: 'shell.liveChaseComposer.statementMonthLabel', defaultMessage: 'Statement month' },
  stageStatement: { id: 'shell.liveChaseComposer.stageStatement', defaultMessage: 'Stage statement request' },
});

/**
 * "Chase American Burger for the missing receipts" (METH Stage 13, utterance
 * 2) — the composer over REAL data: the candidate items are the unmatched,
 * non-suppressed transactions from the live bank slice (the same set
 * server-side detection reads), and staging creates a real `chase.send`
 * proposal whose review shows every SMS byte-for-byte. Approval executes
 * through the real engine into the SMS outbox.
 *
 * // DEMO-MOCK: composition belongs server-side at proposal time
 * // (`chase/sms-copy.ts` + `portal-link.ts` — the compose seam is the S8/S9
 * // flagged gap). Until it exists the draft mirrors the SoT §8.2 copy shape
 * // client-side, and the portal link in the body is tokenless — the outbox
 * // panel renders no tap target for it rather than a dead one.
 */
export function LiveChaseComposerCard({
  businessId,
  businessName,
}: {
  businessId?: string | undefined;
  businessName?: string | undefined;
}) {
  const { transactions, businesses, clients } = useAppContext();
  const intl = useIntl();

  const [chosenBusinessId, setChosenBusinessId] = useState<string | null>(businessId ?? null);
  const business = businesses.find((b) => b.id === chosenBusinessId) ?? null;
  const resolvedName = business?.name ?? businessName ?? null;

  // The composer must offer EXACTLY the set the server would chase — see
  // `isUnexplained`. Offering a SUGGESTED or EXCLUDED line here would put an
  // item in an approved chase message that the engine will never act on, which
  // the client then gets asked for and the accountant then has to explain.
  const candidates = useMemo(
    () => transactions.filter((t) => t.clientId === chosenBusinessId && isUnexplained(t)),
    [transactions, chosenBusinessId],
  );

  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const selected = candidates.filter((t) => !excluded.has(t.id));

  // Prefilled from the synthetic client record when one shares the name —
  // there is no /v1/contacts read surface yet — and always editable: the
  // number is part of what Read review shows, so the accountant owns it.
  // With no namesake it starts EMPTY: staging is disabled until a number is
  // typed, and an invented placeholder number a hurried approver could send
  // to is exactly the kind of fake data launch M8 removes.
  // // DEMO-MOCK: contact lookup once a contacts read surface exists.
  const [recipient, setRecipient] = useState(() => {
    const namesake = clients.find((c) => resolvedName !== null && c.name.toLowerCase() === resolvedName.toLowerCase());
    return namesake?.mobile ?? '';
  });
  const recipientE164 = toE164(recipient);

  // Last calendar month, the obvious default for "send me your statement".
  const [statementMonth, setStatementMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Engine (c): the body is a placeholder the compose seam DISCARDS — the
  // month, the working portal link and the primary recipient are all stamped
  // server-side at creation (`requestStatementProposal` in api/proposals.ts is
  // the same request; this builds it inline so LiveProposalFlow owns staging).
  const buildStatementRequest = (): CreateActionProposalRequest =>
    ({
      kind: 'chase.send',
      businessId: chosenBusinessId,
      payload: { messages: [{ statementPeriod: statementMonth, body: 'Composed at review.' }] },
    }) as CreateActionProposalRequest;

  const body =
    resolvedName === null
      ? ''
      : composeChaseBody(
          resolvedName,
          selected.map((t) => ({ supplier: t.description, amount: t.amount, date: t.date })),
          `${window.location.origin}/p/`,
        );

  // The mobile is OPTIONAL (5 Sep 2026 review finding: the card said "by
  // email" and then refused to stage without a mobile). Blank, the key is
  // OMITTED and the compose seam resolves the business's PRIMARY contact —
  // an email-only contact is a reachable recipient (#245), and the engine
  // stamps the registered mobile itself when one is on file. A typed value
  // must still be a real E.164 — a mangled number silently dropped would be
  // worse than a refusal.
  const buildRequest = (): CreateActionProposalRequest => ({
    kind: 'chase.send',
    businessId: chosenBusinessId,
    payload: {
      messages: [
        {
          ...(recipientE164 === null ? {} : { recipientE164 }),
          body,
          transactionIds: selected.map((t) => t.id),
        },
      ],
    },
  });

  return (
    <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner bg-raised text-white border-white/5">
          <MessageSquareText size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">
            {intl.formatMessage(m.title, { client: resolvedName ?? '…' })}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold">{intl.formatMessage(m.subtitle)}</p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {chosenBusinessId === null && (
          <div className="space-y-2">
            <p className="text-[13px] font-bold text-zinc-400">{intl.formatMessage(m.pickClient)}</p>
            <div className="flex flex-wrap gap-2">
              {businesses.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setChosenBusinessId(b.id)}
                  className="px-4 py-2 rounded-full text-[13px] font-semibold bg-raised text-zinc-300 border border-white/5 hover:border-white/20 transition-colors"
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {chosenBusinessId !== null && (
          <>
            <ReviewSection title={intl.formatMessage(m.itemsSection)}>
              {candidates.length === 0 ? (
                <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.noItems)}</p>
              ) : (
                <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
                  {candidates.map((t) => {
                    const on = !excluded.has(t.id);
                    return (
                      <button
                        key={t.id}
                        role="checkbox"
                        aria-checked={on}
                        onClick={() =>
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(t.id);
                            else next.delete(t.id);
                            return next;
                          })
                        }
                        className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-white/5 transition-colors"
                      >
                        <span
                          className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                            on ? 'bg-brand border-brand text-white' : 'border-white/20 text-transparent'
                          }`}
                        >
                          <Check size={13} strokeWidth={3} />
                        </span>
                        <span className="text-[13px] text-zinc-300 truncate min-w-0">{t.description}</span>
                        <span className="ml-auto text-[13px] text-white font-bold tabular-nums shrink-0">{currency(t.amount)}</span>
                        <span className="text-[12px] text-zinc-500 shrink-0">{t.date}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </ReviewSection>

            <div className="space-y-2">
              <label htmlFor="chase-recipient" className="text-[13px] font-bold text-zinc-400 block">
                {intl.formatMessage(m.recipientLabel)}
              </label>
              <input
                id="chase-recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="w-full max-w-xs bg-raised border border-white/10 rounded-2xl px-4 py-2.5 text-[14px] text-white focus:outline-none focus:border-brand"
              />
              {recipient.trim() !== '' && recipientE164 === null && (
                <p className="text-[12px] text-amber-400">{intl.formatMessage(m.recipientInvalid)}</p>
              )}
              <p className="text-[12px] text-zinc-500">{intl.formatMessage(m.recipientOptionalNote)}</p>
            </div>

            {selected.length > 0 && (
              <ReviewSection title={intl.formatMessage(m.draftSection)}>
                <div className="bg-card border border-white/5 rounded-2xl p-4 shadow-inner">
                  <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words">{body}</p>
                </div>
                <p className="text-[12px] text-zinc-500 mt-2">{intl.formatMessage(m.draftNote)}</p>
              </ReviewSection>
            )}

            <LiveProposalFlow
              buildRequest={buildRequest}
              clientName={resolvedName}
              stageLabel={intl.formatMessage(m.stage)}
              // Blank is fine (the engine resolves the registered contact);
              // only a TYPED value that is not a real number blocks staging.
              disabled={selected.length === 0 || (recipient.trim() !== '' && recipientE164 === null)}
            />

            {/* The statement-request half — its own flow, staged independently
                of the receipts above, because a client with NO bank data yet
                (the 5 Sep 2026 review case) has nothing unmatched to chase and
                a statement is exactly what is being asked for. */}
            <ReviewSection title={intl.formatMessage(m.statementSection)}>
              <p className="text-[12px] text-zinc-500 mb-3">{intl.formatMessage(m.statementNote)}</p>
              <label htmlFor="chase-statement-month" className="text-[13px] font-bold text-zinc-400 block mb-2">
                {intl.formatMessage(m.statementMonthLabel)}
              </label>
              <input
                id="chase-statement-month"
                type="month"
                value={statementMonth}
                onChange={(e) => setStatementMonth(e.target.value)}
                className="w-full max-w-xs bg-raised border border-white/10 rounded-2xl px-4 py-2.5 text-[14px] text-white focus:outline-none focus:border-brand mb-4"
              />
              <LiveProposalFlow
                buildRequest={buildStatementRequest}
                clientName={resolvedName}
                stageLabel={intl.formatMessage(m.stageStatement)}
                disabled={!/^\d{4}-\d{2}$/.test(statementMonth)}
              />
            </ReviewSection>
          </>
        )}
      </div>
    </div>
  );
}
