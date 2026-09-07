import { lazy, Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { TRASH_RETENTION_DAYS } from '@neoting/contracts';
import { applyToEach, refreshTrash, restoreDocument, useDeletedDocuments } from '../api/document-lifecycle';
import { holdsReleaseAuthority } from '../api/auth';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { useAppContext } from '../context/AppContext';
import { commonLabels } from '../i18n/common';
import { currency } from '../lib/resolver';
import type { Document } from '../lib/types';

/** Permanent delete's Review → Approve card — the same one the Documents screen uses. */
const PurgeDocumentsDialog = lazy(() => import('../components/DynamicComponents/PurgeDocumentsDialog'));

const m = defineMessages({
  /* ── The retention policy, said out loud (review item 61) ────────────────
     > "If there's a trash button then there should be a trash tab in the
     >  settings to see the trash, and how will the trash hold the file?
     >  Clear that out"

     ⚠ TWO CLAUSES, ALWAYS. The window is real and enforced
     (`scripts/purge-expired-trash.ts`), and it does not apply to a document
     an export still links to — D43 refuses that purge forever, to anybody,
     including the super admin. A surface that printed only the first clause
     would be promising a deletion the product will not perform. Both halves
     or neither; `docs/Retention_and_Deletion_Policy.md` is the source. */
  policy: {
    id: 'clients.clientTrash.policy',
    defaultMessage:
      'Deleted documents are held here for {days} days and then deleted for good. Anything already exported is held indefinitely instead — deleting it would break the link from an exported line back to its source.',
  },
  empty: {
    id: 'clients.clientTrash.empty',
    defaultMessage:
      '{client}’s Trash is empty. A document you delete from their Costs, Sales or Documents tab lands here, keeps everything read from it, and can be restored until it is deleted for good.',
  },
  /**
   * The footer's second sentence, and the walkthrough is why it exists: a
   * document is restored one row at a time from HERE, and the register it goes
   * back to is one sub-tab away. Without it, an accountant who has just
   * restored a removed client and found seventeen rows waiting has to guess
   * where they land.
   */
  footerRegister: {
    id: 'clients.clientTrash.footerRegister',
    defaultMessage: 'Restoring one puts it back on the Register, in the state it left.',
  },
  loading: { id: 'clients.clientTrash.loading', defaultMessage: 'Loading the Trash…' },
  loadError: { id: 'clients.clientTrash.loadError', defaultMessage: 'The Trash could not be loaded — {error}' },
  footer: {
    id: 'clients.clientTrash.footer',
    defaultMessage:
      '{count, plural, one {# document in Trash} other {# documents in Trash}} — restorable for {days} days from the day each was deleted',
  },
  deletedOn: { id: 'clients.clientTrash.deletedOn', defaultMessage: 'Deleted' },
  restore: { id: 'clients.clientTrash.restore', defaultMessage: 'Restore' },
  restoreFailed: { id: 'clients.clientTrash.restoreFailed', defaultMessage: 'That could not be restored — {error}' },
  purge: { id: 'clients.clientTrash.purge', defaultMessage: 'Delete permanently' },
  /**
   * The permission-gated half. A standard user sees the button and is told
   * whose signature it needs, rather than finding out after typing a reason —
   * `document.purge` is tier 1 (`assert-can.ts`), and item 39's rule is that a
   * surface must not offer an action it knows the viewer cannot finish.
   */
  purgeHint: {
    id: 'clients.clientTrash.purgeHint',
    defaultMessage: 'Only your practice’s super admin can approve deleting documents for good.',
  },
  syntheticNote: {
    id: 'clients.clientTrash.syntheticNote',
    defaultMessage: 'The Trash is a live surface — it appears when this workspace is reading from the server.',
  },
});

/**
 * **One client's Trash — review item 61's reachability half.**
 *
 * > *"If there's a trash button then there should be a trash tab in the
 * > settings to see the trash"*
 *
 * A Trash already existed on the practice-wide **Documents** screen (2 Sep
 * 2026). What did not exist was any way to reach it from where things are
 * actually thrown away: the bulk bar on a client's Costs tab says *Move to
 * Trash*, the row vanishes, and the client's own screens offered no destination
 * at all. Item 35's rule, one surface over — **the affordance and the list
 * belong together.**
 *
 * ## Why the client's Documents tab and not their Settings tab
 *
 * Mubashir suggested Settings, and the notes sanction either. The register won
 * on one argument: **a deleted document is still a document**, and the
 * Documents tab is this client's register — the same rows, the same columns,
 * one sub-tab apart. Settings is where a workspace is configured, and a list of
 * a client's paperwork sitting under it would be the second place in the
 * product that answers "what documents does this client have", free to disagree
 * with the first. The Move-to-Trash confirmation on the Costs tab names this
 * destination in as many words, so the path is stated rather than discovered.
 *
 * ## What it reuses, and what it therefore cannot get wrong
 *
 * Every operation here already existed and is untouched: `GET
 * /documents?deleted=true&businessId=…` (the two filters compose — the
 * contract's own words), `POST …/restoration`, and the `document.purge`
 * proposal through the same `PurgeDocumentsDialog` the Documents screen opens.
 * There is no second client-side rule about what may be purged, and there must
 * never be one: the server refuses a published document, one with a `publishes`
 * row, one with a `document_links` row and one a statement names, with
 * `NT-DOC-002` and its own sentence, which is what this screen renders.
 *
 * ## ⚠ It lives in its own lazy chunk on purpose
 *
 * `ClientDetailView` is the tightest route in the product. This component, its
 * copy, `document-lifecycle.ts` and the purge dialog all land HERE rather than
 * on that route's opening download — the same arrangement `ClientInbox` and
 * `BankView` already have, and the reason `document-lifecycle.ts`'s own header
 * insists it stays off the floor.
 */
export function ClientTrashPanel({ client }: { client: { id: string; name: string } }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const { session, clientNameFor, serverClientIdFor, slices } = useAppContext();
  // The server id, not the seed id: this is a live-only surface and the filter
  // goes to the server verbatim.
  const businessId = serverClientIdFor(client.id);
  const live = slices.documents.source === 'api';
  const trash = useDeletedDocuments({ enabled: live, clientNameFor, businessId });
  const canPurge = holdsReleaseAuthority(session);
  const [purging, setPurging] = useState<Document[] | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Restore needs no confirmation — it undoes something, and is itself undoable.
   * A partial batch is the honest outcome: the ones that went back really did,
   * and the failure names the document it stopped at.
   */
  const restoreSelected = async (sel: Document[]) => {
    if (sel.length === 0) return;
    setWorking(true);
    setFailure(null);
    const result = await applyToEach(sel.map((d) => d.id), restoreDocument);
    if (result.failedId !== null) {
      setFailure(intl.formatMessage(m.restoreFailed, { error: errorText(result.error) }));
    }
    await refreshTrash(queryClient);
    setWorking(false);
  };

  const columns: Column<Document>[] = [
    {
      key: 'supplier',
      label: intl.formatMessage(commonLabels.supplier),
      sortValue: (d) => d.displayTitle ?? d.supplier,
      render: (d) => <span className="text-white font-semibold">{d.displayTitle ?? d.supplier}</span>,
    },
    { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date },
    { key: 'category', label: intl.formatMessage(commonLabels.category), sortValue: (d) => d.category },
    {
      key: 'total',
      label: intl.formatMessage(commonLabels.total),
      align: 'right',
      sortValue: (d) => d.total,
      render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span>,
    },
    {
      key: 'status',
      label: intl.formatMessage(m.deletedOn),
      sortValue: (d) => d.status,
      render: () => <Pill>{intl.formatMessage(m.restore)}</Pill>,
    },
  ];

  if (!live) {
    return <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.syntheticNote)}</p>;
  }

  const loadError = trash.contractError ?? errorText(trash.error);

  return (
    <div className="flex flex-col gap-4">
      {/* The policy, above the list rather than buried in a tooltip: it is the
          answer to "how will the trash hold the file", and somebody looking at
          their own deleted documents is exactly who is asking. */}
      <p className="text-[12.5px] text-zinc-500 leading-relaxed max-w-3xl">
        {intl.formatMessage(m.policy, { days: TRASH_RETENTION_DAYS })}
      </p>

      {(trash.isLoading || loadError !== null || failure !== null) && (
        <div
          className={`flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold ${
            loadError !== null || failure !== null
              ? 'bg-red-500/10 border-red-500/20 text-red-300'
              : 'bg-white/[0.03] border-white/10 text-zinc-400'
          }`}
        >
          <RefreshCw size={15} className={loadError !== null || failure !== null ? '' : 'animate-spin'} />
          <span className="min-w-0">
            {failure ??
              (loadError !== null
                ? intl.formatMessage(m.loadError, { error: loadError })
                : intl.formatMessage(m.loading))}
          </span>
        </div>
      )}

      <DataTable<Document>
        className="max-w-none"
        columns={columns}
        rows={trash.documents}
        rowId={(d) => d.id}
        selectable
        emptyMessage={intl.formatMessage(m.empty, { client: client.name })}
        bulkActions={[
          {
            label: intl.formatMessage(m.restore),
            icon: RotateCcw,
            primary: true,
            onClick: (sel) => void restoreSelected(sel),
          },
          {
            label: intl.formatMessage(m.purge),
            icon: Trash2,
            // Offered and explained, never silently absent: item 39's rule.
            // `disabled` AND the hint: the button is visible, explains itself
            // on hover, and cannot be pressed. Hiding it would leave a standard
            // user wondering whether the action exists at all.
            ...(canPurge ? {} : { disabled: true, disabledHint: intl.formatMessage(m.purgeHint) }),
            onClick: (sel) => {
              if (canPurge) setPurging(sel);
            },
          },
        ]}
        footer={`${intl.formatMessage(m.footer, { count: trash.documents.length, days: TRASH_RETENTION_DAYS })} ${intl.formatMessage(m.footerRegister)}`}
      />

      {purging !== null && (
        <Suspense fallback={null}>
          <PurgeDocumentsDialog
            selection={purging}
            onClose={() => setPurging(null)}
            onSettled={() => void refreshTrash(queryClient)}
          />
        </Suspense>
      )}

      {/* `working` gates nothing visually beyond the banner above; naming it
          keeps the double-click case honest without a second spinner. */}
      {working && <span className="sr-only">{intl.formatMessage(m.loading)}</span>}
    </div>
  );
}

/** The message off an unknown error, or null. Local — three lines, one caller. */
function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

export default ClientTrashPanel;
