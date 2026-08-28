'use strict';

const { sequelize } = require('../models');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const employeeRepository = require('../repositories/employeeRepository');
const timesheetService = require('./timesheetService');
const employeeTimesheetService = require('./employeeTimesheetService');
const dateHelper = require('../helpers/dateHelper');
const logger = require('../utils/logger');

/**
 * Employee Monthly Work Log Service.
 *
 * Second mode alongside Daily Work Log (employeeTimesheetService.js) —
 * lets an employee submit one month's hours in a single go instead of one
 * entry per day. Entries are written to the SAME `employee_work_logs` table
 * as Daily (reuses all reporting/sync/hierarchy machinery), tagged
 * log_type: 'monthly' and dated on the month's LAST calendar day. Only
 * eligible once the month has ended, or on its last calendar day (see
 * dateHelper.isMonthlyLogEligible).
 *
 * Submitting REPLACE-SAVEs the whole month: every existing row (Daily or
 * Monthly) in the month's date range is deleted, then exactly the given
 * entries are reinserted — the same pattern
 * employeeTimesheetService.replaceDailyEntries uses for one date, scoped to
 * a whole month here. This is also how "update the Monthly entry, never
 * duplicate" is satisfied — resubmitting just replaces it again.
 */

const MONTHLY_HOUR_CAP = 176;

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 422;
  return err;
}

/**
 * Build the { month, year, work_date, eligible, service_pos } response
 * shape shared by getMonthlyWorkLog and submitMonthlyWorkLog.
 */
async function buildMonthlyWorkLogDTO(employeeId, companyId, month, year) {
  const { endDate } = dateHelper.getMonthBounds(month, year);

  const [{ mappedPOs, hierarchyRowsByPOId }, breakdownRows] = await Promise.all([
    employeeTimesheetService.loadMappedPOsWithHierarchy(employeeId, companyId),
    employeeWorkLogRepository.getMonthlyLogHierarchyBreakdown({ employeeId, date: endDate, companyId }),
  ]);

  const hoursByPOId = employeeTimesheetService.groupHoursByServicePO(breakdownRows);
  const service_pos = employeeTimesheetService.buildServicePOsForDate(mappedPOs, hierarchyRowsByPOId, hoursByPOId);

  return {
    month,
    year,
    work_date: endDate,
    eligible: dateHelper.isMonthlyLogEligible(month, year),
    service_pos,
  };
}

/**
 * GET Monthly Work Log — the month's current entries (if any), the same
 * Service PO -> Parent -> Child hierarchy shape Daily uses, plus whether
 * this month is currently eligible for submission.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @returns {Promise<object>}
 */
const getMonthlyWorkLog = async (employeeId, companyId, month, year) => {
  return buildMonthlyWorkLogDTO(employeeId, companyId, month, year);
};

/**
 * Submit (create or update) the Monthly Work Log for one month. REPLACE
 * SAVE across the whole month's date range — see this file's header doc.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {object} data - { month, year, entries: [{ service_po_id, sub_project_id?, hierarchy_node_id?, hours, description }] }
 * @returns {Promise<object>} same shape as getMonthlyWorkLog
 */
const submitMonthlyWorkLog = async (employeeId, companyId, data) => {
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  const lines = data.entries || [];

  if (!dateHelper.isMonthlyLogEligible(month, year)) {
    throw validationError(
      'Monthly Work Log is only allowed for a month that has already ended, or on that month\'s last calendar day.'
    );
  }

  const { endDate, startDate } = dateHelper.getMonthBounds(month, year);

  // Deliberately does NOT reject when Daily entries (TIME_BASED or HOURLY)
  // already exist for this month — submitting a Monthly Work Log is
  // ALLOWED to consolidate/replace them: deleteByEmployeeAndDateRange below
  // wipes every existing row (Daily or Monthly) for the month before
  // inserting the new Monthly ones, same as it always has. The REVERSE
  // direction (a Monthly Work Log already exists -> Daily creation is
  // blocked) is intentionally still enforced, by
  // employeeTimesheetService.assertNoMonthlyLogForDate on every Daily write
  // path — only THIS direction (Daily existing -> Monthly attempted) is
  // unrestricted.

  // Two lines at the same (service_po_id, hierarchy_node_id) would collide
  // on insert — reject up front, same as Daily's replaceDailyEntries.
  const seenKeys = new Set();
  for (const line of lines) {
    const key = `${line.service_po_id}|${line.hierarchy_node_id || 'po'}`;
    if (seenKeys.has(key)) {
      const nodeSuffix = line.hierarchy_node_id ? ` / hierarchy node #${line.hierarchy_node_id}` : '';
      throw badRequestError(`Duplicate entry for Service PO #${line.service_po_id}${nodeSuffix} in the same request.`);
    }
    seenKeys.add(key);
  }

  const totalHours = lines.reduce((sum, line) => sum + parseFloat(line.hours), 0);
  if (totalHours > MONTHLY_HOUR_CAP) {
    throw badRequestError(
      `Total hours for this month cannot exceed ${MONTHLY_HOUR_CAP}. This request totals ${Math.round(totalHours * 100) / 100} hours.`
    );
  }

  // Resolve/validate every line before touching the database at all —
  // identical checks to Daily (project mapping, employee-active/PO-eligible/
  // sub-project-belongs-to-PO, hierarchy node ownership).
  const resolvedLines = [];
  for (const line of lines) {
    await employeeTimesheetService.assertProjectMapped(employeeId, line.service_po_id, companyId);

    const { po } = await timesheetService.resolveManualEntryReferences(
      { employee_id: employeeId, service_po_id: line.service_po_id, sub_project_id: line.sub_project_id },
      companyId,
      { skipPOCompanyScope: true }
    );

    const hierarchyNode = await employeeTimesheetService.resolveHierarchyNode(line.hierarchy_node_id, line.service_po_id);

    resolvedLines.push({ line, po, hierarchyNode });
  }

  const insertedRows = await sequelize.transaction(async (transaction) => {
    await employeeWorkLogRepository.deleteByEmployeeAndDateRange(employeeId, startDate, endDate, companyId, transaction);

    return employeeWorkLogRepository.bulkCreate(
      resolvedLines.map(({ line }) => ({
        employee_id: employeeId,
        service_po_id: line.service_po_id,
        sub_project_id: line.sub_project_id || null,
        hierarchy_node_id: line.hierarchy_node_id || null,
        work_date: endDate,
        hours: line.hours,
        description: line.description,
        company_id: companyId,
        status: 'pending',
        log_type: 'monthly',
        created_by: employeeId,
        updated_by: employeeId,
      })),
      transaction
    );
  });

  // Approval happens BEFORE Sync — see the matching comment in
  // employeeTimesheetService.replaceDailyEntries. Same additive
  // post-creation step, not a change to creation itself.
  const employee = await employeeRepository.findById(employeeId, companyId);
  if (employee && !employee.is_timesheet_approval_required && insertedRows.length > 0) {
    await employeeWorkLogRepository.markApprovedByIds(insertedRows.map((row) => row.id), companyId);
  }

  logger.info('Employee monthly work log submitted', {
    employeeId, companyId, month, year, workDate: endDate, entryCount: resolvedLines.length,
  });

  return buildMonthlyWorkLogDTO(employeeId, companyId, month, year);
};

/**
 * Delete the Monthly Work Log for one month (only log_type: 'monthly' rows
 * — never touches Daily entries).
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @returns {Promise<void>}
 */
const deleteMonthlyWorkLog = async (employeeId, companyId, month, year) => {
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);

  await employeeWorkLogRepository.deleteMonthlyEntries(employeeId, startDate, endDate, companyId);

  logger.info('Employee monthly work log deleted', { employeeId, companyId, month, year });
};

module.exports = {
  getMonthlyWorkLog,
  submitMonthlyWorkLog,
  deleteMonthlyWorkLog,
  MONTHLY_HOUR_CAP,
};
