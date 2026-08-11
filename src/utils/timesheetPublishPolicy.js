'use strict';

const employeeRepository = require('../repositories/employeeRepository');

/**
 * Timesheet Publish Policy — the single source of truth for what
 * `is_publish` should be set to when an Original Timesheet is FIRST created.
 * There are exactly two live places that insert into `timesheets` (see
 * timesheetService.js): confirmImport() (shared by Excel Import confirmation
 * and the Employee Work Log Sync flow — both already funnel through this one
 * function, including data that originated from Monthly Work Log, which has
 * no independent path into `timesheets`) and createTimesheet() (manual Admin
 * entry). confirmImport() also stamps a value onto the parent
 * timesheet_import_history row (see that function for how it's derived when
 * a batch spans employees with different flags). Both call one of the
 * resolver functions below instead of leaving is_publish at its DB default
 * — this file exists so that decision is made in exactly one place, not
 * reimplemented per call site.
 *
 * Rule — keyed on employees.is_timesheet_approval_required (EMPLOYEE-level;
 * see database/migrations/20260851_add_employee_timesheet_approval_required.sql).
 * This SUPERSEDES the previous company-wide rule (which was keyed on
 * companies.is_original_data_visible) — every employee now carries their
 * own copy of what was previously a single shared per-company value
 * (the migration backfilled each existing employee from their company's
 * flag at the time, so no existing employee's behavior changed the moment
 * this shipped). companies.is_original_data_visible itself is UNCHANGED and
 * keeps its own, separate job — a login-response UI hint in authService.js
 * (see extractIsOriginalDataVisible there) — it is simply no longer
 * consulted for this decision:
 *   - the employee has is_timesheet_approval_required = true
 *       -> is_publish = false (their timesheets are held back, awaiting an
 *          explicit Publish via the existing, untouched Publish API/flow —
 *          see timesheetService.js's publishImport()).
 *   - otherwise (false, or the employee can't be resolved)
 *       -> is_publish = true (their timesheets are published immediately).
 */

/**
 * Pure decision function — no I/O, so the rule itself is trivially
 * unit-testable without a database. Exported separately from the resolver
 * functions for exactly that reason. The transformation direction is
 * unchanged from when this was keyed on companies.is_original_data_visible
 * — "requires approval"/"visible as original first" both mean "hold back."
 *
 * @param {boolean} approvalRequired
 * @returns {boolean} the is_publish value a newly-created row should get
 */
function computeInitialIsPublish(approvalRequired) {
  return approvalRequired ? false : true;
}

/**
 * Null-safe read of a company's is_original_data_visible flag — retained
 * ONLY for authService.js's login-response UI hint, which is unrelated to
 * the is_publish decision above. A company that can't be resolved reads as
 * false, same as the column's own DEFAULT false.
 *
 * @param {object|null} company - a Sequelize Company instance or plain object
 * @returns {boolean}
 */
function extractIsOriginalDataVisible(company) {
  return !!(company && company.is_original_data_visible);
}

/**
 * Resolve the is_publish value a NEW `timesheets` row should be created
 * with, for one employee — the single-row path (manual Admin entry via
 * createTimesheet()).
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function resolveInitialIsPublishForEmployee(employeeId, companyId) {
  const employee = await employeeRepository.findById(employeeId, companyId);
  const approvalRequired = employee ? !!employee.is_timesheet_approval_required : true;
  return computeInitialIsPublish(approvalRequired);
}

/**
 * Bulk-resolve is_timesheet_approval_required for many employees at once —
 * the batch path (confirmImport(), which may span several employees in one
 * import/sync run). Reuses the existing employeeRepository.findByIds()
 * (already used for resource-allocation checks) rather than N individual
 * lookups.
 *
 * @param {number[]} employeeIds
 * @param {number} companyId
 * @returns {Promise<Map<number, boolean>>} employeeId -> is_timesheet_approval_required
 */
async function resolveApprovalRequiredMap(employeeIds, companyId) {
  const uniqueIds = [...new Set(employeeIds)];
  const employees = await employeeRepository.findByIds(uniqueIds, companyId);
  return new Map(employees.map((employee) => [employee.id, !!employee.is_timesheet_approval_required]));
}

module.exports = {
  computeInitialIsPublish,
  extractIsOriginalDataVisible,
  resolveInitialIsPublishForEmployee,
  resolveApprovalRequiredMap,
};
