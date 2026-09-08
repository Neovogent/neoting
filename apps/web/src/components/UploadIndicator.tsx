import { useSyncExternalStore } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { Loader2 } from 'lucide-react';
import { getUploadProgress, subscribeUploadProgress } from '../api/uploads';

const m = defineMessages({
  uploading: {
    id: 'shell.uploadIndicator.uploading',
    defaultMessage: 'Uploading {done, number} of {total, number}…',
  },
  uploadingOne: { id: 'shell.uploadIndicator.uploadingOne', defaultMessage: 'Uploading…' },
});

/**
 * The one visible sign that a drop is in flight (item 11, 8 Sep 2026).
 *
 * Reads the transport's own counter — `api/uploads.ts` — rather than taking
 * props, because the four surfaces that accept a drop all share one function
 * and none of them owns the progress. Renders nothing when nothing is
 * uploading, so it costs an empty node on every other screen.
 *
 * `aria-live="polite"`: a screen-reader user gets the same signal the spinner
 * gives everybody else, announced once when it appears rather than on every
 * file.
 */
export function UploadIndicator() {
  const intl = useIntl();
  const progress = useSyncExternalStore(subscribeUploadProgress, getUploadProgress, getUploadProgress);
  if (progress.total === 0) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-brand/25 bg-brand/10 text-[11px] font-bold text-brand whitespace-nowrap"
    >
      <Loader2 size={12} className="animate-spin shrink-0" />
      {progress.total === 1
        ? intl.formatMessage(m.uploadingOne)
        : intl.formatMessage(m.uploading, { done: progress.done + 1 > progress.total ? progress.total : progress.done + 1, total: progress.total })}
    </span>
  );
}
