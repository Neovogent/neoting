# Practice analytics report — spec

**Status:** implemented (5 Sep 2026, review item 56) · **Builder:** `apps/web/src/lib/analyticsReport.ts` · **Trigger:** the Export button on the Analytics screen

## What it replaces, and why

The Analytics export serialised the screen's internal KPI object: three columns
(Scope / Metric / Value), internal metric keys (`autoPublishedPct`, `itemDelay`,
`approvalAge`…), bare numbers, no client dimension, no period, no explanation.
Two of its rows were defects in their own right, fixed with this spec:

1. **`autoPublishedPct` was D42-forbidden vocabulary** — nothing auto-publishes
   in ID; Published is a human release. The metric measures the share of
   processed documents that reached Published, and is now named `publishedPct`.
2. **`unmatched` had to be the one predicate.** The exported figure now comes
   through `statsFor` → the server's `BusinessSummary.counts` (live) /
   `isUnexplained` (seeded) — the same `UNMATCHED AND NOT chase_suppressed`
   answer every other surface reads since the 2 Sep "Unexplained is one
   predicate" work. (Package A had already landed; this aligns with it.)

## What the field ships (researched 5 Sep 2026)

**Dext Practice Insights is the category benchmark.** Its Bookkeeping/Practice/
Data Health insights are per-client, exportable tables: items to action, items
submitted (30-day), inactive clients, supplier-rule automation performance, a
per-client **Health Score** with trend, missing-paperwork and
requested-paperwork columns, item delay, bank-statement coverage (missing
statement periods), and a **duplicate transactions check** whose alert level is
duplicates relative to total transactions. **AutoEntry** ships essentially one
practice-level report: **credit usage per company** (billing units, not
health), plus a cross-company activity log. **Hubdoc** ships no practice
analytics at all — a client list with status flags.

**Time saved is marketing everywhere** — Dext "hours back every week",
AutoEntry "up to 90% less data entry time" — with **no published per-document
formula from any of them**. So our report sets its own assumption and prints it
in the file (below), rather than mimicking a formula that does not exist.

Sources: [Dext Practice Insights](https://help.dext.com/en/s/article/the-practice-insights-page) ·
[What are Insights in Dext](https://help.dext.com/en/articles/642737-what-are-insights-in-dext) ·
[Dext Practice insight](https://help.dext.com/en/articles/273815-using-the-practice-insight) ·
[Dext Data Health insight](https://help.dext.com/en/articles/273813-using-the-data-health-insight) ·
[Dext Missing Paperwork](https://help.dext.com/en/articles/106085-missing-paperwork) ·
[Dext duplicate transactions check](https://help.dext.com/en/articles/276847-using-the-duplicate-transactions-check) ·
[Dext plans (item delay / missing / requested columns)](https://help.dext.com/en/articles/273220-dext-plans-for-accountants-and-bookkeepers) ·
[Dext bank statement extraction (gap detection)](https://help.dext.com/en/articles/455059-how-to-use-bank-statement-extraction-in-dext) ·
[AutoEntry Credit Usage report](https://help.autoentry.com/en/articles/1536270-credit-usage-report) ·
[AutoEntry Activity page](https://help.autoentry.com/en/articles/1312829-activity-page) ·
[Hubdoc client organisations](https://central.xero.com/s/article/View-client-organisations-you-have-access-to-in-Hubdoc) ·
[Hubdoc document status](https://central.xero.com/s/article/About-a-document-s-status-in-Hubdoc)

## The report

One CSV, UTF-8 with BOM, `practice-analytics-report.csv`, sections stacked:

### 1. Header
Report name · scope (whole practice or one client) · generated date
(Europe/London, long form) · three printed caveats: point-in-time snapshot,
the time-saved assumption, and the not-yet-served list.

### 2. Practice summary
Roll-up of the per-client rows — clients in scope, to review, ready, failed,
published, missing paperwork, requested, overdue, unmatched bank lines,
statement gaps, approvals waiting, time saved (hours).

### 3. Per client (one row per client)

| Column | Source |
|---|---|
| Client | `BusinessSummary.name` |
| Health % | `pipelineHealth` over the server counts — the same score the Clients board shows |
| To review / Ready / Failed / Published | `BusinessSummary.counts` (document state folds) |
| Missing paperwork / Requested / Overdue | `BusinessSummary.counts` (chase queues) |
| Unmatched bank lines | `BusinessSummary.counts.unmatched` — the one predicate |
| Statement gaps | `BusinessSummary.counts.statementGaps` (D41) |
| Approvals waiting | `BusinessSummary.counts.approvals` |
| Subscription | `BusinessSummary.subscription.status`, or `not recorded` when the server has not served one |
| Time saved (hours, estimated) | published × the stated constant, below |

Every count reaches the file through `statsFor` — live, that is
`clientStatsFromCounts` over the server's `BusinessSummary.counts` — so the
report can never disagree with the Clients board about the same client. The
web derives nothing.

## Time saved — the formula and its printed assumption

`published documents × 3 minutes`, rendered as hours to one decimal place.
The constant lives in `analyticsReport.ts` as
`MINUTES_SAVED_PER_PUBLISHED_DOCUMENT` and **the assumption is printed inside
the report file itself** — the figure is an estimate under a stated assumption,
never a silent claim. Three minutes is deliberately conservative against
AutoEntry's "up to 90% of data entry time".

## Period handling

**Point-in-time snapshot, and the file says so.** `BusinessSummary.counts` is a
current-state aggregate; no server endpoint serves period-scoped per-client
counts. Faking a period filter client-side (filtering the paginated documents
slice) would disagree with the boards, so it is not done. Period scoping —
"this month vs last", the progress-over-time ask — is listed as **not yet
served** and needs a server aggregate (a contract addition) before the report
can carry it.

## Format: CSV now, XLSX as the upgrade path

XLSX with a sheet per section is the better final shape (the header caveats,
summary and per-client table are genuinely three sheets). It needs a
spreadsheet dependency this repo does not carry, and **adding a dependency is a
stop-and-ask** (root CLAUDE.md). Excel opens a UTF-8-BOM CSV cleanly, Dext's
own insight exports are CSV, and the change is confined to
`analyticsReport.ts` + the download function when the dependency decision is
made.

## Not yet served — honest omissions, not zeros

Listed in the report's own header. Each needs a server source before it may
appear as a column; printing a zero that means "unknown" would be invented data.

| Metric | What serving it needs |
|---|---|
| Duplicates caught per client | an aggregate over the duplicates pair table on `GET /businesses` (Dext ships this as its duplicate-check alert level) |
| Item delay (document date → upload) | a per-client age projection; the seeded board figure is synthetic |
| Chases sent / answered per client | per-client chase outcome counts (the chases list exists; the aggregate does not) |
| Month-on-month trend / period scoping | period-scoped counts on the server |
| Submission channel mix per client | a per-client `source` fold on the server (screen shows it practice-wide from the documents slice) |
