import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import type { PortalSendFault, PortalSendReason } from './portalSendFault';

/**
 * Why a portal upload did not send — the shared half of the two surfaces that
 * send bytes (Capture and Upload).
 *
 * ## What this replaced
 *
 * Both surfaces collapsed every failure into one sentence. Capture said
 * *"2 photos did not send — they are still here, try again."* and Upload said
 * *"Did not send. Try it again."*, and each stood in front of four different
 * problems with four different remedies: an upload that never reached storage,
 * a lapsed subscription (`402 NT-BIL-001`), an expired sixty-minute session
 * (`401 NT-OTP-002`), and a file the server refused (`400`). "Try again" is
 * right for one of them. A client whose subscription had lapsed could press the
 * button all afternoon and never learn why.
 *
 * The reason was never missing — `useBusinessPortalSession.send()` computed it
 * and both callers dropped it. It is one component rather than two so the two
 * surfaces cannot drift into describing the same failure differently.
 *
 * ## ⚠ It renders what is true and never a guess
 *
 * `storage-unreachable` shows **no reference**, because there is none: a
 * cross-origin `fetch` failure is opaque by design and the browser withholds
 * the status so a page cannot probe another origin. So the copy says the
 * upload could not reach storage and stops. Writing "check your connection"
 * there would send a client to their wifi settings for a bucket
 * misconfiguration on our side — the same error `faultMessageFor` was fixed for
 * on the onboarding journey, and the reason a code and that sentence may never
 * appear together.
 */

const m = defineMessages({
  reasonStorageUnreachable: {
    id: 'portal.portalSendFaultNotice.reasonStorageUnreachable',
    defaultMessage:
      'The upload could not reach our storage. Nothing is wrong with what you sent and nothing has been lost — if it happens again, tell your accountant.',
  },
  reasonStorageRefused: {
    id: 'portal.portalSendFaultNotice.reasonStorageRefused',
    defaultMessage:
      'Our storage refused the upload. That is our problem rather than yours — tell your accountant if it happens again.',
  },
  reasonApiUnreachable: {
    id: 'portal.portalSendFaultNotice.reasonApiUnreachable',
    defaultMessage: 'We could not reach Neo Accounting. Check your connection and try again.',
  },
  reasonLapsed: {
    id: 'portal.portalSendFaultNotice.reasonLapsed',
    defaultMessage: 'Your subscription is not active, so we cannot accept documents yet.',
  },
  reasonExpired: {
    id: 'portal.portalSendFaultNotice.reasonExpired',
    defaultMessage: 'Your sign-in has expired. Ask for a new code, then send these again.',
  },
  reasonRefused: {
    id: 'portal.portalSendFaultNotice.reasonRefused',
    defaultMessage: 'That was refused: {detail}',
  },
  reasonRefusedNoDetail: {
    id: 'portal.portalSendFaultNotice.reasonRefusedNoDetail',
    defaultMessage: 'That was refused. Try a clearer photo, or a different file.',
  },
  reasonServer: {
    id: 'portal.portalSendFaultNotice.reasonServer',
    defaultMessage: 'Something went wrong at our end. Nothing has been lost — try again in a moment.',
  },
  // The code goes WITH the words, never instead of them (frontend ten, item 5):
  // it is what a client reads out to their accountant over the phone.
  faultCode: { id: 'portal.portalSendFaultNotice.faultCode', defaultMessage: 'Reference {code}' },
  faultCount: {
    id: 'portal.portalSendFaultNotice.faultCount',
    defaultMessage: '{count, plural, one {# file} other {# files}}',
  },
  subscribeAction: {
    id: 'portal.portalSendFaultNotice.subscribeAction',
    defaultMessage: 'Restart your subscription',
  },
});

/**
 * Keyed by the machine reason — only the sentence is copy, the way
 * `LivePortalCapture`'s camera-fault table already does it. `refused` is absent
 * because it has two messages, chosen on whether the server sent words of its
 * own.
 */
const SEND_REASON: Record<Exclude<PortalSendReason, 'refused'>, MessageDescriptor> = {
  'storage-unreachable': m.reasonStorageUnreachable,
  'storage-refused': m.reasonStorageRefused,
  'api-unreachable': m.reasonApiUnreachable,
  lapsed: m.reasonLapsed,
  expired: m.reasonExpired,
  server: m.reasonServer,
};

/**
 * One entry per DISTINCT reason, not one per file.
 *
 * Four photographs refused for one lapsed subscription is one fact with one
 * remedy, and repeating it four times buries it. The key carries the code and
 * the detail as well as the reason, so two genuinely different `400`s stay
 * apart.
 */
export function groupFaults(
  faults: readonly PortalSendFault[],
): { fault: PortalSendFault; count: number }[] {
  const groups = new Map<string, { fault: PortalSendFault; count: number }>();
  for (const fault of faults) {
    const key = `${fault.reason}|${fault.code ?? ''}|${fault.detail ?? ''}`;
    const seen = groups.get(key);
    if (seen === undefined) groups.set(key, { fault, count: 1 });
    else seen.count += 1;
  }
  return [...groups.values()];
}

export function PortalSendFaultNotice({
  failures,
  headline,
  onSubscribe,
  busy,
}: {
  readonly failures: readonly PortalSendFault[];
  /** Each surface names its own noun — photos on Capture, files on Upload. */
  readonly headline: MessageDescriptor;
  readonly onSubscribe: () => void;
  readonly busy: boolean;
}) {
  const intl = useIntl();
  if (failures.length === 0) return null;
  const groups = groupFaults(failures);

  return (
    <div role="alert" className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5 flex flex-col gap-3">
      <p className="text-[13px] font-semibold text-red-400">
        {intl.formatMessage(headline, { count: failures.length })}
      </p>
      {groups.map(({ fault, count }) => (
        <div key={`${fault.reason}-${fault.code ?? ''}-${fault.detail ?? ''}`} className="flex flex-col gap-1">
          <p className="text-[12px] text-zinc-300 leading-relaxed">
            {fault.reason === 'refused'
              ? fault.detail === null
                ? intl.formatMessage(m.reasonRefusedNoDetail)
                : intl.formatMessage(m.reasonRefused, { detail: fault.detail })
              : intl.formatMessage(SEND_REASON[fault.reason])}
          </p>
          {(fault.code !== null || groups.length > 1) && (
            <p className="text-[11px] text-zinc-600 font-bold tracking-wide">
              {groups.length > 1 && intl.formatMessage(m.faultCount, { count })}
              {groups.length > 1 && fault.code !== null && ' · '}
              {fault.code !== null && intl.formatMessage(m.faultCode, { code: fault.code })}
            </p>
          )}
          {/* D48 — a lapsed subscription is the one reason with a control that
              resolves it, and the client is the payer. Every other reason ends
              at the sentence, because there is nothing here for them to press. */}
          {fault.reason === 'lapsed' && (
            <button
              onClick={onSubscribe}
              disabled={busy}
              className="self-start mt-1 px-4 py-2 rounded-full text-[12px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              {intl.formatMessage(m.subscribeAction)}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
