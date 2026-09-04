/**
 * Links to the public legal pages — the terms of service and the privacy
 * notice — for the two messages that must carry them (4 Sep 2026, the ID
 * walkthrough's findings 1 and 4: neither the signup confirmation nor the
 * client invite gave its reader any way to reach the terms).
 *
 * The paths mirror `apps/web/src/views/legal/documents.ts` (`legalPath`, the
 * one maker of a legal page's address). `/legal/*` renders OUTSIDE every wall
 * (launch stage M4) — a reader with no session, which is exactly who both of
 * these emails reach — so a link here never dead-ends on a login screen.
 *
 * ⚠ The SAME drift trap as `VERIFY_EMAIL_PATH` (auth-tenancy): the web app is
 * an SPA, so a moved legal route would answer these links 200 with the app
 * shell and the reader would see the contents page instead of the terms —
 * silently. `legal-links.test.ts` reads the web package's own source and fails
 * if the two halves drift, the `notifications-signup-mailer.test.ts` pattern.
 */

export const TERMS_OF_SERVICE_PATH = '/legal/terms-of-service';
export const PRIVACY_NOTICE_PATH = '/legal/privacy-notice';

/**
 * The pair every carrying composer takes. Built by the CALLER from the app
 * origin — this module composes words, and the public web origin is a
 * configuration concern belonging to whoever owns the composition root, the
 * same split every other link in `email-copy.ts` observes.
 */
export interface LegalLinks {
  readonly termsLink: string;
  readonly privacyLink: string;
}

/** `<origin>/legal/…` for both documents. Trailing slash tolerated, like the other link builders. */
export function buildLegalLinks(appOrigin: string): LegalLinks {
  const origin = appOrigin.endsWith('/') ? appOrigin.slice(0, -1) : appOrigin;
  return {
    termsLink: `${origin}${TERMS_OF_SERVICE_PATH}`,
    privacyLink: `${origin}${PRIVACY_NOTICE_PATH}`,
  };
}
