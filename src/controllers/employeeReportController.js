'use strict';

const employeeReportService = require('../services/employeeReportService');
const employeeProjectHoursReportService = require('../services/employeeProjectHoursReportService');
const timesheetApprovalReportService = require('../services/timesheetApprovalReportService');
const { toExcelBuffer, toCsvExportBuffer, toPdfBuffer } = require('../utils/reportExporter');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * Employee Report Controller (Employee Self Timesheet module)
 * Thin layer: parse request -> call service -> respond as JSON or a file.
 */

async function respond(res, format, title, filenamePrefix, result) {
  const { rows, totalHours, columns } = result;

  if (format === 'json') {
    return sendSuccess(res, { rows, totalHours }, `${title} fetched successfully.`);
  }

  let buffer;
  let contentType;
  let extension;

  if (format === 'excel') {
    buffer = await toExcelBuffer(rows, columns, title);
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    extension = 'xlsx';
  } else if (format === 'csv') {
    buffer = toCsvExportBuffer(rows, columns);
    contentType = 'text/csv';
    extension = 'csv';
  } else if (format === 'pdf') {
    buffer = await toPdfBuffer(rows, columns, title);
    contentType = 'application/pdf';
    extension = 'pdf';
  } else {
    return sendError(res, 'Invalid format. Use json, excel, csv, or pdf.', 400);
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filenamePrefix}.${extension}"`);
  return res.send(buffer);
}

/**
 * GET /api/v1/employee-reports/daily?date=YYYY-MM-DD&format=json|excel|csv|pdf
 */
const getDaily = async (req, res, next) => {
  try {
    const { date, format = 'json' } = req.query;
    const result = await employeeReportService.getDailyReport(req.employeeId, req.companyId, date);
    return await respond(res, format, 'Daily Timesheet Report', `daily-report-${date}`, result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/employee-reports/monthly?month=&year=&format=
 */
const getMonthly = async (req, res, next) => {
  try {
    const { month, year, format = 'json' } = req.query;
    const result = await employeeReportService.getMonthlyReport(req.employeeId, req.companyId, month, year);
    return await respond(res, format, 'Monthly Timesheet Report', `monthly-report-${year}-${month}`, result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/employee-reports/range?startDate=&endDate=&format=
 */
const getRange = async (req, res, next) => {
  try {
    const { startDate, endDate, format = 'json' } = req.query;
    const result = await employeeReportService.getDateRangeReport(req.employeeId, req.companyId, startDate, endDate);
    return await respond(res, format, 'Date Range Timesheet Report', `range-report-${startDate}-to-${endDate}`, result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/employee-reports/project-hours
 * Project -> Service PO -> Parent -> Child hours report, for one of
 * {date} | {month & year} | {startDate & endDate}, optionally narrowed to
 * one mapped service_po_id or project_id. JSON only (no excel/csv/pdf export
 * — this is a hierarchical report, not the flat rows respond() exports).
 */
const getProjectHours = async (req, res, next) => {
  try {
    const result = await employeeProjectHoursReportService.getReport(req.employeeId, req.companyId, req.query);
    return sendSuccess(res, result, 'Employee project hours report fetched successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    next(err);
  }
};

/**
 * GET /api/v1/employee-reports/project-hours/filter-tree
 * The Project -> Service PO -> Parent -> Child structural tree (no hours) —
 * the data source for the report's Service PO/Project filter dropdown.
 */
const getProjectHoursFilterTree = async (req, res, next) => {
  try {
    const data = await employeeProjectHoursReportService.getFilterTree(req.employeeId, req.companyId);
    return sendSuccess(res, data, 'Project/Service PO filter tree fetched successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    next(err);
  }
};

/**
 * GET /api/v1/employee-reports/timesheet-approval-status
 * Timesheet hours + approval status, with the full Project -> Service PO ->
 * Parent -> Child hierarchy, for the caller's own records — or, if the
 * caller is a Manager (manager_employee_mappings actually maps someone to
 * them), their whole mapped team or one specific mapped employee_id.
 */
const getTimesheetApprovalStatus = async (req, res, next) => {
  try {
    const result = await timesheetApprovalReportService.getReport(req.userId, req.employeeId, req.companyId, req.query);
    return sendSuccess(res, result, 'Timesheet approval status report fetched successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    next(err);
  }
};

module.exports = {
  getDaily,
  getMonthly,
  getRange,
  getProjectHours,
  getProjectHoursFilterTree,
  getTimesheetApprovalStatus,
};
