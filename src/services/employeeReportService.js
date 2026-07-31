'use strict';

const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const dateHelper = require('../helpers/dateHelper');

/**
 * Employee Reports Service (Employee Self Timesheet module)
 *
 * REDESIGN NOTE: reads exclusively from `employee_work_logs`
 * (employeeWorkLogRepository.getReportRows) — NEVER from `timesheets`.
 * Admin Reports (reportController.js/reportService.js/reportRepository.js)
 * continue to read `timesheets` unchanged; the two data sources are never
 * mixed. Every call here forces employeeId to the logged-in employee's own
 * ID, so an employee can never see another employee's data.
 */

const REPORT_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'project', label: 'Project' },
  { key: 'servicePO', label: 'Service PO' },
  { key: 'hours', label: 'Hours' },
  { key: 'description', label: 'Description' },
  { key: 'status', label: 'Sync Status' },
];

function mapRows(workLogs) {
  return workLogs.map((log) => ({
    date: log.work_date,
    project: log.servicePO?.service_po_name,
    servicePO: log.servicePO?.service_po_code,
    hours: parseFloat(log.hours) || 0,
    description: log.description || '',
    status: log.status,
  }));
}

async function runReport(employeeId, companyId, startDate, endDate) {
  const workLogs = await employeeWorkLogRepository.getReportRows({ employeeId, companyId, startDate, endDate });

  const mapped = mapRows(workLogs);
  const totalHours = mapped.reduce((sum, r) => sum + r.hours, 0);

  return { rows: mapped, totalHours: Math.round(totalHours * 100) / 100, columns: REPORT_COLUMNS };
}

/**
 * Daily report — one specific date.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} date - "YYYY-MM-DD"
 */
const getDailyReport = async (employeeId, companyId, date) => {
  return runReport(employeeId, companyId, date, date);
};

/**
 * Monthly report — one calendar month.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 */
const getMonthlyReport = async (employeeId, companyId, month, year) => {
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  return runReport(employeeId, companyId, startDate, endDate);
};

/**
 * Date-range report — arbitrary start/end.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} startDate
 * @param {string} endDate
 */
const getDateRangeReport = async (employeeId, companyId, startDate, endDate) => {
  return runReport(employeeId, companyId, startDate, endDate);
};

module.exports = {
  getDailyReport,
  getMonthlyReport,
  getDateRangeReport,
  REPORT_COLUMNS,
};
