/**
 * Export destinations — the Initial Delivery half of `integrations` (D42, SoT
 * §24.3).
 *
 * ⚠ **`Published` is an internal state meaning approved and RELEASED FOR
 * EXPORT.** It asserts nothing about a ledger. Under D42 there is no ledger
 * API, no OAuth flow, no endpoint that could create a vendor connection, and
 * D47 forbids client intake from asking for one — so the `integrations` row a
 * client carries in this release is not a connection to anything. It records
 * *which import file the accountant will produce*, and nothing else.
 *
 * That is what `VT` and `MANUAL` are for, and the contract says so on
 * `IntegrationKind` itself: "Without a value that means 'this client exports
 * rather than connects', every document stopped at READY forever and the
 * export had nothing to export. Neither value carries a token, an org ref or a
 * health state, **and neither may ever become an adapter call**."
 *
 * The four ledger vendors stay in the enum for v1 (D6, which D42 supersedes
 * for this release only) and this module's `LedgerAdapter` seam stays with
 * them — dormant, not deleted. What this file says is that a `XERO` row is
 * **not** an ID export destination: recording one on a `publishes` row that
 * released a document for export would put a vendor's name against an act that
 * never touched a vendor, which is precisely the lie D42 exists to prevent.
 */

import type { IntegrationKind } from '@prisma/client';

/**
 * The kinds that mean "this client exports rather than connects".
 *
 * `MANUAL` alongside `VT` because the first client's software is not the last
 * one's: a practice whose client uses something with no emitter yet still
 * releases documents for export and still downloads a generic CSV
 * (`ExportTarget.GENERIC_CSV`). Both are inert by construction.
 */
export const EXPORT_DESTINATION_KINDS = ['VT', 'MANUAL'] as const satisfies readonly IntegrationKind[];

export type ExportDestinationKind = (typeof EXPORT_DESTINATION_KINDS)[number];

/**
 * One client's export destination, as the release path needs it.
 *
 * **No `orgRef`, no token, no health**, deliberately: the contract states that
 * neither value carries them, and a field that is always null is an invitation
 * to populate it. The id is recorded on the `publishes` row so an export can
 * later say which destination a release was made for; the kind is what an
 * emitter branches on.
 */
export interface ExportDestination {
  readonly id: string;
  readonly kind: ExportDestinationKind;
}

/** Whether an `integrations` row is an ID export destination rather than a dormant v1 ledger connection. */
export function isExportDestination(kind: IntegrationKind): kind is ExportDestinationKind {
  return (EXPORT_DESTINATION_KINDS as readonly IntegrationKind[]).includes(kind);
}
