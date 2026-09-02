'use strict';

const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const timesheetApprovalReportService = require('./timesheetApprovalReportService');
const dateHelper = require('../helpers/dateHelper');
const { formatTimeForDisplay, formatHoursAsHrMin } = require('../helpers/workLogTimeHelper');

/**
 * Work Log Time Report (Employee Self Timesheet module) — Day / Employee
 * Code / Name / Project / Module / Task / Start Time / End Time / Total
 * Hours.
 *
 * One row per DETAILED TIME ENTRY (see EmployeeWorkLogTimeEntry.js) when a
 * work log has any — e.g. Module A's 09:30-10:20 and 14:00-15:00 both
 * appear as their own row, each showing that segment's own duration, per
 * this feature's ticket example. A work log with no time entries (a plain
 * hours-only row — old data, or a non-time-based entry) still contributes
 * exactly one row, with startTime/endTime null, exactly as before this
 * feature existed. Every row also carries `combinedHours`/`combinedHoursLabel`
 * — the SAME value for every row sharing one Module/Task/date (that work
 * log's own aggregated `hours`, already the sum of its segments) — so the
 * frontend can show the "Total = 1 hr 50 mins" rollup the ticket describes
 * without a second request.
 *
 * Scope: reuses timesheetApprovalReportService.resolveEmployeeScope — the
 * same data-driven Manager-team resolution the existing Timesheet Approval
 * Status report already uses (manager_employee_mappings), so this report
 * never introduces a second, divergent authorization rule. An Employee with
 * no mapped team sees only their own rows; a Manager additionally sees
 * their whole mapped team, or one requested employee_id if that employee is
 * mapped to them.
 */

const REPORT_COLUMNS = [
  { key: 'date', label: 'Day' },
  { key: 'employeeCode', label: 'Employee Code' },
  { key: 'name', label: 'Name' },
  { key: 'project', label: 'Project' },
  { key: 'module', label: 'Module' },
  { key: 'task', label: 'Task' },
  { key: 'startTime', label: 'Start Time' },
  { key: 'endTime', label: 'End Time' },
  { key: 'totalHours', label: 'Total Hours' },
  { key: 'combinedHoursLabel', label: 'Combined Total (Module/Task/Day)' },
];

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Exactly one of {startDate & endDate} or {month & year} — same convention
 * as the rest of the Employee Reports module.
 */
function resolvePeriod(query) {
  if (query.startDate && query.endDate) {
    return { startDate: query.startDate, endDate: query.endDate };
  }
  if (query.month && query.year) {
    return dateHelper.getMonthBounds(parseInt(query.month, 10), parseInt(query.year, 10));
  }
  throw badRequestError('Provide either startDate & endDate, or month & year.');
}

/**
 * Module → the hierarchy node's own name, EXCEPT when the tagged node is a
 * CHILD, in which case Module is its PARENT's name and the node's own name
 * is left for Task-level detail (see mapRow below). No hierarchy node at
 * all → null (there is no other "module" concept to fall back to).
 *
 * @param {ServicePOHierarchy|null} hierarchyNode
 * @returns {string|null}
 */
function resolveModuleName(hierarchyNode) {
  if (!hierarchyNode) return null;
  if (hierarchyNode.node_type === 'CHILD' && hierarchyNode.parentNode) {
    return hierarchyNode.parentNode.node_name;
  }
  return hierarchyNode.node_name;
}

/**
 * Build the fields every row for one employee_work_logs entry shares,
 * regardless of whether it expands into one row (no time entries) or many
 * (one per time entry) — see mapRows below.
 *
 * @param {import('../models').EmployeeWorkLog} log
 * @returns {object}
 */
function baseRowFields(log) {
  const combinedHours = parseFloat(log.hours) || 0;
  return {
    date: log.work_date,
    employeeCode: log.employee ? log.employee.employee_code : null,
    name: log.employee ? log.employee.full_name : null,
    project: log.servicePO && log.servicePO.project ? log.servicePO.project.project_name : null,
    module: resolveModuleName(log.hierarchyNode),
    // Task: the Work Log's own description — the free-text field the
    // employee filled in for what was actually done (e.g. "Internal
    // Meeting" under a "Meeting" Module) — never fabricated from the
    // hierarchy node.
    task: log.description,
    // The combined total for this Module/Task on this date — identical on
    // every row this log expands into (see the ticket's "Total = 110
    // minutes = 1 hour 50 minutes" example); already the sum of every time
    // entry's own duration (see employeeTimesheetService.resolveTimeEntries),
    // or the plain hours value for a non-time-based entry.
    combinedHours,
    combinedHoursLabel: formatHoursAsHrMin(combinedHours),
  };
}

/**
 * One employee_work_logs row expands into one report row PER detailed time
 * entry it has (Date/Module/Task repeated, Start Time/End Time/Total Hours
 * specific to that segment) — or exactly one report row, with
 * startTime/endTime null and totalHours the row's own aggregated `hours`,
 * when it has no time entries at all (a plain hours-only entry — old data,
 * or a non-time-based line).
 *
 * @param {import('../models').EmployeeWorkLog} log
 * @returns {object[]}
 */
function mapRows(log) {
  const base = baseRowFields(log);
  const entries = log.timeEntries || [];

  if (entries.length === 0) {
    return [{ ...base, startTime: null, endTime: null, totalHours: base.combinedHours }];
  }

  return entries.map((entry) => ({
    ...base,
    startTime: formatTimeForDisplay(entry.start_time),
    endTime: formatTimeForDisplay(entry.end_time),
    totalHours: parseFloat(entry.duration_hours) || 0,
  }));
}

/**
 * @param {number} userId - req.userId
 * @param {number} ownEmployeeId - req.employeeId
 * @param {number} companyId
 * @param {object} query - { employee_id?, service_po_id?, project_id?, startDate?, endDate?, month?, year? }
 * @returns {Promise<{ rows: object[], totalHours: number, columns: object[] }>}
 */
const getReport = async (userId, ownEmployeeId, companyId, query) => {
  const { startDate, endDate } = resolvePeriod(query);

  const requestedEmployeeId = query.employee_id ? parseInt(query.employee_id, 10) : null;
  const employeeIds = await timesheetApprovalReportService.resolveEmployeeScope(
    userId, ownEmployeeId, requestedEmployeeId, companyId
  );

  const servicePOId = query.service_po_id ? parseInt(query.service_po_id, 10) : null;
  const projectId = query.project_id ? parseInt(query.project_id, 10) : null;

  const workLogs = await employeeWorkLogRepository.getWorkLogTimeReportRows({
    employeeIds, startDate, endDate, servicePOId, projectId,
  });

  const rows = workLogs.flatMap(mapRows);
  const totalHours = Math.round(rows.reduce((sum, row) => sum + row.totalHours, 0) * 100) / 100;

  return { rows, totalHours, columns: REPORT_COLUMNS };
};

module.exports = {
  getReport,
  REPORT_COLUMNS,
};
