'use strict';

const timesheetImportRepository = require('../repositories/timesheetImportRepository');
const { requiresPublishedOnlyVisibility, resolvePeriodMonths } = require('../utils/publishVisibility');

/**
 * Publish Visibility Service
 * The single reusable gate every timesheet-derived report/dashboard/
 * analytics entry point calls before running its query: "should this
 * request be blocked because the caller passed the published-only-gated
 * roleId and the selected period isn't fully published yet?"
 *
 * Callers early-return their own function's normal "no results" shape when
 * this returns true — this service never shapes a response itself, since
 * that shape differs per endpoint (paginated rows, pivot tables, grouped
 * dashboard tiles, etc.) and must stay identical to what already exists.
 */

/**
 * @param {{ month?: number|string, year?: number|string, startDate?: string, endDate?: string }} filters
 * @param {number|string} [roleId] - from the merged query/body filters (e.g. ?roleId=5), sent directly by the frontend
 * @returns {Promise<boolean>} true = block (return empty/zeroed data instead of querying)
 */
const shouldBlockUnpublishedData = async (filters, roleId) => {
  if (!requiresPublishedOnlyVisibility(roleId)) return false;

  const periodMonths = resolvePeriodMonths(filters);
  if (!periodMonths) return false; // no period specified — nothing to gate on

  const fullyPublished = await timesheetImportRepository.arePeriodsFullyPublished(periodMonths);
  return !fullyPublished;
};

module.exports = { shouldBlockUnpublishedData };
