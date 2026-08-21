'use strict';

const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const timesheetApprovalReportService = require('./timesheetApprovalReportService');
const dateHelper = require('../helpers/dateHelper');
const { formatTimeForDisplay } = require('../helpers/workLogTimeHelper');

/**
 * Work Log Time Report (Employee Self Timesheet module) — Day / Employee
 * Code / Name / Project / Module / Task / Start Time / End Time / Total
 * Hours, one row per employee_work_logs entry (never aggregated).
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
 * @param {import('../models').EmployeeWorkLog} log
 * @returns {object} one report row
 */
function mapRow(log) {
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
    startTime: formatTimeForDisplay(log.start_time),
    endTime: formatTimeForDisplay(log.end_time),
    // Old rows with no start/end time use their existing `hours` value as-is
    // — never fabricated start/end times for historical records.
    totalHours: parseFloat(log.hours) || 0,
  };
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
    employeeIds, companyId, startDate, endDate, servicePOId, projectId,
  });

  const rows = workLogs.map(mapRow);
  const totalHours = Math.round(rows.reduce((sum, row) => sum + row.totalHours, 0) * 100) / 100;

  return { rows, totalHours, columns: REPORT_COLUMNS };
};

module.exports = {
  getReport,
  REPORT_COLUMNS,
};
