/** The public seam of analytics (lint-enforced module boundary). */
export { AnalyticsModule } from './analytics.module.js';
export { buildAnalyticsReport, reportToCsv } from './analytics-report.js';
export { ANALYTICS_SERVICE, AnalyticsService } from './analytics.service.js';
