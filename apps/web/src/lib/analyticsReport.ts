import type { ClientStats } from './selectors';

/**
 * The practice analytics report (review item 56, 5 Sep 2026).
 *
 * The Analytics screen's export used to serialise its internal KPI object —
 * three columns of metric keys (`autoPublishedPct`, `itemDelay`…) with bare
 * numbers, no client dimension and no explanation. This replaces it with the
 * report shape the Dext-class products ship: **one row per client**, a practice
 * roll-up as a summary, and every assumption printed in the file itself.
 * The spec, with the competitor research and citations, is
 * `docs/reports/PRACTICE_ANALYTICS_REPORT.md`.
 *
 * ## Where every number comes from
 *
 * The caller hands in `ClientStats` per client — `statsFor` in AppContext,
 * which live is `clientStatsFromCounts` over the server's own
 * `BusinessSummary.counts`. Nothing here derives a count of its own, so this
 * file can never disagree with the Clients board about the same client.
 * `unmatched` in particular is the server's one predicate (`UNMATCHED AND NOT
 * chase_suppressed` — see `lib/matching.ts`), the items-25/30/35 lesson.
 *
 * ## What is deliberately absent
 *
 * Counts the API does not serve are OMITTED, never guessed (the spec lists
 * them as "not yet served"): duplicates caught, item delay, chases
 * sent/answered, and any period filter — the report is a point-in-time
 * snapshot and says so in its own header. `ClientStats` answers zero for the
 * first two live, and a zero that means "unknown" printed as a figure would be
 * invented data.
 *
 * ## Format: CSV, one file, sections stacked
 *
 * XLSX with a sheet per section would be the nicer shape and needs a
 * spreadsheet dependency this repo does not carry (adding one is a
 * stop-and-ask). Excel opens a UTF-8-BOM CSV cleanly, Dext's own insight
 * exports are CSV, and the upgrade path is confined to this one file.
 *
 * The strings are plain English by design: this is a downloaded artefact, not
 * screen copy — the same stance as the server's HOW-TO-IMPORT.txt.
 */

/**
 * The time-saved assumption, and it is PRINTED into the report — never silent.
 * No competitor publishes a formula (Dext says "hours back every week",
 * AutoEntry "up to 90%"), so this constant is ours: a deliberately conservative
 * 3 minutes of manual keying avoided per published document.
 */
export const MINUTES_SAVED_PER_PUBLISHED_DOCUMENT = 3;

export interface ClientReportRow {
  name: string;
  stats: ClientStats;
  /** The server's subscription status for this client, or null when none is served. */
  subscriptionStatus: string | null;
}

/** RFC 4180 quoting. Everything is quoted so a client named `Smith, Sons & Co` survives. */
function cell(value: string | number): string {
  return typeof value === 'number' ? String(value) : `"${value.replace(/"/g, '""')}"`;
}

function line(...cells: (string | number)[]): string {
  return cells.map(cell).join(',');
}

/** Published documents × the stated constant, as hours to one decimal place. */
function timeSavedHours(published: number): number {
  return Math.round(((published * MINUTES_SAVED_PER_PUBLISHED_DOCUMENT) / 60) * 10) / 10;
}

export function buildPracticeReport(input: {
  rows: ClientReportRow[];
  /** "Whole practice" or the one client's name — pre-formatted by the caller. */
  scopeName: string;
  /** Pre-formatted UK long date ("5 September 2026") — rendering stays with the screen. */
  generatedOn: string;
}): string {
  const { rows, scopeName, generatedOn } = input;

  const sum = (pick: (stats: ClientStats) => number) => rows.reduce((total, row) => total + pick(row.stats), 0);
  const publishedTotal = sum((s) => s.published);

  const out: string[] = [
    line('Practice analytics report'),
    line('Scope', scopeName),
    line('Generated', generatedOn),
    line(
      'Figures are a point-in-time snapshot of the document pipeline, read from the same server counts the Clients board shows. Period filtering is not yet served.',
    ),
    line(
      `Time saved assumes ${MINUTES_SAVED_PER_PUBLISHED_DOCUMENT} minutes of manual keying avoided per published document. It is an estimate under that stated assumption, not a measurement.`,
    ),
    line(
      'Not yet served by the API, and omitted rather than guessed: duplicates caught, item delay, chases sent and answered, month-on-month trend.',
    ),
    '',
    line('Practice summary'),
    line('Clients in scope', rows.length),
    line('To review', sum((s) => s.toReview)),
    line('Ready', sum((s) => s.ready)),
    line('Failed', sum((s) => s.rejected)),
    line('Published (approved and released for export)', publishedTotal),
    line('Missing paperwork', sum((s) => s.missing)),
    line('Requested (chase outstanding)', sum((s) => s.requested)),
    line('Overdue requests', sum((s) => s.overdue)),
    line('Unmatched bank lines', sum((s) => s.unmatched)),
    line('Statement gaps', sum((s) => s.statementGaps)),
    line('Approvals waiting', sum((s) => s.approvals)),
    line('Time saved (hours, estimated)', timeSavedHours(publishedTotal)),
    '',
    line('Per client'),
    line(
      'Client',
      'Health %',
      'To review',
      'Ready',
      'Failed',
      'Published',
      'Missing paperwork',
      'Requested',
      'Overdue',
      'Unmatched bank lines',
      'Statement gaps',
      'Approvals waiting',
      'Subscription',
      'Time saved (hours, estimated)',
    ),
    ...rows.map((row) =>
      line(
        row.name,
        row.stats.health,
        row.stats.toReview,
        row.stats.ready,
        row.stats.rejected,
        row.stats.published,
        row.stats.missing,
        row.stats.requested,
        row.stats.overdue,
        row.stats.unmatched,
        row.stats.statementGaps,
        row.stats.approvals,
        // Absent is a true answer (the endpoint may not serve one yet); a made-up
        // "inactive" would be a claim about somebody's billing.
        row.subscriptionStatus ?? 'not recorded',
        timeSavedHours(row.stats.published),
      ),
    ),
  ];

  return out.join('\r\n') + '\r\n';
}
