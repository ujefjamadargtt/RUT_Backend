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

// Daily report only — no description/status (see getDailyReport()). Monthly/
// Range keep the full REPORT_COLUMNS above, untouched.
const DAILY_REPORT_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'project', label: 'Project' },
  { key: 'servicePO', label: 'Service PO' },
  { key: 'hours', label: 'Hours' },
];

/**
 * Aggregate raw employee_work_logs rows into ONE row per (date,
 * service_po_id) — the Daily Employee Report must never show a separate row
 * per Service PO Hierarchy node (Parent/Child). A single Service PO can now
 * have multiple employee_work_logs rows for the same date (one per
 * hierarchy_node_id, including the direct/no-node entry — see
 * uq_employee_work_logs), and this collapses all of them into one report
 * row, summing hours across the Service PO's own entry plus every Parent/
 * Child entry logged against it that day. Monthly (aggregateMonthlyRowsByServicePO)
 * and Date Range (aggregateRangeRowsByServicePO) reports have their own,
 * separate aggregators below with identical grouping logic but keeping
 * description/status — not reused here to avoid coupling this report's
 * changes to theirs.
 *
 * No `description`/`status` in the output — the Daily report doesn't return
 * either (see DAILY_REPORT_COLUMNS); Monthly/Range still do.
 *
 * @param {import('../models').EmployeeWorkLog[]} workLogs
 * @returns {object[]} rows in the Daily report shape (date, project, servicePO, hours)
 */
function aggregateRowsByServicePO(workLogs) {
  const groups = new Map();

  for (const log of workLogs) {
    const key = `${log.work_date}|${log.service_po_id}`;

    if (!groups.has(key)) {
      groups.set(key, {
        date: log.work_date,
        project: log.servicePO?.service_po_name,
        servicePO: log.servicePO?.service_po_code,
        hours: 0,
      });
    }

    groups.get(key).hours += parseFloat(log.hours) || 0;
  }

  return [...groups.values()].map((row) => ({
    ...row,
    hours: Math.round(row.hours * 100) / 100,
  }));
}

/**
 * Daily report — one specific date. Aggregates hierarchy-node rows into one
 * row per Service PO — see aggregateRowsByServicePO().
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} date - "YYYY-MM-DD"
 */
const getDailyReport = async (employeeId, companyId, date) => {
  const workLogs = await employeeWorkLogRepository.getReportRows({ employeeId, startDate: date, endDate: date });

  const aggregated = aggregateRowsByServicePO(workLogs);
  const totalHours = aggregated.reduce((sum, r) => sum + r.hours, 0);

  return { rows: aggregated, totalHours: Math.round(totalHours * 100) / 100, columns: DAILY_REPORT_COLUMNS };
};

/**
 * Aggregate raw employee_work_logs rows into ONE row per (work_date,
 * service_po_id) for the Monthly Employee Report — the same Service PO
 * Hierarchy problem/fix as the Daily/Date Range Employee Reports'
 * aggregators above. Kept as its own function (identical logic to
 * aggregateRangeRowsByServicePO) rather than reused, so this change can
 * never touch the Date Range Employee Report's code path. Grouping includes
 * work_date, so the month aggregates each date independently — the same
 * Service PO on two different dates within the month is always two
 * separate rows, never merged together.
 *
 * description/status: kept exactly as they already were for the MAIN
 * Service PO — the direct (hierarchy_node_id IS NULL) entry's values if one
 * exists, else the first entry's values encountered in the group. Never
 * concatenates or derives anything from Parent/Child entries.
 *
 * @param {import('../models').EmployeeWorkLog[]} workLogs
 * @returns {object[]} rows in the report shape (date, project, servicePO, hours, description, status)
 */
function aggregateMonthlyRowsByServicePO(workLogs) {
  const groups = new Map();

  for (const log of workLogs) {
    const key = `${log.work_date}|${log.service_po_id}`;
    const isDirectEntry = !log.hierarchy_node_id;

    if (!groups.has(key)) {
      groups.set(key, {
        date: log.work_date,
        project: log.servicePO?.service_po_name,
        servicePO: log.servicePO?.service_po_code,
        hours: 0,
        description: log.description || '',
        status: log.status,
        hasDirectEntry: isDirectEntry,
      });
    }

    const group = groups.get(key);
    group.hours += parseFloat(log.hours) || 0;

    if (isDirectEntry && !group.hasDirectEntry) {
      group.description = log.description || '';
      group.status = log.status;
      group.hasDirectEntry = true;
    }
  }

  return [...groups.values()].map(({ hasDirectEntry, ...row }) => ({
    ...row,
    hours: Math.round(row.hours * 100) / 100,
  }));
}

/**
 * Monthly report — one calendar month. Aggregates hierarchy-node rows into
 * one row per (date, Service PO) — see aggregateMonthlyRowsByServicePO().
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 */
const getMonthlyReport = async (employeeId, companyId, month, year) => {
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  const workLogs = await employeeWorkLogRepository.getReportRows({ employeeId, startDate, endDate });

  const aggregated = aggregateMonthlyRowsByServicePO(workLogs);
  const totalHours = aggregated.reduce((sum, r) => sum + r.hours, 0);

  return { rows: aggregated, totalHours: Math.round(totalHours * 100) / 100, columns: REPORT_COLUMNS };
};

/**
 * Aggregate raw employee_work_logs rows into ONE row per (work_date,
 * service_po_id) for the Date Range Employee Report — the same Service PO
 * Hierarchy problem/fix as the Daily Employee Report's
 * aggregateRowsByServicePO() above, but this report still returns
 * description/status (see REPORT_COLUMNS), so it needs its own aggregator
 * rather than reusing that one. Grouping includes work_date, so a range
 * spanning multiple days aggregates each date independently — the same
 * Service PO on two different dates is always two separate rows, never
 * merged together.
 *
 * description/status: kept exactly as they already were for the MAIN
 * Service PO — the direct (hierarchy_node_id IS NULL) entry's values if one
 * exists, else the first entry's values encountered in the group. Never
 * concatenates or derives anything from Parent/Child entries.
 *
 * @param {import('../models').EmployeeWorkLog[]} workLogs
 * @returns {object[]} rows in the report shape (date, project, servicePO, hours, description, status)
 */
function aggregateRangeRowsByServicePO(workLogs) {
  const groups = new Map();

  for (const log of workLogs) {
    const key = `${log.work_date}|${log.service_po_id}`;
    const isDirectEntry = !log.hierarchy_node_id;

    if (!groups.has(key)) {
      groups.set(key, {
        date: log.work_date,
        project: log.servicePO?.service_po_name,
        servicePO: log.servicePO?.service_po_code,
        hours: 0,
        description: log.description || '',
        status: log.status,
        hasDirectEntry: isDirectEntry,
      });
    }

    const group = groups.get(key);
    group.hours += parseFloat(log.hours) || 0;

    if (isDirectEntry && !group.hasDirectEntry) {
      group.description = log.description || '';
      group.status = log.status;
      group.hasDirectEntry = true;
    }
  }

  return [...groups.values()].map(({ hasDirectEntry, ...row }) => ({
    ...row,
    hours: Math.round(row.hours * 100) / 100,
  }));
}

/**
 * Date-range report — arbitrary start/end. Aggregates hierarchy-node rows
 * into one row per (date, Service PO) — see aggregateRangeRowsByServicePO().
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} startDate
 * @param {string} endDate
 */
const getDateRangeReport = async (employeeId, companyId, startDate, endDate) => {
  const workLogs = await employeeWorkLogRepository.getReportRows({ employeeId, startDate, endDate });

  const aggregated = aggregateRangeRowsByServicePO(workLogs);
  const totalHours = aggregated.reduce((sum, r) => sum + r.hours, 0);

  return { rows: aggregated, totalHours: Math.round(totalHours * 100) / 100, columns: REPORT_COLUMNS };
};

module.exports = {
  getDailyReport,
  getMonthlyReport,
  getDateRangeReport,
  REPORT_COLUMNS,
  DAILY_REPORT_COLUMNS,
  aggregateRowsByServicePO,
  aggregateRangeRowsByServicePO,
  aggregateMonthlyRowsByServicePO,
};
