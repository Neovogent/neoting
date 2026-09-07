import { lazy, Suspense, useState } from 'react';
import { Users, Wand2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { mapTurnToPayload, requestChatTurn, SERVER_INTENT_TO_APP } from '../../api/chat';
import { useAppContext } from '../../context/AppContext';
import type { Intent } from '../../lib/types';

/**
 * The two affordances review item 51 asks for, and the re-ask they share.
 *
 * ⚠ **One picker, not two.** `ChatClientPicker` was built for uploads held
 * pending a client answer; the note is explicit that the rule flow reuses it
 * rather than minting a second. It is `lazy()` here for the reason it is lazy
 * there — the chat surface is floor-adjacent and this dialog carries a Modal
 * frame.
 *
 * ## What these cards do, and what they deliberately do not
 *
 * They re-ask the assistant. That is all. Neither one creates a rule, drafts a
 * payload or stages anything: the answer comes back as an ordinary turn and, if
 * it carries a rule, `LiveRuleCard` renders it with the same explicit-click
 * staging → Review → Approve it has always had (item 51 §3's confirmation step,
 * which already existed and is unchanged).
 *
 * The never-guess rule is why this is a PICKER and not a resolver. Even when
 * the accountant named the client in the sentence, the client is chosen by
 * name, by a human — a coding rule aimed at the wrong client's books is
 * invisible until a return is wrong.
 */

const ChatClientPicker = lazy(() => import('../ChatClientPicker'));

const m = defineMessages({
  // ── The client picker (item 51 §2) ─────────────────────────────────────
  pickHeading: { id: 'shell.chatRule.pickHeading', defaultMessage: 'Which client is this rule for?' },
  pickAction: { id: 'shell.chatRule.pickAction', defaultMessage: 'Choose a client' },
  pickDetail: {
    id: 'shell.chatRule.pickDetail',
    defaultMessage: 'Rules live inside one client workspace. Nothing is created until you pick one and approve it.',
  },
  pickerDetail: {
    id: 'shell.chatRule.pickerDetail',
    defaultMessage:
      'A coding rule is checked against this client’s own chart of accounts, so it has to be one client. Nothing is created by choosing.',
  },
  asking: { id: 'shell.chatRule.asking', defaultMessage: 'Asking…' },
  // ── The offer (item 51 §1) ─────────────────────────────────────────────
  offerHeading: { id: 'shell.chatRule.offerHeading', defaultMessage: 'Draft a coding rule instead?' },
  offerDetail: {
    id: 'shell.chatRule.offerDetail',
    defaultMessage:
      'A coding rule cannot release anything — it pre-codes a supplier so the next document arrives ready. Name the supplier and what it should be coded to.',
  },
  offerYes: { id: 'shell.chatRule.offerYes', defaultMessage: 'Yes — draft it' },
  offerNo: { id: 'shell.chatRule.offerNo', defaultMessage: 'No thanks' },
  offerDeclined: { id: 'shell.chatRule.offerDeclined', defaultMessage: 'Left as it is.' },
  supplierLabel: { id: 'shell.chatRule.supplierLabel', defaultMessage: 'Supplier' },
  supplierPlaceholder: { id: 'shell.chatRule.supplierPlaceholder', defaultMessage: 'e.g. Bidfood' },
  categoryLabel: { id: 'shell.chatRule.categoryLabel', defaultMessage: 'Code it to' },
  categoryPlaceholder: { id: 'shell.chatRule.categoryPlaceholder', defaultMessage: 'e.g. Cost of sales' },
  categoryHint: {
    id: 'shell.chatRule.categoryHint',
    defaultMessage:
      'Checked against this client’s own chart of accounts. If it is not on it you get the list back, never the nearest guess.',
  },
  draftAction: { id: 'shell.chatRule.draftAction', defaultMessage: 'Draft the rule' },
});

/**
 * Re-ask the assistant, scoped, and append whatever comes back.
 *
 * `InputRow` owns the composer's own path; this is the same three calls
 * (`requestChatTurn` → `SERVER_INTENT_TO_APP` → `mapTurnToPayload`) for a turn
 * a CARD started rather than a keystroke. Extracting the composer's version to
 * share would mean pulling its scope resolution, its attachment handling and
 * its synthetic branch along with it, which is more than this needs.
 */
function useReask() {
  const { addMessage, businesses, messages, setAssistantPending } = useAppContext();
  const [asking, setAsking] = useState(false);

  const ask = async (utterance: string, businessId?: string) => {
    setAsking(true);
    setAssistantPending({ businessName: businesses.find((b) => b.id === businessId)?.name ?? null });
    try {
      addMessage({ id: `msg-${Date.now()}`, role: 'user', content: utterance });
      const turn = await requestChatTurn({
        utterance,
        ...(businessId === undefined ? {} : { businessId }),
        history: messages.slice(-10).map((msg) => ({ role: msg.role, content: msg.content })),
      });
      if (turn.kind === 'failure') {
        // §9.3's floor: say what happened. Never a locally-produced answer
        // wearing the assistant's voice.
        addMessage({
          id: `msg-${Date.now() + 1}`,
          role: 'assistant',
          content: turn.retryable ? `${turn.message} Try that again in a moment.` : turn.message,
          intent: 'GENERAL',
        });
        return;
      }
      addMessage({
        id: `msg-${Date.now() + 1}`,
        role: 'assistant',
        content: turn.reply,
        intent: SERVER_INTENT_TO_APP[turn.intent] as Intent,
        payload: mapTurnToPayload(turn, businesses, utterance),
      });
    } finally {
      setAssistantPending(null);
      setAsking(false);
    }
  };

  return { ask, asking };
}

/**
 * **Item 51 §2** — the in-chat client picker, where the reply used to be
 * *"Pick a client first"* with nothing to press.
 *
 * The utterance is re-sent VERBATIM with the chosen client attached, so the
 * assistant reads the accountant's own sentence rather than a paraphrase this
 * card would have had to invent.
 */
export function ChatRuleClientCard({ query }: { query: string }) {
  const intl = useIntl();
  /**
   * ⚠ `businesses`, NOT `clients`. With the API on, `AppContext.clients` is the
   * SYNTHETIC cast and is empty (launch M2 — nothing degrades to seeds), so the
   * first version of this card opened a picker with no clients in it. The live
   * list is `businesses`, and its ids are already server ids, so no
   * `serverClientIdFor` bridge is needed either.
   */
  const { businesses } = useAppContext();
  const { ask, asking } = useReask();
  const [open, setOpen] = useState(false);

  if (asking) return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.asking)}</p>;

  return (
    <div className="w-full border border-white/5 rounded-[28px] bg-card shadow-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] font-bold text-zinc-500 uppercase tracking-widest">
        <Users size={14} />
        {intl.formatMessage(m.pickHeading)}
      </div>
      <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.pickDetail)}</p>
      <button
        onClick={() => setOpen(true)}
        className="self-start px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
      >
        {intl.formatMessage(m.pickAction)}
      </button>

      {open && (
        <Suspense fallback={null}>
          <ChatClientPicker
            clients={businesses}
            fileCount={0}
            title={intl.formatMessage(m.pickHeading)}
            detail={intl.formatMessage(m.pickerDetail)}
            onCancel={() => setOpen(false)}
            onPick={(businessId) => {
              setOpen(false);
              void ask(query, businessId);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * **Item 51 §1** — the offer, with a button behind it.
 *
 * The refusal it follows is correct and untouched: auto-publish and
 * auto-approve are exactly what Governance §10 and D44 forbid. What was missing
 * is the way to take the alternative the assistant itself named.
 *
 * ⚠ **The category is a plain field, checked by the SERVER.** It is not a
 * select over a chart this card fetched, because there is no browser-side copy
 * of a client's chart and building one would be a second answer to a question
 * `drafts.ts` already answers correctly — an off-chart name comes back as a
 * refusal listing the real categories, which is more useful than a dropdown
 * and cannot drift from what the rule will actually be checked against.
 */
export function ChatRuleOfferCard({ businessName }: { businessName?: string | undefined }) {
  const intl = useIntl();
  const { ask, asking } = useReask();
  const [phase, setPhase] = useState<'offered' | 'form' | 'declined'>('offered');
  const [supplier, setSupplier] = useState('');
  const [category, setCategory] = useState('');

  if (asking) return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.asking)}</p>;
  if (phase === 'declined') return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.offerDeclined)}</p>;

  return (
    <div className="w-full border border-white/5 rounded-[28px] bg-card shadow-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] font-bold text-zinc-500 uppercase tracking-widest">
        <Wand2 size={14} />
        {intl.formatMessage(m.offerHeading)}
      </div>
      <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.offerDetail)}</p>

      {phase === 'offered' ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPhase('form')}
            className="px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
          >
            {intl.formatMessage(m.offerYes)}
          </button>
          <button
            onClick={() => setPhase('declined')}
            className="px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            {intl.formatMessage(m.offerNo)}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(m.supplierLabel)}
              </span>
              <input
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                placeholder={intl.formatMessage(m.supplierPlaceholder)}
                className="bg-ground border border-white/5 rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(m.categoryLabel)}
              </span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder={intl.formatMessage(m.categoryPlaceholder)}
                className="bg-ground border border-white/5 rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand"
              />
            </label>
          </div>
          <p className="text-[11.5px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.categoryHint)}</p>
          <button
            onClick={() =>
              void ask(
                // The assistant's own vocabulary, so this enters the ordinary
                // LIVE_RULE beat rather than a private path. The client is NOT
                // named in the words — the scope carries it, and the turn will
                // ask for one through `awaiting: 'client'` if there is none.
                `Whenever ${supplier.trim()} documents arrive, code them ${category.trim()}.`,
              )
            }
            disabled={supplier.trim() === '' || category.trim() === ''}
            className="self-start px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
          >
            {intl.formatMessage(m.draftAction, { client: businessName ?? '' })}
          </button>
        </div>
      )}
    </div>
  );
}
