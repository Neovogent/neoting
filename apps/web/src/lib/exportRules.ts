import { defineMessages } from 'react-intl';

/**
 * When an export is worth offering.
 *
 * Export is a bulk verb. A CSV of a single row is not an export — it is a
 * worse copy of a document that already has its own View and its own
 * download, and offering it invites someone to open a spreadsheet to read
 * one supplier's name. Every table that exports also has a per-row way in,
 * so the button waits until there is genuinely a set to take away.
 *
 * The hint is a `MessageDescriptor` rather than text: this module is not a
 * component and cannot call `useIntl`, and the six tables that show it each
 * already hold an `intl`. See `i18n/index.ts`.
 */
export const EXPORT_MIN_ROWS = 2;

const m = defineMessages({
  hint: {
    id: 'pipeline.exportRules.hint',
    defaultMessage: 'Select two or more rows — a CSV of one row is just a document, use View to open it',
  },
});

/** Why the export button is disabled. Format it where the button renders. */
export const EXPORT_HINT = m.hint;
