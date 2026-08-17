import { defineMessages } from 'react-intl';

/**
 * The shared catalogue — issue #94.
 *
 * Consolidation is by MEANING, never by matching strings. An id belongs here
 * only when every call site names the same concept in the same surface role,
 * so a translation correct at one site is correct at all of them: `cancel` is
 * always the abandon-this-form button, `label.client` is always the client
 * attribute of a row or record in a label position. The moment two sites can
 * legitimately want different words — a pill a translator shortens to fit a
 * column, a tab, a navigation word, a channel display name — they keep
 * per-component ids, the way `ClientDetailView` deliberately keeps three
 * separate ids for its Connected / Waiting on client / Not connected pills.
 *
 * Each id here must be declared NOWHERE else: `pnpm i18n:check` treats a
 * conflicting duplicate id as fatal, which is the gate that keeps this file
 * the single source for these words.
 */
export const commonActions = defineMessages({
  cancel: { id: 'common.action.cancel', defaultMessage: 'Cancel' },
  close: { id: 'common.action.close', defaultMessage: 'Close' },
  exportCsv: { id: 'common.action.exportCsv', defaultMessage: 'Export CSV' },
  retry: { id: 'common.action.retry', defaultMessage: 'Retry' },
});

export const commonLabels = defineMessages({
  client: { id: 'common.label.client', defaultMessage: 'Client' },
  supplier: { id: 'common.label.supplier', defaultMessage: 'Supplier' },
  date: { id: 'common.label.date', defaultMessage: 'Date' },
  category: { id: 'common.label.category', defaultMessage: 'Category' },
  status: { id: 'common.label.status', defaultMessage: 'Status' },
  total: { id: 'common.label.total', defaultMessage: 'Total' },
  amount: { id: 'common.label.amount', defaultMessage: 'Amount' },
  stage: { id: 'common.label.stage', defaultMessage: 'Stage' },
  waiting: { id: 'common.label.waiting', defaultMessage: 'Waiting' },
  email: { id: 'common.label.email', defaultMessage: 'Email' },
  mobile: { id: 'common.label.mobile', defaultMessage: 'Mobile' },
  role: { id: 'common.label.role', defaultMessage: 'Role' },
  permissions: { id: 'common.label.permissions', defaultMessage: 'Permissions' },
  clientAccess: { id: 'common.label.clientAccess', defaultMessage: 'Client access' },
  vatNumber: { id: 'common.label.vatNumber', defaultMessage: 'VAT number' },
  nextDeadline: { id: 'common.label.nextDeadline', defaultMessage: 'Next deadline' },
});

export const commonPlaceholders = defineMessages({
  ukMobile: { id: 'common.placeholder.ukMobile', defaultMessage: '+44 7700 900123' },
  personName: { id: 'common.placeholder.personName', defaultMessage: 'John Doe' },
});
