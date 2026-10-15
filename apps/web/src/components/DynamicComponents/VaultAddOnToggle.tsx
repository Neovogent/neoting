import { useState } from 'react';
import { Lock } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { API_ENABLED } from '../../api/config';
import { fetchVaultAddOn, setVaultAddOn } from '../../api/practiceVault';
import { useConfirm } from './ConfirmProvider';

/**
 * The accountant's switch for a client's £2/month Document Vault add-on (D51).
 *
 * ⚠ It REQUESTS the change; Stripe's webhook is what turns the vault on, so
 * the copy after a press says "requested", never "added". The server adds or
 * removes the price item on the client's own subscription — the client pays.
 */

const m = defineMessages({
  title: { id: 'vault.addOnToggle.title', defaultMessage: 'Document Vault add-on' },
  on: { id: 'vault.addOnToggle.on', defaultMessage: 'On — £2/month + VAT on the client’s subscription.' },
  off: { id: 'vault.addOnToggle.off', defaultMessage: 'Off. The client can add it from their portal, or you can add it here.' },
  notConfigured: { id: 'vault.addOnToggle.notConfigured', defaultMessage: 'The Vault add-on is not configured on this deployment.' },
  add: { id: 'vault.addOnToggle.add', defaultMessage: 'Add Vault — £2/month + VAT' },
  remove: { id: 'vault.addOnToggle.remove', defaultMessage: 'Remove Vault' },
  confirmAddTitle: { id: 'vault.addOnToggle.confirmAddTitle', defaultMessage: 'Add the Document Vault for this client?' },
  confirmAddDetail: {
    id: 'vault.addOnToggle.confirmAddDetail',
    defaultMessage: '£2 a month plus VAT is added to the client’s existing subscription — they pay it, on their next bill, part-month included.',
  },
  confirmRemoveTitle: { id: 'vault.addOnToggle.confirmRemoveTitle', defaultMessage: 'Remove the Document Vault for this client?' },
  confirmRemoveDetail: {
    id: 'vault.addOnToggle.confirmRemoveDetail',
    defaultMessage: 'Their documents stay where they are. They lose the ZIP download and the copy to Google Drive or OneDrive.',
  },
  requested: {
    id: 'vault.addOnToggle.requested',
    defaultMessage: 'Requested — it switches over as soon as the payment is confirmed.',
  },
});

export default function VaultAddOnToggle({ businessId }: { businessId: string }) {
  const intl = useIntl();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = ['vault-add-on', businessId] as const;
  const query = useQuery({ queryKey: key, queryFn: () => fetchVaultAddOn(businessId), enabled: API_ENABLED });

  if (!API_ENABLED || query.data === undefined) return null;
  const state = query.data;

  const toggle = async () => {
    const enabling = !state.enabled;
    const ok = await confirm({
      title: intl.formatMessage(enabling ? m.confirmAddTitle : m.confirmRemoveTitle),
      detail: intl.formatMessage(enabling ? m.confirmAddDetail : m.confirmRemoveDetail),
      confirmLabel: intl.formatMessage(enabling ? m.add : m.remove),
      ...(enabling ? {} : { tone: 'red' as const }),
    });
    if (ok !== true) return;
    setBusy(true);
    setNote(null);
    try {
      await setVaultAddOn(businessId, enabling);
      setNote(intl.formatMessage(m.requested));
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-white/5 bg-raised p-4">
      <p className="flex items-center gap-2 text-[13px] font-bold text-white">
        <Lock size={14} aria-hidden /> {intl.formatMessage(m.title)}
      </p>
      {!state.available ? (
        <p className="mt-1 text-[12px] text-zinc-400">{intl.formatMessage(m.notConfigured)}</p>
      ) : (
        <>
          <p className="mt-1 text-[12px] text-zinc-400">{intl.formatMessage(state.enabled ? m.on : m.off)}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggle()}
            className={`mt-3 rounded-full px-4 py-1.5 text-[12px] font-bold disabled:opacity-40 ${
              state.enabled ? 'border border-white/10 text-zinc-200 hover:bg-card' : 'bg-brand text-brand-on hover:bg-brand-hover'
            }`}
          >
            {intl.formatMessage(state.enabled ? m.remove : m.add)}
          </button>
          {note !== null && <p role="status" className="mt-2 text-[12px] text-zinc-300">{note}</p>}
        </>
      )}
    </div>
  );
}
