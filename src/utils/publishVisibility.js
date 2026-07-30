'use strict';

/**
 * Resolves which report/dashboard requests are gated by monthly-sheet
 * publish status, and which calendar months a request's filters actually
 * touch. Pure helpers only — the DB check itself lives in
 * timesheetImportRepository.arePeriodsFullyPublished(); orchestration
 * lives in publishVisibilityService.js.
 */

// The one role gated to published-only visibility. Per product decision,
// this is fixed and not expected to change or expand to other roles — the
// frontend sends it directly as a `roleId` query/body param (e.g.
// ?roleId=5) rather than it being resolved from the JWT or a role
// permission flag.
const PUBLISHED_ONLY_ROLE_ID = 5;

/**
 * True if the given roleId is the one role gated to published-only
 * visibility.
 *
 * @param {number|string} [roleId] - from the merged query/body filters
 * @returns {boolean}
 */
function requiresPublishedOnlyVisibility(roleId) {
  return Number(roleId) === PUBLISHED_ONLY_ROLE_ID;
}

/**
 * Resolve the distinct (year, month) calendar periods a report/dashboard
 * filter set touches, for the publish-visibility check.
 *
 * Returns null when the filters specify no period at all (no month+year,
 * no startDate/endDate) — this feature is inherently anchored to "the
 * selected month", so an unbounded/all-time query has nothing to gate on
 * and is never blocked by this check.
 *
 * startDate/endDate spanning multiple months resolves to every calendar
 * month the range touches (even partially) — e.g. Jan 15 to Mar 10 resolves
 * to Jan, Feb, and Mar, all of which must be fully published.
 *
 * @param {{ month?: number|string, year?: number|string, startDate?: string, endDate?: string }} filters
 * @returns {{ year: number, month: number }[] | null}
 */
function resolvePeriodMonths({ month, year, startDate, endDate } = {}) {
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

    const months = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const endCursor = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= endCursor) {
      months.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
  }

  if (month && year) {
    return [{ year: parseInt(year, 10), month: parseInt(month, 10) }];
  }

  return null;
}

module.exports = {
  requiresPublishedOnlyVisibility,
  resolvePeriodMonths,
};
