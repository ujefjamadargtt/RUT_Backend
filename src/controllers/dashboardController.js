'use strict';

const dashboardService = require('../services/dashboardService');
const { sendSuccess, sendPaginated } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Dashboard Controller
 */

/**
 * GET /api/v1/dashboard/stats
 * Returns a single consolidated object with all KPIs, chart data, and activity feed.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function getStats(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const stats = await dashboardService.getDashboardStats(filters, req.companyId);
    return sendSuccess(res, stats, 'Dashboard statistics fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getStats error', {
      error: err.message,
      stack: err.stack,
      userId: req.userId,
    });
    next(err);
  }
}

/**
 * GET /api/v1/dashboard/employee-billable-breakdown
 * Per-employee billable vs non-billable hours for a month/year, with the
 * contributing Service POs as the reason for the split.
 */
async function getEmployeeBillableBreakdown(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, period } = await dashboardService.getEmployeeBillableBreakdown(filters, req.companyId);
    return sendPaginated(res, data, { ...meta, period }, 'Employee billable breakdown fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getEmployeeBillableBreakdown error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/dashboard/po-billable-breakdown
 * Per-Service-PO billable/non-billable classification with the service
 * type/category reason behind it.
 */
async function getPOBillableBreakdown(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, period } = await dashboardService.getPOBillableBreakdown(filters, req.companyId);
    return sendPaginated(res, data, { ...meta, period }, 'Service PO billable breakdown fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getPOBillableBreakdown error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/dashboard/top-employees-by-po
 * Top 3 employees by hours logged, per Service PO, for a month/year.
 */
async function getTopEmployeesByPO(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta, period } = await dashboardService.getTopEmployeesByPO(filters, req.companyId);
    return sendPaginated(res, data, { ...meta, period }, 'Top employees by Service PO fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getTopEmployeesByPO error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/dashboard/billable-trend
 * Billable vs non-billable hours trend across the last N months, with each
 * month's change vs the prior month broken down by the Service POs that
 * drove the increase/decrease on each side.
 */
async function getBillableTrend(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const result = await dashboardService.getBillableTrend(filters, req.companyId);
    return sendSuccess(res, result, 'Billable trend fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getBillableTrend error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/dashboard/analytics
 * Full analytics dashboard: 7 stat tiles + Monthly Hours Trend, Hours by
 * Client, Hours by Employee, Client x Service PO, and Employee Bench %
 * charts, all sharing one filter set (fiscal year, quarter, period,
 * employee, client, Service PO).
 */
async function getAnalyticsDashboard(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const result = await dashboardService.getAnalyticsDashboard(filters, req.companyId);
    return sendSuccess(res, result, 'Analytics dashboard fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getAnalyticsDashboard error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

/**
 * GET /api/v1/dashboard/analytics2
 * Monthly Resource Utilization Percentage + Cost Trend by Type + Client Wise
 * Cost Analytics + Top Clients by Cost + Client x Category Cost Matrix +
 * Client Wise Analytics + Leave Hours Trend + No Work Trend + Project Wise
 * Analytics.
 * Period-scoped (share the filter set with getAnalyticsDashboard — fiscal
 * year, quarter, month/year, period, employee, client, Service PO, plus
 * serviceTypeId): monthly_resource_utilization, cost_trend_by_type,
 * client_wise_analytics, leave_hours_trend, no_work_trend,
 * project_wise_analytics. Always unfiltered (complete dataset, every query
 * param ignored): client_wise_cost_analytics, top_clients_by_cost (also
 * paginated independently via topClientsPage/topClientsLimit),
 * client_category_cost_matrix.
 */
async function getMonthlyResourceUtilization(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const result = await dashboardService.getMonthlyResourceUtilization(filters, req.companyId);
    return sendSuccess(res, result, 'Monthly resource utilization report fetched successfully.');
  } catch (err) {
    logger.error('Dashboard getMonthlyResourceUtilization error', { error: err.message, stack: err.stack, userId: req.userId });
    next(err);
  }
}

module.exports = {
  getStats,
  getEmployeeBillableBreakdown,
  getPOBillableBreakdown,
  getTopEmployeesByPO,
  getBillableTrend,
  getAnalyticsDashboard,
  getMonthlyResourceUtilization,
};
