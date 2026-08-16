import { IntlProvider } from 'react-intl';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, resolveLocale } from './index';

/**
 * Wraps the app so `useIntl()` works anywhere beneath it.
 *
 * Two decisions worth knowing before changing this:
 *
 * **`onError` is not silenced.** react-intl's default logs a console error for
 * a missing message and then renders the id — so a missed key degrades to
 * `inboxes.header.heading` on screen rather than to nothing. That is the right
 * failure: visible, greppable, and impossible to mistake for finished work. The
 * temptation is to quieten it once the console gets noisy; don't. The noise is
 * the signal, and `pnpm i18n:check` exists so it never reaches a user.
 *
 * With one locale, `defaultMessage` at each call site means this fires only for
 * a genuinely malformed message, not for an untranslated one.
 *
 * **No `messages` prop.** en-GB is the source locale, so every string is already
 * present as its own default. Passing an extracted catalogue back in would mean
 * maintaining a file that says exactly what the source says, and letting the two
 * disagree. A second locale passes its compiled catalogue here and en-GB stays
 * as it is.
 */
export function AppIntlProvider({ children }: { children: ReactNode }) {
  return (
    <IntlProvider locale={resolveLocale()} defaultLocale={DEFAULT_LOCALE}>
      {children}
    </IntlProvider>
  );
}
