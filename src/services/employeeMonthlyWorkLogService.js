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
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);

  const [{ mappedPOs, hierarchyRowsByPOId }, breakdownRows] = await Promise.all([
    employeeTimesheetService.loadMappedPOsWithHierarchy(employeeId, companyId),
    employeeWorkLogRepository.getHierarchyBreakdownForRange({ employeeId, startDate, endDate }),
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
 * @param {object} [options]
 * @param {number} [options.creatorId] - who to record in created_by/updated_by
 *   (defaults to employeeId, i.e. the employee submitted it themselves). A
 *   Manager filling this in on an Employee's behalf passes their own id here
 *   — see managerMonthlyWorkLogService.js.
 * @param {boolean} [options.forceApproved] - insert every row directly as
 *   'approved' (skipping the is_timesheet_approval_required lookup below
 *   entirely) — used by the Manager path, whose entries are approved by
 *   definition (a Manager typed them in, there's nothing left to approve).
 * @param {boolean} [options.allowHierarchyNode] - when false, reject any
 *   line carrying hierarchy_node_id ("Main PO" only — the Manager path
 *   can't yet drill into a Parent/Child hierarchy node; may be lifted
 *   later). Defaults to true (Employee self-service is unrestricted).
 * @returns {Promise<object>} same shape as getMonthlyWorkLog
 */
const submitMonthlyWorkLog = async (employeeId, companyId, data, options = {}) => {
  const { creatorId = employeeId, forceApproved = false, allowHierarchyNode = true } = options;
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  const lines = data.entries || [];

  if (!dateHelper.isMonthlyLogEligible(month, year)) {
    throw validationError(
      'Monthly Work Log is only allowed for a month that has already ended, or on that month\'s last calendar day.'
    );
  }

  if (!allowHierarchyNode) {
    const hierarchyLine = lines.find((line) => line.hierarchy_node_id);
    if (hierarchyLine) {
      throw badRequestError(
        `Service PO #${hierarchyLine.service_po_id}: hierarchy node selection is not supported here — log against the Main PO only.`
      );
    }
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
      { skipPOCompanyScope: true, skipEmployeeCompanyScope: true }
    );

    const hierarchyNode = await employeeTimesheetService.resolveHierarchyNode(line.hierarchy_node_id, line.service_po_id);

    resolvedLines.push({ line, po, hierarchyNode });
  }

  const insertedRows = await sequelize.transaction(async (transaction) => {
    await employeeWorkLogRepository.deleteByEmployeeAndDateRange(employeeId, startDate, endDate, companyId, transaction);

    return employeeWorkLogRepository.bulkCreate(
      resolvedLines.map(({ line, po }) => ({
        employee_id: employeeId,
        service_po_id: line.service_po_id,
        sub_project_id: line.sub_project_id || null,
        hierarchy_node_id: line.hierarchy_node_id || null,
        work_date: endDate,
        hours: line.hours,
        // Never undefined — Employee self-service's Joi schema requires a
        // non-empty description, but the Manager path (allowHierarchyNode:
        // false callers) treats it as optional, so a genuinely blank/absent
        // value must still resolve to '', never left unset against this
        // NOT NULL column (same fallback pattern as
        // employeeTimesheetService.withFallbackDescription).
        description: line.description || '',
        // The work log belongs to the Service PO's OWN owning BU, not
        // necessarily the caller's active session BU (cross-BU resourcing) —
        // see employeeTimesheetService.replaceDailyEntries' identical
        // comment. Falls back to the session companyId only for a
        // BU-less/Centralised PO (company_id: null).
        company_id: po.company_id ?? companyId,
        status: forceApproved ? 'approved' : 'pending',
        log_type: 'monthly',
        created_by: creatorId,
        updated_by: creatorId,
      })),
      transaction
    );
  });

  // Approval happens BEFORE Sync — see the matching comment in
  // employeeTimesheetService.replaceDailyEntries. Same additive
  // post-creation step, not a change to creation itself. Skipped entirely
  // when forceApproved already inserted every row as 'approved' above.
  if (!forceApproved) {
    const employee = await employeeRepository.findById(employeeId, companyId);
    if (employee && !employee.is_timesheet_approval_required && insertedRows.length > 0) {
      await employeeWorkLogRepository.markApprovedByIds(insertedRows.map((row) => row.id), companyId);
    }
  }

  logger.info('Employee monthly work log submitted', {
    employeeId, companyId, month, year, workDate: endDate, entryCount: resolvedLines.length, creatorId, forceApproved,
  });

  return buildMonthlyWorkLogDTO(employeeId, companyId, month, year);
};

/**
 * Delete every timesheet entry for one month — Daily or Monthly alike, same
 * "whole-month REPLACE" scope as submitMonthlyWorkLog's clear step. Matches
 * the UI's delete confirmation, which tells the employee every work log
 * entry for the month is removed, including ones logged day by day in
 * Daily mode.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @returns {Promise<void>}
 */
const deleteMonthlyWorkLog = async (employeeId, companyId, month, year) => {
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);

  await employeeWorkLogRepository.deleteByEmployeeAndDateRange(employeeId, startDate, endDate, companyId);

  logger.info('Employee monthly work log deleted', { employeeId, companyId, month, year });
};

module.exports = {
  getMonthlyWorkLog,
  submitMonthlyWorkLog,
  deleteMonthlyWorkLog,
  MONTHLY_HOUR_CAP,
};
