'use strict';

const repository = require('../repositories/projectTimesheetReportRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const { resolveAuthorizedEmployeeIds, applyEntityBuFilters } = require('./employeeWorkLogHoursSummaryService');
const dateHelper = require('../helpers/dateHelper');
const { parseIdList } = require('../utils/idListParser');
const { getPaginationMeta } = require('../utils/pagination');

/**
 * Project-Wise Timesheet Report (client requirement #5) — employee-wise and
 * day-wise work-log entries with the activity description, Project Manager,
 * leave hours and approval status, filterable project-wise and
 * employee-wise, downloadable as Excel/CSV for monthly project review,
 * effort validation, client billing and management reporting.
 *
 * Visibility: exactly the Employees the caller may see — the same
 * data-driven rule the Employee Work Log Hours Summary report uses
 * (employeeWorkLogHoursSummaryService.resolveAuthorizedEmployeeIds), over the
 * caller's report reach (req.companyIds from resolveReportCompanyScope),
 * narrowed by entity_ids / company_ids / business_unit_ids.
 */

const PROJECT_MANAGER_RANK = 6;
const MAX_RANGE_DAYS = 366;
const MAX_EXPORT_ROWS = 50000;

const STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  synced: 'Approved (Synced)',
  rejected: 'Rejected',
};

// approval_status filter -> work-log statuses
const STATUS_FILTER = {
  all: null,
  pending: ['pending'],
  approved: ['approved', 'synced'],
  rejected: ['rejected'],
};

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * month + year, or start_date + end_date (inclusive, max 366 days).
 * @returns {{ startDate: string, endDate: string, period: object }}
 */
function resolvePeriod(query) {
  if (query.month && query.year) {
    const { startDate, endDate } = dateHelper.getMonthBounds(query.month, query.year);
    return { startDate, endDate, period: { type: 'month', month: query.month, year: query.year, start_date: startDate, end_date: endDate } };
  }
  const { start_date: startDate, end_date: endDate } = query;
  if (startDate > endDate) throw badRequest('start_date must be on or before end_date.');
  if (dateHelper.daysBetween(startDate, endDate) + 1 > MAX_RANGE_DAYS) {
    throw badRequest(`The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return { startDate, endDate, period: { type: 'range', start_date: startDate, end_date: endDate } };
}

async function buildFilters(query, authContext, companyIds) {
  const { startDate, endDate, period } = resolvePeriod(query);
  let employeeIds;
  let servicePoIds = parseIdList(query.service_po_ids);

  if (authContext.hierarchyRank === PROJECT_MANAGER_RANK) {
    // A Project Manager reviews THEIR projects: every entry on a Service PO
    // they are the flagged Project Manager of (plus those employees' leave,
    // via include_leave) — the same Service-PO-based scope Timesheet Approval
    // uses for this role (employeeServicePOMappingService.
    // getProjectManagerServicePOIds), not the Employee-Master team rule.
    const pmServicePoIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(authContext.employeeId);
    servicePoIds = servicePoIds ? servicePoIds.filter((id) => pmServicePoIds.includes(id)) : pmServicePoIds;
    employeeIds = servicePoIds.length ? null : [];
  } else {
    const scopedCompanyIds = await applyEntityBuFilters(companyIds || [], query);
    employeeIds = await resolveAuthorizedEmployeeIds(authContext, scopedCompanyIds);
  }

  return {
    period,
    filters: {
      employeeIds,
      startDate,
      endDate,
      projectIds: parseIdList(query.project_ids),
      servicePoIds,
      clientIds: parseIdList(query.client_ids),
      filterEmployeeIds: parseIdList(query.employee_ids),
      statuses: STATUS_FILTER[query.approval_status || 'all'],
      includeLeave: query.include_leave !== false,
      search: query.search || null,
    },
  };
}

const num = (v) => Number.parseFloat(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;
// An empty (not null) employee scope = nothing this caller may see.
const hasNoAccess = (filters) => Array.isArray(filters.employeeIds) && filters.employeeIds.length === 0;

/** API/export shape of one entry. */
function toRecord(row) {
  const hours = num(row.hours);
  const isLeave = row.is_leave === true;
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_code: row.employee_code,
    employee_name: row.employee_name,
    date: row.work_date,
    day: row.day_name,
    entry_type: row.log_type === 'monthly' ? 'Monthly' : 'Daily',
    client_name: row.client_name,
    project_id: row.project_id,
    project_code: row.project_code,
    project_name: isLeave ? (row.project_name || 'Leave') : row.project_name,
    service_po_id: row.service_po_id,
    service_po_code: row.service_po_code,
    service_po_name: row.service_po_name,
    business_unit: row.business_unit,
    sub_project: row.sub_project_name,
    module: row.module_name,
    task: row.task_name,
    work_type: isLeave ? 'Leave' : 'Project Work',
    is_leave: isLeave,
    logged_hours: isLeave ? 0 : hours,
    leave_hours: isLeave ? hours : 0,
    total_hours: hours,
    description: row.description,
    time_slots: row.time_slots,
    project_managers: row.project_managers,
    approval_status: row.status,
    approval_status_label: STATUS_LABELS[row.status] || row.status,
    rejection_remark: row.rejection_remark,
  };
}

function toTotals(t) {
  return {
    entry_count: t.entry_count,
    employee_count: t.employee_count,
    logged_hours: num(t.logged_hours),
    leave_hours: num(t.leave_hours),
    total_hours: round2(num(t.logged_hours) + num(t.leave_hours)),
    approved_hours: num(t.approved_hours),
    pending_hours: num(t.pending_hours),
    rejected_hours: num(t.rejected_hours),
  };
}

const numberFields = (row, fields) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fields.includes(k) ? num(v) : v]));
const HOUR_FIELDS = ['logged_hours', 'leave_hours', 'total_hours', 'approved_hours', 'pending_hours', 'rejected_hours'];

/**
 * JSON view: one page of entries + totals for the whole filtered set;
 * `include_summary` adds the project-wise and employee-wise summaries.
 */
async function getReport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  const page = query.page || 1;
  const limit = query.limit || 50;

  if (hasNoAccess(filters)) {
    const empty = { entry_count: 0, employee_count: 0, logged_hours: 0, leave_hours: 0, approved_hours: 0, pending_hours: 0, rejected_hours: 0 };
    return { period, totals: toTotals(empty), records: [], summary: query.include_summary ? { projects: [], employees: [] } : undefined, meta: getPaginationMeta(0, page, limit) };
  }

  const [rows, totals, projects, employees] = await Promise.all([
    repository.findRows(filters, { sortBy: query.sort_by, limit, offset: (page - 1) * limit }),
    repository.getTotals(filters),
    query.include_summary ? repository.getProjectSummary(filters) : null,
    query.include_summary ? repository.getEmployeeSummary(filters) : null,
  ]);

  return {
    period,
    totals: toTotals(totals),
    records: rows.map(toRecord),
    summary: query.include_summary
      ? {
        projects: projects.map((r) => numberFields(r, HOUR_FIELDS)),
        employees: employees.map((r) => numberFields(r, HOUR_FIELDS)),
      }
      : undefined,
    meta: getPaginationMeta(totals.entry_count, page, limit),
  };
}

const DETAIL_COLUMNS = [
  { key: 'employee_code', label: 'Employee ID', width: 14 },
  { key: 'employee_name', label: 'Employee Name', width: 26 },
  { key: 'date', label: 'Date', width: 12 },
  { key: 'day', label: 'Day', width: 11 },
  { key: 'client_name', label: 'Client', width: 26 },
  { key: 'project_name', label: 'Project', width: 28 },
  { key: 'service_po_code', label: 'Service PO No.', width: 16 },
  { key: 'service_po_name', label: 'Service PO', width: 28 },
  { key: 'business_unit', label: 'Business Unit', width: 20 },
  { key: 'module', label: 'Module', width: 18 },
  { key: 'task', label: 'Task', width: 18 },
  { key: 'work_type', label: 'Work Type', width: 13 },
  { key: 'logged_hours', label: 'Logged Hours', width: 13, numFmt: '0.00' },
  { key: 'leave_hours', label: 'Leave Hours', width: 12, numFmt: '0.00' },
  { key: 'description', label: 'Activity / Work Description', width: 60 },
  { key: 'time_slots', label: 'Time Slots', width: 36 },
  { key: 'project_managers', label: 'Project Manager', width: 26 },
  { key: 'approval_status_label', label: 'Approval Status', width: 18 },
  { key: 'rejection_remark', label: 'Rejection Remark', width: 30 },
  { key: 'entry_type', label: 'Entry Type', width: 11 },
];

const PROJECT_SUMMARY_COLUMNS = [
  { key: 'client_name', label: 'Client', width: 26 },
  { key: 'project_name', label: 'Project', width: 28 },
  { key: 'service_po_code', label: 'Service PO No.', width: 16 },
  { key: 'service_po_name', label: 'Service PO', width: 28 },
  { key: 'employee_code', label: 'Employee ID', width: 14 },
  { key: 'employee_name', label: 'Employee Name', width: 26 },
  { key: 'days_logged', label: 'Days Logged', width: 12 },
  { key: 'logged_hours', label: 'Logged Hours', width: 13, numFmt: '0.00' },
  { key: 'approved_hours', label: 'Approved Hours', width: 14, numFmt: '0.00' },
  { key: 'pending_hours', label: 'Pending Hours', width: 14, numFmt: '0.00' },
  { key: 'rejected_hours', label: 'Rejected Hours', width: 14, numFmt: '0.00' },
];

const EMPLOYEE_SUMMARY_COLUMNS = [
  { key: 'employee_code', label: 'Employee ID', width: 14 },
  { key: 'employee_name', label: 'Employee Name', width: 26 },
  { key: 'days_logged', label: 'Days Logged', width: 12 },
  { key: 'service_po_count', label: 'Service POs', width: 12 },
  { key: 'logged_hours', label: 'Logged Hours', width: 13, numFmt: '0.00' },
  { key: 'leave_hours', label: 'Leave Hours', width: 12, numFmt: '0.00' },
  { key: 'total_hours', label: 'Total Hours', width: 12, numFmt: '0.00' },
  { key: 'approved_hours', label: 'Approved Hours', width: 14, numFmt: '0.00' },
  { key: 'pending_hours', label: 'Pending Hours', width: 14, numFmt: '0.00' },
  { key: 'rejected_hours', label: 'Rejected Hours', width: 14, numFmt: '0.00' },
];

/**
 * Download view: every matching entry (capped at MAX_EXPORT_ROWS) plus both
 * summaries, as sheets for toMultiSheetExcelBuffer (CSV uses details only).
 */
async function getExport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  if (hasNoAccess(filters)) {
    return { period, sheets: [
      { name: 'Timesheet Details', columns: DETAIL_COLUMNS, rows: [] },
      { name: 'Project Summary', columns: PROJECT_SUMMARY_COLUMNS, rows: [] },
      { name: 'Employee Summary', columns: EMPLOYEE_SUMMARY_COLUMNS, rows: [] },
    ] };
  }

  const totals = await repository.getTotals(filters);
  if (totals.entry_count > MAX_EXPORT_ROWS) {
    throw badRequest(`This download would contain ${totals.entry_count} entries (maximum ${MAX_EXPORT_ROWS}). Narrow the period or filters.`);
  }

  const [rows, projects, employees] = await Promise.all([
    repository.findRows(filters, { sortBy: query.sort_by }),
    repository.getProjectSummary(filters),
    repository.getEmployeeSummary(filters),
  ]);

  return {
    period,
    sheets: [
      { name: 'Timesheet Details', columns: DETAIL_COLUMNS, rows: rows.map(toRecord) },
      { name: 'Project Summary', columns: PROJECT_SUMMARY_COLUMNS, rows: projects.map((r) => numberFields(r, HOUR_FIELDS)) },
      { name: 'Employee Summary', columns: EMPLOYEE_SUMMARY_COLUMNS, rows: employees.map((r) => numberFields(r, HOUR_FIELDS)) },
    ],
  };
}

module.exports = { getReport, getExport, resolvePeriod, toRecord, DETAIL_COLUMNS };
