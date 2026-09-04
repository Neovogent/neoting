import { useMemo, useState } from 'react';
import { ArrowRight, Ban, Download, ShieldCheck, UploadCloud } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { commonActions } from '../../i18n/common';
import type { Document } from '../../lib/types';
import { LiveProposalFlow } from './LiveProposalFlow';
import { ReviewSection } from './ReviewGate';
import { Modal } from './Modal';
import { Pill } from './DataTable';

/**
 * **The publish action the document lists were missing.**
 *
 * Live (`documentsSource === 'api'`), ClientInbox's bulk bar and InboxesView's
 * bulk bar and header button had no reachable way to release anything: the METH
 * S14 sweep hid or disabled every local publish writer — correctly, because a
 * local flip is reverted by the next poll — and pointed at a chat utterance
 * instead. Published is the gate to Export (`ExportView` exports only documents
 * that reached Published, D42/D43), so with no reachable publish action the
 * accountant could never produce the VT import file: the visible endpoint of
 * the whole product was unreachable from the screen they were standing on.
 *
 * This dialog is the missing door, and it is deliberately **not** a publish
 * button. It stages a real `publish.batch` `ActionProposal` and hands it to
 * `LiveProposalCard`, which is the server's own Review → Approve card:
 *
 *   select Ready documents → stage the batch → [Read review] (`POST …/review`,
 *   rendering exactly the server's sections) → Approve, echoing the review's
 *   `renderedSummaryHash` → Published → the Export screen → the VT import file.
 *
 * Four rules it exists to keep, none of which may be relaxed here:
 *
 * - **Review → Approve is untouchable.** Nothing in this file writes state.
 *   `LiveProposalFlow` performs only the CREATE call; the review and the
 *   approval are the card's moves, made by a person, and Approve cannot mount
 *   before the server's review is on screen (enforced server-side and again by
 *   a database trigger — the UI gate is a mirror, never the enforcement).
 * - **Only Ready documents can publish.** A selection with nothing Ready is
 *   refused by name and by count, the wording mirroring the chat InboxTable's
 *   (`shell.inboxTable.nothingToPublish*` in `Tables.tsx`) so the same refusal
 *   reads the same wherever it is met. Offering to publish an already-Published
 *   document tells an accountant their books are in a state they are not.
 * - **D42 vocabulary.** *Published* means approved and released for export and
 *   nothing more. No string here says or implies posted, synced, or sent
 *   anywhere — the sanctioned phrasings are "Publish" / "Release for export",
 *   and the pointer at the end names the Export screen, which is where the VT
 *   import file is actually built.
 * - **D44, two authorities.** Composing and staging is every member's; only
 *   the practice's super admin may release. The server is the rule
 *   (`assertCan(actor, 'publish.release', …)` → `NT-PRM-001` on the APPROVE
 *   call, never on create), so the action is never hidden — the note says who
 *   releases, says it more plainly when this session's role is not the release
 *   role, and a refusal arrives on the card with its own code rather than as an
 *   opaque 403. `/me` carries no `is_owner`, so this screen can never claim the
 *   permission IS held; it only ever says who holds it.
 *
 * Lazy on purpose (`ClientInbox` is embedded in `ClientDetailView`, the worst
 * route in the bundle) — keep every string and every proposal import in here.
 */

const m = defineMessages({
  dialogLabel: { id: 'publish.batchDialog.dialogLabel', defaultMessage: 'Release documents for export' },

  // ── the honest refusal ──────────────────────────────────────────────────
  nothingTitle: { id: 'publish.batchDialog.nothingTitle', defaultMessage: 'Nothing selected can publish' },
  // Mirrors `shell.inboxTable.nothingToPublishDetail` — the same refusal, met
  // on a different surface, has to read the same.
  nothingDetail: {
    id: 'publish.batchDialog.nothingDetail',
    defaultMessage:
      '{publishedCount, plural, =0 {} one {# is already Published — approved and released for export. } other {# are already Published — approved and released for export. }}{otherCount, plural, =0 {} one {# must reach Ready before it can publish.} other {# must reach Ready before they can publish.}}',
  },
  nothingPublishedNames: {
    id: 'publish.batchDialog.nothingPublishedNames',
    defaultMessage: 'Already Published: {suppliers}',
  },
  nothingNotReadyNames: {
    id: 'publish.batchDialog.nothingNotReadyNames',
    defaultMessage: 'Not Ready yet: {suppliers}',
  },
  nothingNext: {
    id: 'publish.batchDialog.nothingNext',
    defaultMessage:
      'Open a document to fill in what it is missing — the correction goes through Review → Approve, and it reaches Ready when Supplier, Total and Category are all answered.',
  },

  // ── the batch ───────────────────────────────────────────────────────────
  title: {
    id: 'publish.batchDialog.title',
    defaultMessage: '{count, plural, one {Release # item for export} other {Release # items for export}}',
  },
  subtitle: { id: 'publish.batchDialog.subtitle', defaultMessage: '{client} · Ready costs and sales' },
  // ⚠ D42, stated on the surface that stages the release rather than only on
  // the one that consumes it. This dialog is where a person decides to make
  // something Published, so it is where the word has to be defined; the export
  // screen carries the same sentence for the same reason.
  meaning: {
    id: 'publish.batchDialog.meaning',
    defaultMessage:
      'Published is an internal state meaning approved and released for export. Nothing leaves Neo Accounting on its own.',
  },
  batchProgress: {
    id: 'publish.batchDialog.batchProgress',
    defaultMessage: 'Client {position} of {total} — one batch per client, because a release names one client.',
  },
  itemsSection: { id: 'publish.batchDialog.itemsSection', defaultMessage: 'Batch' },
  itemRow: { id: 'publish.batchDialog.itemRow', defaultMessage: '{supplier} · {category}' },
  draftTotal: { id: 'publish.batchDialog.draftTotal', defaultMessage: 'Draft gross (display only)' },
  mixedCurrencyNoTotal: {
    id: 'publish.batchDialog.mixedCurrencyNoTotal',
    defaultMessage: 'These documents are in more than one currency, so there is no single gross to show.',
  },
  serverNote: {
    id: 'publish.batchDialog.serverNote',
    defaultMessage:
      'Read review renders the item count, gross and VAT the SERVER computed at proposal time — never these draft figures.',
  },
  lockPill: { id: 'publish.batchDialog.lockPill', defaultMessage: 'Releasing locks and archives each item' },
  heldBack: {
    id: 'publish.batchDialog.heldBack',
    defaultMessage:
      '{count, plural, one {# Ready item is held back} other {# Ready items are held back}} — the publish minimum (Supplier + Total + Category) is not met, and the server refuses half-coded books.',
  },
  nothingEligible: {
    id: 'publish.batchDialog.nothingEligible',
    defaultMessage:
      'Nothing in this batch meets the publish minimum (Supplier + Total + Category), so there is nothing to stage.',
  },
  leftAlone: {
    id: 'publish.batchDialog.leftAlone',
    defaultMessage:
      '{count, plural, one {# of the selected is not Ready and was left out} other {# of the selected are not Ready and were left out}}.',
  },
  stage: { id: 'publish.batchDialog.stage', defaultMessage: 'Stage for review' },

  // ── D44 ─────────────────────────────────────────────────────────────────
  authority: {
    id: 'publish.batchDialog.authority',
    defaultMessage:
      'Anyone in the practice can stage a release; only your practice’s super admin can approve one. The server decides, not this screen.',
  },
  authorityNotYours: {
    id: 'publish.batchDialog.authorityNotYours',
    defaultMessage:
      'Your role does not release. Staging this queues it in Approvals for your practice’s super admin, and nothing is Published until they approve it.',
  },

  // ── where the VT file comes from ────────────────────────────────────────
  // ⚠ This block appears once the batch has been DECIDED, and the card above
  // it — not this copy — says which way. `LiveProposalCard` fires its settle
  // callback on approve AND on cancel, so a sentence here claiming a release
  // would announce a publish that a cancel had just prevented. Every word
  // below is therefore true either way: it says where the file is built, never
  // what has happened.
  exportTitle: {
    id: 'publish.batchDialog.exportTitle',
    defaultMessage: 'Where the VT import file comes from',
  },
  exportDetail: {
    id: 'publish.batchDialog.exportDetail',
    defaultMessage:
      'An approved batch leaves its documents Published — approved and released for export. The file itself is built on the Export screen: pick {client} and the period, and download it there. Nothing leaves Neo Accounting on its own.',
  },
  openExport: { id: 'publish.batchDialog.openExport', defaultMessage: 'Open the Export screen' },
  nextBatch: { id: 'publish.batchDialog.nextBatch', defaultMessage: 'Next client ({remaining} left)' },
});

/**
 * A courtesy mirror of the SERVER's publish minimum (`NT-PUB-001` refuses the
 * whole batch when one item is short of it). Identical to `LivePublishCard`'s,
 * deliberately: a live row carries `fields: []`, so `readinessOf` — which
 * counts extracted fields — reads every server document as un-coded. The server
 * remains the judge; this only stops a batch being staged that it would refuse.
 */
function meetsPublishMinimum(d: Document): boolean {
  return d.supplier !== '' && d.supplier !== 'Unknown' && d.category !== '—' && d.category.trim() !== '';
}

/** The first few names, so a refusal or a hold-back is about documents, not counts. */
function names(docs: Document[]): string {
  return docs.slice(0, 4).map((d) => d.supplier).join(', ');
}

export interface PublishBatchDialogProps {
  /** Exactly what the user selected — refusals are computed here, not by the caller. */
  selection: Document[];
  onClose: () => void;
  /** Fired after an approve or cancel lands server-side — the refetch seam. */
  onSettled?: () => void;
}

export default function PublishBatchDialog({ selection, onClose, onSettled }: PublishBatchDialogProps) {
  const intl = useIntl();
  const { session, clientNameFor, setActiveTab } = useAppContext();
  const [index, setIndex] = useState(0);
  /** The batch has been approved OR cancelled — the card above says which. */
  const [decided, setDecided] = useState(false);

  /**
   * One `publish.batch` per client, because the proposal names ONE business.
   * A selection spanning two clients is two releases, walked one at a time —
   * the `document.route` idiom InboxesView already uses for bulk Move.
   */
  const { batches, publishedDocs, notReadyDocs } = useMemo(() => {
    const ready = selection.filter((d) => d.status === 'ready');
    const grouped = new Map<string, Document[]>();
    ready.forEach((d) => grouped.set(d.clientId, [...(grouped.get(d.clientId) ?? []), d]));
    return {
      batches: [...grouped.entries()].map(([businessId, docs]) => ({ businessId, docs })),
      publishedDocs: selection.filter((d) => d.status === 'published'),
      notReadyDocs: selection.filter((d) => d.status !== 'ready' && d.status !== 'published'),
    };
  }, [selection]);

  const batch = batches[index];

  // D44: what this session's role can be said about. `/me` carries the role and
  // NOT `memberships.is_owner`, so a PRACTICE_ADMIN may still be refused — the
  // note therefore never promises the permission, it only names who holds it.
  const role = session.status === 'authenticated' ? session.me.role : null;
  const roleCannotRelease = role !== null && role !== 'PRACTICE_ADMIN';

  const goToExport = () => {
    onClose();
    setActiveTab('Export');
  };

  /* ── nothing Ready: the honest refusal, by count and by name ───────────── */
  if (!batch) {
    return (
      <Modal onClose={onClose} label={intl.formatMessage(m.nothingTitle)}>
        <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
          <div className="p-6 flex items-start gap-4 border-b border-white/5">
            <span className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border bg-amber-400/10 border-amber-400/25 text-amber-400">
              <Ban size={20} />
            </span>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-xl text-white tracking-tight">
                {intl.formatMessage(m.nothingTitle)}
              </h3>
              <p role="alert" className="text-[13px] text-zinc-400 mt-1.5 leading-relaxed">
                {intl.formatMessage(m.nothingDetail, {
                  publishedCount: publishedDocs.length,
                  otherCount: notReadyDocs.length,
                })}
              </p>
            </div>
          </div>
          <div className="p-6 flex flex-col gap-2">
            {publishedDocs.length > 0 && (
              <p className="text-[12.5px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.nothingPublishedNames, { suppliers: names(publishedDocs) })}
              </p>
            )}
            {notReadyDocs.length > 0 && (
              <p className="text-[12.5px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.nothingNotReadyNames, { suppliers: names(notReadyDocs) })}
              </p>
            )}
            <p className="text-[12.5px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.nothingNext)}</p>
          </div>
          <div className="p-4 bg-raised/50 flex justify-end">
            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
            >
              {intl.formatMessage(commonActions.close)}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const clientName = clientNameFor(batch.businessId);
  const eligible = batch.docs.filter(meetsPublishMinimum);
  const held = batch.docs.length - eligible.length;
  /**
   * ⚠ A batch total exists ONLY when every document shares one currency.
   *
   * Summing `d.total` across currencies produces a number that is not money in
   * any of them, and rendering it with a £ made a USD invoice foot into a
   * sterling figure on the surface where a human decides to release. Where the
   * batch is mixed, no total is shown and the per-line amounts (each carrying
   * its own symbol) stand alone — an absent total is honest, a wrong one is
   * not. This is display tier either way: Read review renders the ENGINE's own
   * computed totals, which is the figure the approval actually stands on.
   */
  const currencies = new Set(eligible.map((d) => d.currency));
  const draftCurrency = currencies.size === 1 ? [...currencies][0] : null;
  const draftGross = draftCurrency === null ? null : eligible.reduce((sum, d) => sum + d.total, 0);
  const remaining = batches.length - index - 1;

  /**
   * Built on the click, never during render (`LiveProposalFlow`'s contract).
   * The placeholder preview is the shape's requirement; the ENGINE recomputes
   * and stores its own at creation, and Read review renders that one (METH S10)
   * — which is why no figure a human approves is ever one composed here.
   */
  const buildRequest = (): CreateActionProposalRequest => ({
    kind: 'publish.batch',
    businessId: batch.businessId,
    payload: {
      documentIds: eligible.map((d) => d.id),
      integrationId: null,
      preview: { itemCount: eligible.length, grossPence: 0, vatPence: 0 },
    },
  });

  return (
    <Modal onClose={onClose} label={intl.formatMessage(m.dialogLabel)}>
      <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
        <div className="p-6 flex items-center gap-4 border-b border-white/5">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner bg-raised text-white border-white/5">
            <UploadCloud size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">
              {intl.formatMessage(m.title, { count: eligible.length })}
            </h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold">
              {intl.formatMessage(m.subtitle, { client: clientName })}
            </p>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.meaning)}</p>

          {batches.length > 1 && (
            <p className="text-[12px] text-zinc-500">
              {intl.formatMessage(m.batchProgress, { position: index + 1, total: batches.length })}
            </p>
          )}

          <ReviewSection title={intl.formatMessage(m.itemsSection)}>
            {eligible.length === 0 ? (
              <p className="text-[13px] text-amber-400">{intl.formatMessage(m.nothingEligible)}</p>
            ) : (
              <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-52 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {eligible.map((d) => (
                  <div key={d.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-zinc-400 truncate">
                      {intl.formatMessage(m.itemRow, { supplier: d.supplier, category: d.category })}
                    </span>
                    <span className="text-white font-bold shrink-0 tabular-nums">{currency(d.total, d.currency)}</span>
                  </div>
                ))}
              </div>
            )}
            {held > 0 && <p className="text-[12px] text-amber-400 mt-2">{intl.formatMessage(m.heldBack, { count: held })}</p>}
            {eligible.length > 0 && draftGross !== null && draftCurrency !== null && (
              <div className="mt-2 flex items-center justify-between text-[13px]">
                <span className="text-zinc-500">{intl.formatMessage(m.draftTotal)}</span>
                <span className="text-white font-bold tabular-nums">{currency(draftGross, draftCurrency)}</span>
              </div>
            )}
            {eligible.length > 0 && draftGross === null && (
              <p className="mt-2 text-[12px] text-zinc-500">{intl.formatMessage(m.mixedCurrencyNoTotal)}</p>
            )}
          </ReviewSection>

          {publishedDocs.length + notReadyDocs.length > 0 && (
            <p className="text-[12px] text-zinc-500">
              {intl.formatMessage(m.leftAlone, { count: publishedDocs.length + notReadyDocs.length })}
            </p>
          )}

          <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.serverNote)}</p>

          <div className="flex flex-wrap gap-2">
            <Pill>{intl.formatMessage(m.lockPill)}</Pill>
          </div>

          {/* D44, never a hidden button: the note says who releases, and says it
              plainly when this session's role is not the release role. */}
          <p className="text-[12px] text-zinc-500 leading-relaxed flex items-start gap-2">
            <ShieldCheck size={14} className="shrink-0 mt-0.5" />
            <span className="min-w-0">
              {intl.formatMessage(roleCannotRelease ? m.authorityNotYours : m.authority)}
            </span>
          </p>

          {/* Stays mounted after the decision: its own banner — "Approved and
              executed" or "Cancelled — nothing was changed" — is the only
              thing on this surface that says what happened. */}
          <LiveProposalFlow
            // A new client is a new proposal: remount so the staged card of
            // the previous batch cannot be mistaken for this one's.
            key={batch.businessId}
            buildRequest={buildRequest}
            clientName={clientName}
            stageLabel={intl.formatMessage(m.stage)}
            disabled={eligible.length === 0}
            onExecuted={() => {
              setDecided(true);
              onSettled?.();
            }}
          />

          {decided && (
            <div className="flex flex-col gap-3 border border-white/10 bg-raised/40 rounded-[24px] p-5">
              <p className="text-sm font-bold text-white">{intl.formatMessage(m.exportTitle)}</p>
              <p className="text-[12.5px] text-zinc-400 leading-relaxed">
                {intl.formatMessage(m.exportDetail, { client: clientName })}
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={goToExport}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-brand-on bg-brand hover:bg-brand-hover rounded-full transition-colors"
                >
                  <Download size={16} />
                  {intl.formatMessage(m.openExport)}
                </button>
                {remaining > 0 && (
                  <button
                    onClick={() => {
                      setDecided(false);
                      setIndex((i) => i + 1);
                    }}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white border border-white/10 rounded-full transition-colors"
                  >
                    {intl.formatMessage(m.nextBatch, { remaining })}
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
