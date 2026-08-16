/**
 * Message catalogues — Governance §12.6.
 *
 * en-GB is the source locale and the product's voice: "categorise", DD/MM/YYYY,
 * £ with thousands separators. US date formats exist in export settings only,
 * never in the interface (SoT §14).
 *
 * ## The one pattern, and why it is only one
 *
 * Every user-facing string goes through `defineMessages` at module scope and is
 * read with `intl.formatMessage(...)`:
 *
 *     const m = defineMessages({
 *       heading: { id: 'inboxes.header.heading', defaultMessage: 'Inboxes' },
 *     });
 *     const intl = useIntl();
 *     <h1>{intl.formatMessage(m.heading)}</h1>
 *
 * react-intl also offers `<FormattedMessage>`, which reads better inside JSX.
 * It is deliberately NOT used here. Roughly two thirds of this app's copy sits
 * in string props — `title`, `placeholder`, `aria-label` — which need a string
 * and cannot take an element, so a mixed codebase would need both idioms and a
 * rule about which applies where. One idiom that always works beats two that
 * each work sometimes, and it matters more than usual because this extraction
 * was done across many files at once: a convention with an exception is a
 * convention that drifts.
 *
 * ## Keys
 *
 * `domain.component.purpose`, per §12.6. The domain is the surface, not the
 * file path — `inboxes`, `chase`, `clients`, `portal` — so moving a component
 * between directories does not rewrite its keys. Ids are written out in full at
 * the call site rather than composed, because `@formatjs/cli` extracts by
 * static analysis and cannot see through a template literal.
 *
 * ## Plurals and interpolation
 *
 * ICU MessageFormat, always. Never string concatenation — `§12.6` forbids it,
 * and it is unfixable in languages where the plural rule is not "add an s":
 *
 *     '{count, plural, one {# document} other {# documents}} missing'
 *
 * ## The catalogue
 *
 * `defaultMessage` lives at the call site, so en-GB needs no catalogue file at
 * runtime — react-intl falls back to it. `pnpm i18n:extract` writes
 * `lang/en-GB.json` as the artefact a translator receives, and
 * `scripts/check-i18n.mjs` fails the build on a duplicate id or a message with
 * no default. A second locale adds a compiled catalogue here; nothing else
 * moves.
 */

/** The source locale. Everything is authored in it. */
export const DEFAULT_LOCALE = 'en-GB';

/**
 * Locales the product ships. One today — the list exists so adding the second
 * is a data change rather than a search for every place the first was assumed.
 */
export const SUPPORTED_LOCALES = [DEFAULT_LOCALE] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locale to render in.
 *
 * Deliberately not read from `navigator.language` yet: with one locale that
 * would only introduce a way for the app to render in a language it has no
 * messages for. It becomes a real negotiation when the second locale lands.
 */
export function resolveLocale(): SupportedLocale {
  return DEFAULT_LOCALE;
}
