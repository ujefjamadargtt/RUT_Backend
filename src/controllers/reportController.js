'use strict';

const reportService = require('../services/reportService');
const { sendPaginated, sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const employeeWorkLogHoursSummaryService = require('../services/employeeWorkLogHoursSummaryService');

/**
 * Report Controller
 * Each method maps 1:1 with a report route. All are GET-only endpoints.
 */

/**
 * GET /api/v1/reports/employee-hourly-rate
 * Roles: Finance, Management
 *
 * Query params:
 *   month (required), year (required), employeeId, search,
 *   sortBy, sortOrder, page, limit
 */
async function getEmployeeHourlyRate(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getEmployeeHourlyRate(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Employee hourly rate report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getEmployeeHourlyRate error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/employee-work-log-hours-summary
 * One aggregated row per authorized employee for a date or calendar month.
 */
async function getEmployeeWorkLogHoursSummary(req, res, next) {
  try {
    const result = await employeeWorkLogHoursSummaryService.getSummary(
      req.query,
      {
        userId: req.userId,
        employeeId: req.employeeId,
        hierarchyRank: req.hierarchyRank,
        roleNames: req.userRoles,
      },
      req.companyIds
    );
    return sendPaginated(res, { period: result.period, records: result.data }, result.meta,
      'Employee work log hours summary fetched successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('getEmployeeWorkLogHoursSummary error', { error: err.message, stack: err.stack });
    return next(err);
  }
}

/**
 * GET /api/v1/reports/employee-work-log-hours-summary/:employeeId/details
 * Detail rows are authorized independently from the summary row selection.
 */
async function getEmployeeWorkLogHoursSummaryDetails(req, res, next) {
  try {
    const result = await employeeWorkLogHoursSummaryService.getDetails(
      req.params.employeeId,
      req.query,
      {
        userId: req.userId,
        employeeId: req.employeeId,
        hierarchyRank: req.hierarchyRank,
        roleNames: req.userRoles,
      },
      req.companyIds
    );
    const { meta, ...data } = result;
    return sendPaginated(res, data, meta, 'Employee work log history fetched successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('getEmployeeWorkLogHoursSummaryDetails error', { error: err.message, stack: err.stack });
    return next(err);
  }
}

/**
 * GET /api/v1/reports/monthly-cost-summary
 * Roles: Finance, Management
 *
 * Query params:
 *   year, month, sortBy, sortOrder, page, limit
 */
async function getMonthlyCostSummary(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getMonthlyCostSummary(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Monthly cost summary fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getMonthlyCostSummary error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/timesheet-summary
 * Roles: Finance, Management, HR, Division Head
 *
 * Query params:
 *   startDate, endDate, employeeId, poId, search,
 *   sortBy, sortOrder, page, limit
 */
async function getTimesheetSummary(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getTimesheetSummary(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Timesheet summary fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getTimesheetSummary error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/service-po-utilisation
 * Roles: Finance, Management, Project Manager
 *
 * Query params:
 *   startDate, endDate, poId, status, search,
 *   sortBy, sortOrder, page, limit
 */
async function getServicePOUtilisation(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getServicePOUtilisation(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Service PO utilisation report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getServicePOUtilisation error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/sub-project-hours
 * Roles: Finance, Management, Project Manager
 *
 * Query params:
 *   poId, startDate, endDate, status, search,
 *   sortBy, sortOrder, page, limit
 */
async function getSubProjectHours(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getSubProjectHours(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Sub-project hours report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getSubProjectHours error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/resource-allocation
 * Roles: HR, Management, Division Head
 *
 * Query params:
 *   employeeId, poId (service PO / project), clientId, month, year, status,
 *   isBillable, serviceCategoryId, serviceTypeId, search,
 *   sortBy, sortOrder, page, limit
 */
async function getResourceAllocation(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getResourceAllocation(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Resource allocation report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getResourceAllocation error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/operational-cost-breakdown
 * Roles: Finance, Management
 *
 * Query params:
 *   year, month, employeeId, search,
 *   sortBy, sortOrder, page, limit
 */
async function getOperationalCostBreakdown(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getOperationalCostBreakdown(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Operational cost breakdown fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getOperationalCostBreakdown error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/employee-utilization-summary
 * Roles: Finance, Management, HR, Division Head
 *
 * Query params:
 *   month (required), year (required), employeeId, search,
 *   sortBy, sortOrder, page, limit
 */
async function getEmployeeUtilizationSummary(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getEmployeeUtilizationSummary(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Employee utilization summary fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getEmployeeUtilizationSummary error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/service-po-summary
 * Roles: Finance, Management, Division Head
 *
 * Query params:
 *   month (required), year (required), status, clientId, is_billable,
 *   serviceCategoryId, serviceTypeId, poId,
 *   search, sortBy, sortOrder, page, limit
 */
async function getServicePOSummary(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getServicePOSummary(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Service PO summary report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getServicePOSummary error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/invoice-po-summary
 * Roles: Finance, Management, Division Head
 *
 * Replica of /service-po-summary with the same filters/structure, but
 * invoiced_amount/billed_amount/unbilled_amount come from the Service PO
 * Monthly Budget master (service_po_monthly_budgets) instead of being
 * computed from timesheets/monthly_costs. Separate from and does not
 * affect getServicePOSummary.
 *
 * Query params:
 *   month (required), year (required), status, clientId, is_billable,
 *   serviceCategoryId, serviceTypeId, poId,
 *   search, sortBy, sortOrder, page, limit
 */
async function getInvoicePOSummary(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, summary } = await reportService.getInvoicePOSummary(filters, req.companyIds);
    const response = { records: data, summary };
    return sendPaginated(res, response, meta, 'Invoice PO summary report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getInvoicePOSummary error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/resource-utilization
 * Roles: HR, Management, Division Head
 *
 * Query params:
 *   month (required), year (required), employeeId, search, page, limit
 */
async function getResourceUtilization(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { columns, data, meta, summary } = await reportService.getResourceUtilization(filters, req.companyIds);
    return sendPaginated(res, { columns, records: data, summary }, meta, 'Resource utilization report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getResourceUtilization error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/monthly-resource-utilization
 * Roles: HR, Management, Division Head
 *
 * Returns full employee detail (experience, resource description, client, capacity)
 * pivoted with dynamic service-category → service-type hour columns.
 *
 * Query params:
 *   month (required), year (required), employeeId, search, page, limit
 */
async function getMonthlyResourceUtilization(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { columns, data, meta, summary } = await reportService.getMonthlyResourceUtilization(filters, req.companyIds);
    return sendPaginated(res, { columns, records: data, summary }, meta, 'Monthly resource utilization report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getMonthlyResourceUtilization error', { error: err.message, stack: err.stack });
    next(err);
  }
}

async function getResourseProjectUtilizationReport(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getResourseProjectUtilizationReport(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Employee resource utilization report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getResourseProjectUtilizationReport error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/client-service-po-hours
 *
 * Query params:
 *   month + year, OR startDate + endDate (exactly one mode, required),
 *   clientId, poId (project), serviceTypeId, employeeId, status
 *
 * Independent of the Dashboard's "Client x Service PO (Hours)" chart
 * (getAnalyticsDashboard/getAnalyticsClientByPO) — not called by it, does
 * not modify it. Not paginated — one row per Client, each with a nested
 * service_pos array.
 */
async function getClientServicePOHoursReport(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const data = await reportService.getClientServicePOHoursReport(filters, req.companyIds);
    return sendSuccess(res, data, 'Client Service PO Hours Report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getClientServicePOHoursReport error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/client-cost-analytics
 *
 * Query params: hoursSource, page, limit (page/limit apply only to the
 * top_clients ranking within the response, default limit 15)
 *
 * Based on Dashboard analytics2's client_wise_cost_analytics +
 * top_clients_by_cost + client_category_cost_matrix reports — always the
 * complete, unfiltered, all-time dataset, matching the Dashboard's own scope.
 */
async function getClientCostAnalytics(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const data = await reportService.getClientCostAnalytics(filters, req.companyIds);
    return sendSuccess(res, data, 'Client cost analytics report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getClientCostAnalytics error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/client-wise-analytics
 *
 * Query params: month + year, OR startDate + endDate (exactly one mode,
 * required), employeeId, clientId, poId, serviceTypeId, page, limit,
 * sortBy, sortOrder
 *
 * Based on Dashboard analytics2's client_wise_analytics report.
 */
async function getClientWiseAnalytics(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getClientWiseAnalyticsReport(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Client wise analytics report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getClientWiseAnalytics error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/monthly-hours-trend
 *
 * Query params: month + year, OR startDate + endDate (exactly one mode,
 * required), employeeId, clientId, poId, serviceTypeId
 *
 * Based on Dashboard analytics' monthly_hours_trend chart and analytics2's
 * monthly_resource_utilization/leave_hours_trend/no_work_trend reports,
 * bundled into one report (all four are month-by-month trends sharing the
 * same period/filter resolution). Not paginated — a fixed-size series
 * spanning the resolved period.
 */
async function getMonthlyHoursTrend(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const data = await reportService.getMonthlyHoursTrend(filters, req.companyIds);
    return sendSuccess(res, data, 'Monthly hours trend report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getMonthlyHoursTrend error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/employee-bench-percentage
 *
 * Query params: month + year, OR startDate + endDate (exactly one mode,
 * required), employeeId, clientId, poId, page, limit, sortBy, sortOrder
 *
 * Based on Dashboard analytics' employee_bench_pct chart.
 */
async function getEmployeeBenchPercentage(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getEmployeeBenchPercentage(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Employee bench percentage report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getEmployeeBenchPercentage error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/budget-vs-billed
 *
 * Query params: month + year, OR startDate + endDate (exactly one mode,
 * required), clientId, poId, serviceTypeId, page, limit (apply to
 * by_service_po only), sortBy, sortOrder
 *
 * Based on Dashboard analytics2's budget_vs_billed report — Budget Cost
 * (cost_budget_master.invoice_amount) vs Actual Billed Amount
 * (service_po_monthly_budgets.billed_amount).
 */
async function getBudgetVsBilled(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const data = await reportService.getBudgetVsBilledReport(filters, req.companyIds);
    return sendSuccess(res, data, 'Budget vs Billed report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getBudgetVsBilled error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/resource-utilization-trend
 *
 * Query params: month + year, OR startDate + endDate (exactly one mode,
 * required), employeeId, clientId, poId, serviceTypeId, hoursSource,
 * roleId, page, limit, sortBy, sortOrder
 *
 * The existing Utilization Trend formula (Billable Hours / Total Hours ×
 * 100), grouped by Month + Resource instead of Month only.
 */
async function getResourceUtilizationTrend(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getResourceUtilizationTrendReport(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Resource utilization trend report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getResourceUtilizationTrend error', { error: err.message, stack: err.stack });
    next(err);
  }
}

/**
 * GET /api/v1/reports/service-po-hours-budget
 *
 * Query params: month + year, OR startDate + endDate (exactly one mode,
 * required), employeeId, clientId, poId, serviceTypeId, hoursSource,
 * roleId, page, limit, sortBy, sortOrder
 *
 * Total PO Hours (existing timesheet-hours logic) and Cost Budget
 * (cost_budget_master.invoice_amount for that PO + month), per Month +
 * Service PO.
 */
async function getServicePOHoursBudget(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await reportService.getServicePOHoursBudgetReport(filters, req.companyIds);
    return sendPaginated(res, data, meta, 'Service PO hours & cost budget report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getServicePOHoursBudget error', { error: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = {
  getEmployeeWorkLogHoursSummary,
  getEmployeeWorkLogHoursSummaryDetails,
  getEmployeeHourlyRate,
  getMonthlyCostSummary,
  getTimesheetSummary,
  getServicePOUtilisation,
  getSubProjectHours,
  getResourceAllocation,
  getOperationalCostBreakdown,
  getEmployeeUtilizationSummary,
  getServicePOSummary,
  getInvoicePOSummary,
  getResourceUtilization,
  getMonthlyResourceUtilization,
  getResourseProjectUtilizationReport,
  getClientServicePOHoursReport,
  getClientCostAnalytics,
  getClientWiseAnalytics,
  getMonthlyHoursTrend,
  getResourceUtilizationTrend,
  getServicePOHoursBudget,
  getEmployeeBenchPercentage,
  getBudgetVsBilled,
};
