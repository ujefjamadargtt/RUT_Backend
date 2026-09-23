'use strict';

const managementReportService = require('../services/managementReportService');
const { sendPaginated, sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const { toGroupedExcelBuffer } = require('../utils/reportExporter');

/**
 * Management Report Controller
 * The 10 new management/business reports approved on top of the existing
 * Report module. Each method maps 1:1 with a route in
 * managementReport.routes.js. All are GET-only endpoints.
 */

function buildHandler(name, serviceFn, { useReq = false } = {}) {
  return async function handler(req, res, next) {
    try {
      const filters = { ...req.body, ...req.query };
      const result = useReq
        ? await serviceFn(filters, req)
        : await serviceFn(filters, req.companyIds);
      const { data, meta, ...rest } = result;
      return sendPaginated(res, { records: data, ...rest }, meta, `${name} fetched successfully.`);
    } catch (err) {
      if (err.statusCode) {
        return sendError(res, err.message, err.statusCode);
      }
      logger.error(`${name} error`, { error: err.message, stack: err.stack });
      next(err);
    }
  };
}

const getServicePOProfitability = buildHandler('Service PO Profitability report', managementReportService.getServicePOProfitability);
const getBudgetedMarginForecast = buildHandler('Budgeted Margin Forecast report', managementReportService.getBudgetedMarginForecast);
const getResourceStaffingPlanAccuracy = buildHandler('Resource Staffing Plan Accuracy report', managementReportService.getResourceStaffingPlanAccuracy);
const getClientProfitabilityConcentration = buildHandler('Client Profitability & Concentration report', managementReportService.getClientProfitabilityConcentration);
const getBUPerformanceScorecard = buildHandler('BU Performance Scorecard', managementReportService.getBUPerformanceScorecard, { useReq: true });
const getEmployeeCapacityForecast = buildHandler('Employee Capacity & Bench Forecast report', managementReportService.getEmployeeCapacityForecast);
const getServicePOTimelineRisk = buildHandler('Service PO Budget & Timeline Risk report', managementReportService.getServicePOTimelineRisk);
const getDeliveryHeadPerformance = buildHandler('Delivery Head Performance report', managementReportService.getDeliveryHeadPerformance);
const getInvoiceRealizationTrend = buildHandler('Invoice Realization / Billing Efficiency report', managementReportService.getInvoiceRealizationTrend);
const getPMWiseUtilization = buildHandler('Project Manager-wise Utilization report', managementReportService.getPMWiseUtilization);
const getProjectWiseUtilization = buildHandler('Project-wise Utilization report', managementReportService.getProjectWiseUtilization);
const getResourceWiseBench = buildHandler('Resource-wise Bench % report', managementReportService.getResourceWiseBench);
const getResourceCostUtilization = buildHandler('Resource Cost / Utilization report', managementReportService.getResourceCostUtilization);

/**
 * Month-wise Bench is a small, fixed-size result (one row per calendar
 * month in the requested range, never paginated) — same reasoning as
 * getServiceLineBusinessMix below, uses sendSuccess directly rather than
 * the paginated buildHandler/sendPaginated helper.
 */
async function getMonthWiseBench(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const result = await managementReportService.getMonthWiseBench(filters, req.companyIds);
    return sendSuccess(res, result, 'Month-wise Bench report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getMonthWiseBench error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * Report 10 is not paginated (small, fixed-size result set — one row per
 * service category x service type combination) so it uses sendSuccess
 * directly instead of the shared buildHandler/sendPaginated helper.
 */
async function getServiceLineBusinessMix(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const result = await managementReportService.getServiceLineBusinessMix(filters, req.companyIds);
    return sendSuccess(res, result, 'Service Line Business Mix report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getServiceLineBusinessMix error', { error: err.message, stack: err.stack });
    next(err);
  }
}

const MONTH_NAMES_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const CAPPED_MONTHLY_HOURS = 176;

/**
 * GET /reports/resource-cost-utilization/export
 * Excel download of the FULL filtered dataset (not just one page) — same
 * static Emp Code/Emp Name/Expected CTC/Monthly CTC/BU Name/Billed Status/
 * Project Manager/Client/Project/SPO columns as the JSON endpoint, followed
 * by one merged column-group per month in the selected range (Hours/Logged
 * Hrs/Utilization % - Projection/Utilization % - Actual/Contribution).
 * Expected CTC and Billed Status are intentionally left blank — see
 * managementReportService's buildResourceCostUtilization() doc comment —
 * for the user to fill in after download; never persisted back.
 */
async function exportResourceCostUtilization(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, period } = await managementReportService.exportResourceCostUtilization(filters, req.companyIds);

    const staticColumns = [
      { key: 'empCode', label: 'Emp Code', width: 14 },
      { key: 'empName', label: 'Emp Name', width: 24 },
      { key: 'expectedCtc', label: 'Expected CTC', width: 14, numFmt: '#,##0.00' },
      { key: 'monthlyCtc', label: 'Monthly CTC', width: 14, numFmt: '#,##0.00' },
      { key: 'buName', label: 'BU Name', width: 16 },
      { key: 'billedStatus', label: 'Billed Status', width: 14 },
      { key: 'projectManager', label: 'Project Manager', width: 24 },
      { key: 'client', label: 'Client', width: 20 },
      { key: 'project', label: 'Project', width: 20 },
      { key: 'spo', label: 'SPO', width: 20 },
    ];

    // Walked chronologically from the resolved period — never hardcoded,
    // never alphabetically sorted, correctly threads a year boundary (e.g.
    // Nov 2026 -> Feb 2027 yields Nov, Dec, Jan, Feb in that order).
    const monthSequence = [];
    {
      let m = period.startMonth;
      let y = period.startYear;
      while (y < period.endYear || (y === period.endYear && m <= period.endMonth)) {
        monthSequence.push({ month: m, year: y });
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    }

    // A range spanning more than one calendar year disambiguates repeating
    // month names with a 2-digit year suffix (APR-26 vs APR-27); a
    // same-year range keeps the plain APR/MAY/JUN convention from the
    // reference layout.
    const spansYears = period.startYear !== period.endYear;
    const monthGroupLabel = (month, year) => (
      spansYears ? `${MONTH_NAMES_UPPER[month - 1]}-${String(year).slice(2)}` : MONTH_NAMES_UPPER[month - 1]
    );

    const monthColumns = [];
    monthSequence.forEach(({ month, year }) => {
      const group = monthGroupLabel(month, year);
      const prefix = `m_${year}_${month}`;
      monthColumns.push(
        { key: `${prefix}_hours`, label: 'Hours', group, width: 10, numFmt: '0.00' },
        { key: `${prefix}_logged`, label: 'Logged Hrs', group, width: 12, numFmt: '0.00' },
        { key: `${prefix}_projection`, label: 'Utilization % - Projection', group, width: 15, numFmt: '0.00"%"' },
        { key: `${prefix}_actual`, label: 'Utilization % - Actual', group, width: 15, numFmt: '0.00"%"' },
        { key: `${prefix}_contribution`, label: 'Contribution', group, width: 14, numFmt: '#,##0.00' }
      );
    });

    const columns = [...staticColumns, ...monthColumns];

    const rows = data.map((emp) => {
      const row = {
        empCode: emp.employeeCode,
        empName: emp.employeeName,
        expectedCtc: null,
        monthlyCtc: emp.monthlyCtc,
        buName: emp.buName,
        billedStatus: null,
        projectManager: (emp.projectManagers || []).join(', '),
        client: emp.client,
        project: emp.project,
        spo: emp.spo,
      };
      const byMonth = new Map((emp.months || []).map((mo) => [`${mo.year}_${mo.monthNumber}`, mo]));
      monthSequence.forEach(({ month, year }) => {
        const prefix = `m_${year}_${month}`;
        const mo = byMonth.get(`${year}_${month}`);
        row[`${prefix}_hours`] = mo ? mo.cappedHours : CAPPED_MONTHLY_HOURS;
        row[`${prefix}_logged`] = mo ? mo.loggedHours : 0;
        row[`${prefix}_projection`] = mo ? mo.projectionPercentage : 0;
        row[`${prefix}_actual`] = mo ? mo.actualPercentage : 0;
        row[`${prefix}_contribution`] = mo ? mo.contribution : 0;
      });
      return row;
    });

    // No freeze pane at all, per explicit request — neither the static
    // employee columns nor the header rows are pinned; everything scrolls
    // together. Merged month headers are unaffected either way.
    const buffer = await toGroupedExcelBuffer(rows, columns, 'Resource Cost Utilization');

    const filenameSuffix = `${MONTH_NAMES_UPPER[period.startMonth - 1]}${period.startYear}-${MONTH_NAMES_UPPER[period.endMonth - 1]}${period.endYear}`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="resource-cost-utilization-${filenameSuffix}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('exportResourceCostUtilization error', { error: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = {
  getServicePOProfitability,
  getBudgetedMarginForecast,
  getResourceStaffingPlanAccuracy,
  getClientProfitabilityConcentration,
  getBUPerformanceScorecard,
  getEmployeeCapacityForecast,
  getServicePOTimelineRisk,
  getDeliveryHeadPerformance,
  getInvoiceRealizationTrend,
  getServiceLineBusinessMix,
  getPMWiseUtilization,
  getProjectWiseUtilization,
  getMonthWiseBench,
  getResourceWiseBench,
  getResourceCostUtilization,
  exportResourceCostUtilization,
};
