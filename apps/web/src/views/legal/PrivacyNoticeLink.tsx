import { defineMessages, useIntl } from 'react-intl';
import { legalPath } from './documents';

/**
 * The UK GDPR Art. 13 link (launch stage M4): the privacy notice must be
 * reachable AT THE POINT OF COLLECTION, so this renders on the portal
 * sign-in and upload screens — not only in a marketing footer a client on an
 * SMS link never sees.
 *
 * It is a real `<a>` that opens in a NEW TAB, deliberately not `linkProps`:
 * the chase portal's session is a bearer held in React state and nowhere
 * else, so an in-app navigation would unmount the journey and destroy the
 * session mid-upload — reading the privacy notice must not cost the client
 * their place. Same-origin, so `noreferrer` costs nothing and keeps the lint
 * rule satisfied.
 *
 * One tiny module on purpose: the portal is the lightest surface in the
 * product, and this must never drag `LegalView` or a document chunk in with
 * it.
 */

const m = defineMessages({
  sentence: {
    id: 'legal.privacyNoticeLink.sentence',
    defaultMessage: 'How we handle your data is set out in our {link}.',
  },
  linkLabel: { id: 'legal.privacyNoticeLink.linkLabel', defaultMessage: 'Privacy Notice' },
  opensNewTab: {
    id: 'legal.privacyNoticeLink.opensNewTab',
    defaultMessage: 'Privacy Notice (opens in a new tab)',
    description: 'Screen-reader name for the link — says the tab switch a sighted user infers from context.',
  },
});

export function PrivacyNoticeLink({ className = '' }: { className?: string }) {
  const intl = useIntl();
  return (
    <p className={`text-[12px] text-zinc-600 leading-relaxed ${className}`}>
      {intl.formatMessage(m.sentence, {
        link: (
          <a
            key="privacy-notice"
            href={legalPath('privacy-notice')}
            target="_blank"
            rel="noreferrer"
            aria-label={intl.formatMessage(m.opensNewTab)}
            className="font-semibold text-zinc-400 underline underline-offset-2 hover:text-white transition-colors"
          >
            {intl.formatMessage(m.linkLabel)}
          </a>
        ),
      })}
    </p>
  );
}
