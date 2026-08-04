'use strict';

const companyRepository = require('../repositories/companyRepository');

/**
 * Timesheet Publish Policy — the single source of truth for what
 * `is_publish` should be set to when an Original Timesheet is FIRST created.
 * There are exactly two live places that insert into `timesheets` (see
 * timesheetService.js): confirmImport() (shared by Excel Import confirmation
 * and the Employee Work Log Sync flow — both already funnel through this one
 * function) and createTimesheet() (manual Admin entry). confirmImport() also
 * stamps the SAME value onto the parent timesheet_import_history row, so the
 * two tables can never disagree. Both call resolveInitialIsPublish() below
 * instead of leaving is_publish at its DB default — this file exists so that
 * decision is made in exactly one place, not reimplemented per call site.
 *
 * Rule — keyed on companies.is_original_data_visible (COMPANY-level; see
 * database/migrations/20260808_add_company_original_data_visibility.sql).
 * Neither users.is_original_data_visible (a short-lived design, removed) nor
 * roles.is_original_data_visible (a separate, pre-existing column with its
 * own unrelated purpose) is consulted by this policy:
 *   - the company (req.companyId, already resolved from the JWT) has
 *     is_original_data_visible = true
 *       -> is_publish = false (its users work with the original/unpublished
 *          data first, then explicitly Publish via the existing, untouched
 *          Publish API/flow — see timesheetService.js's publishImport()).
 *   - otherwise (false, or the company can't be resolved)
 *       -> is_publish = true (this company's users only ever see published
 *          data, so imported/synced records must be published immediately).
 */

/**
 * Pure decision function — no I/O, so the rule itself is trivially
 * unit-testable without a database. Exported separately from
 * resolveInitialIsPublish() for exactly that reason.
 *
 * @param {boolean} isOriginalDataVisible
 * @returns {boolean} the is_publish value a newly-created row should get
 */
function computeInitialIsPublish(isOriginalDataVisible) {
  return isOriginalDataVisible ? false : true;
}

/**
 * Null-safe read of a company's is_original_data_visible flag — a company
 * that can't be resolved (not found) reads as false, same as the column's
 * own DEFAULT false, rather than throwing or special-casing it. Exported
 * separately from resolveInitialIsPublish() so this coercion is
 * unit-testable without a database.
 *
 * @param {object|null} company - a Sequelize Company instance or plain object
 * @returns {boolean}
 */
function extractIsOriginalDataVisible(company) {
  return !!(company && company.is_original_data_visible);
}

/**
 * Resolve the is_publish value NEW `timesheets`/`timesheet_import_history`
 * rows should be created with, based on the COMPANY's own
 * is_original_data_visible flag — the one call every Original Timesheet
 * creation flow must make before inserting.
 *
 * @param {number} companyId - already resolved from the JWT (req.companyId)
 * @returns {Promise<boolean>}
 */
async function resolveInitialIsPublish(companyId) {
  const company = await companyRepository.findById(companyId);
  return computeInitialIsPublish(extractIsOriginalDataVisible(company));
}

module.exports = {
  computeInitialIsPublish,
  extractIsOriginalDataVisible,
  resolveInitialIsPublish,
};
