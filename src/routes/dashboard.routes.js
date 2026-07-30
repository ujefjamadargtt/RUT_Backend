'use strict';

const express = require('express');
const router = express.Router();

const Joi = require('joi');
const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const dashboardController = require('../controllers/dashboardController');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');

// Dashboard/Analytics2 endpoints run multi-join aggregate queries across the
// whole timesheet dataset — rate-limited as a class, independent of the
// general API limit.
router.use(heavyReportLimiter);

const statsQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).optional().messages({
    'number.min': 'month must be between 1 and 12.',
    'number.max': 'month must be between 1 and 12.',
  }),
  year: Joi.number().integer().min(2000).max(2100).optional().messages({
    'number.min': 'year must be between 2000 and 2100.',
    'number.max': 'year must be between 2000 and 2100.',
  }),
  hoursSource: Joi.string().valid('O', 'M').optional()
    .description("'O' = original hours_logged, 'M' (default) = modified_hours falling back to hours_logged."),
  roleId: Joi.number().integer().positive().optional()
    .description('Sent by the frontend to identify the caller\'s role. roleId=5 (Management) gates this response to published-only data for the selected period — see publishVisibilityService.js.'),
}).and('month', 'year');

const breakdownQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).optional().messages({
    'number.min': 'month must be between 1 and 12.',
    'number.max': 'month must be between 1 and 12.',
  }),
  year: Joi.number().integer().min(2000).max(2100).optional().messages({
    'number.min': 'year must be between 2000 and 2100.',
    'number.max': 'year must be between 2000 and 2100.',
  }),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  search: Joi.string().trim().max(100).optional().allow(''),
  is_billable: Joi.boolean().optional(),
  service_type_id: Joi.number().integer().positive().optional(),
  service_category_id: Joi.number().integer().positive().optional(),
  hoursSource: Joi.string().valid('O', 'M').optional()
    .description("'O' = original hours_logged, 'M' (default) = modified_hours falling back to hours_logged."),
  roleId: Joi.number().integer().positive().optional()
    .description('Sent by the frontend to identify the caller\'s role. roleId=5 (Management) gates this response to published-only data for the selected period — see publishVisibilityService.js.'),
}).and('month', 'year');

const trendQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).optional().messages({
    'number.min': 'month must be between 1 and 12.',
    'number.max': 'month must be between 1 and 12.',
  }),
  year: Joi.number().integer().min(2000).max(2100).optional().messages({
    'number.min': 'year must be between 2000 and 2100.',
    'number.max': 'year must be between 2000 and 2100.',
  }),
  months: Joi.number().integer().min(2).max(24).optional().messages({
    'number.min': 'months must be between 2 and 24.',
    'number.max': 'months must be between 2 and 24.',
  }),
  hoursSource: Joi.string().valid('O', 'M').optional()
    .description("'O' = original hours_logged, 'M' (default) = modified_hours falling back to hours_logged."),
  roleId: Joi.number().integer().positive().optional()
    .description('Sent by the frontend to identify the caller\'s role. roleId=5 (Management) gates this response to published-only data for the selected period — see publishVisibilityService.js.'),
}).and('month', 'year');

const analyticsQuerySchema = Joi.object({
  fiscalYear: Joi.number().integer().min(2000).max(2100).optional()
    .description('Year the fiscal year starts in (Apr-fiscalYear -> Mar-fiscalYear+1). Defaults to the current fiscal year.'),
  quarter: Joi.number().integer().min(1).max(4).optional()
    .description('Fiscal quarter (1=Apr-Jun, 2=Jul-Sep, 3=Oct-Dec, 4=Jan-Mar). Ignored if startDate/endDate given.'),
  month: Joi.number().integer().min(1).max(12).optional().messages({
    'number.min': 'month must be between 1 and 12.',
    'number.max': 'month must be between 1 and 12.',
  }),
  year: Joi.number().integer().min(2000).max(2100).optional().messages({
    'number.min': 'year must be between 2000 and 2100.',
    'number.max': 'year must be between 2000 and 2100.',
  }),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional()
    .messages({ 'string.pattern.base': 'startDate must be in YYYY-MM-DD format.' }),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional()
    .messages({ 'string.pattern.base': 'endDate must be in YYYY-MM-DD format.' }),
  employeeId: Joi.number().integer().positive().optional(),
  clientId: Joi.number().integer().positive().optional(),
  poId: Joi.number().integer().positive().optional(),
  serviceTypeId: Joi.number().integer().positive().optional()
    .description('Filter to a single Service Type. Applied by GET /dashboard/analytics2\'s Cost Trend by Type report, and by GET /dashboard/analytics\'s total_po_value_fiscal_year.'),
  serviceCategoryId: Joi.number().integer().positive().optional()
    .description('Filter to a single Service Category. Applied by GET /dashboard/analytics\'s total_po_value_fiscal_year.'),
  topClientsPage: Joi.number().integer().min(1).optional()
    .description('GET /dashboard/analytics2 only: page number for the Top Clients by Cost report, paginated independently of the rest of the response.'),
  topClientsLimit: Joi.number().integer().min(1).max(100).optional()
    .description('GET /dashboard/analytics2 only: page size for the Top Clients by Cost report. Defaults to 15.'),
  hoursSource: Joi.string().valid('O', 'M').optional()
    .description("'O' = original hours_logged, 'M' (default) = modified_hours falling back to hours_logged."),
  roleId: Joi.number().integer().positive().optional()
    .description('Sent by the frontend to identify the caller\'s role. roleId=5 (Management) gates this response to published-only data for the selected period — see publishVisibilityService.js.'),
})
  .and('startDate', 'endDate')
  .and('month', 'year');

/**
 * @swagger
 * tags:
 *   name: Dashboard
 *   description: Consolidated KPIs and analytics for the RUT Portal home screen
 */

/**
 * @swagger
 * /dashboard/stats:
 *   get:
 *     summary: Retrieve all dashboard statistics
 *     description: >
 *       Returns workforce counts, portfolio summary, current-month metrics,
 *       financial figures, monthly trend data, and a recent activity feed.
 *       All data points are fetched in parallel for minimal latency.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Optional month (1-12) to scope period-based stats to. Requires `year` to also be set. Defaults to the current month.
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Optional year to scope period-based stats to. Requires `month` to also be set. Defaults to the current year.
 *     responses:
 *       200:
 *         description: Dashboard statistics object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Dashboard statistics fetched successfully.
 *                 data:
 *                   type: object
 *                   properties:
 *                     as_of:
 *                       type: string
 *                       format: date-time
 *                     period:
 *                       type: object
 *                       properties:
 *                         month: { type: integer }
 *                         year:  { type: integer }
 *                     workforce:
 *                       type: object
 *                       properties:
 *                         total_employees:    { type: integer }
 *                         active_employees:   { type: integer }
 *                         inactive_employees: { type: integer }
 *                     portfolio:
 *                       type: object
 *                       properties:
 *                         total_clients: { type: integer }
 *                         active_pos:    { type: integer }
 *                         closed_pos:    { type: integer }
 *                         total_pos:     { type: integer }
 *                     current_month:
 *                       type: object
 *                       properties:
 *                         total_hours_logged:         { type: number }
 *                         billable_hours_logged:      { type: number }
 *                         non_billable_hours_logged:  { type: number }
 *                         overall_utilisation_pct:    { type: number, nullable: true }
 *                     financials:
 *                       type: object
 *                       properties:
 *                         total_po_value_current_year: { type: number }
 *                     charts:
 *                       type: object
 *                       properties:
 *                         monthly_hours_trend: { type: array, items: { type: object } }
 *                         top_pos_by_hours:    { type: array, items: { type: object } }
 *                     activity:
 *                       type: object
 *                       properties:
 *                         recent_timesheet_entries: { type: array, items: { type: object } }
 *       401:
 *         description: Unauthorized
 */
router.get('/stats', authenticate, validate(statsQuerySchema, 'query'), dashboardController.getStats);

/**
 * @swagger
 * /dashboard/employee-billable-breakdown:
 *   get:
 *     summary: Per-employee billable vs non-billable vs customer-non-billable hour breakdown, with reasons
 *     description: >
 *       For each employee active in the selected month/year, returns billable_hours,
 *       non_billable_hours, customer_non_billable_hours, billable_pct, and the
 *       contributing Service POs (with each PO's is_billable flag, category, and
 *       hours) as the reason for the split.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Matches employee full name or employee code.
 *     responses:
 *       200:
 *         description: Paginated per-employee billable breakdown
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/employee-billable-breakdown',
  authenticate,
  validate(breakdownQuerySchema, 'query'),
  dashboardController.getEmployeeBillableBreakdown
);

/**
 * @swagger
 * /dashboard/po-billable-breakdown:
 *   get:
 *     summary: Per-Service-PO billable/non-billable classification, with reasons
 *     description: >
 *       For each Service PO, returns its is_billable flag, service type, category,
 *       hours logged in the selected month/year, and a human-readable reason string
 *       explaining the classification.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Matches Service PO name, code, or client name.
 *       - in: query
 *         name: is_billable
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Paginated per-Service-PO billable breakdown
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/po-billable-breakdown',
  authenticate,
  validate(breakdownQuerySchema, 'query'),
  dashboardController.getPOBillableBreakdown
);

/**
 * @swagger
 * /dashboard/top-employees-by-po:
 *   get:
 *     summary: Top 3 employees by hours logged, per Service PO
 *     description: >
 *       For each Service PO active in the selected month/year, returns its top 3
 *       employees ranked by hours logged. Paginated at the Service PO level.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Matches Service PO name, code, or client name.
 *       - in: query
 *         name: is_billable
 *         schema: { type: boolean }
 *       - in: query
 *         name: service_type_id
 *         schema: { type: integer }
 *         description: Filter to POs of this service type
 *       - in: query
 *         name: service_category_id
 *         schema: { type: integer }
 *         description: Filter to POs whose service type belongs to this category
 *     responses:
 *       200:
 *         description: Paginated list of Service POs with their top 3 employees
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/top-employees-by-po',
  authenticate,
  validate(breakdownQuerySchema, 'query'),
  dashboardController.getTopEmployeesByPO
);

/**
 * @swagger
 * /dashboard/billable-trend:
 *   get:
 *     summary: Billable vs non-billable hours trend, month over month, with reasons
 *     description: >
 *       Chart-ready time series of billable_hours, non_billable_hours, total_hours,
 *       and billable_pct across the last N calendar months (default 6, ending at the
 *       selected/current month). Every point after the first includes a `change`
 *       object comparing it to the immediately preceding month: billable_delta,
 *       non_billable_delta, and the top Service POs (billable_drivers /
 *       non_billable_drivers) that most contributed to that month's increase or
 *       decrease on each side, plus a human-readable reason_summary sentence.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Optional end-of-window month. Requires `year`. Defaults to the current month.
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Optional end-of-window year. Requires `month`. Defaults to the current year.
 *       - in: query
 *         name: months
 *         schema: { type: integer, minimum: 2, maximum: 24, default: 6 }
 *         description: Number of months to include in the trend, ending at month/year.
 *     responses:
 *       200:
 *         description: Billable/non-billable trend with month-over-month change reasons
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/billable-trend',
  authenticate,
  validate(trendQuerySchema, 'query'),
  dashboardController.getBillableTrend
);

/**
 * @swagger
 * /dashboard/analytics:
 *   get:
 *     summary: Full analytics dashboard (tiles + charts)
 *     description: >
 *       Returns 7 stat tiles (total hours, total cost, utilization %, active
 *       employees/clients/service POs, avg hours/employee) and 5 charts
 *       (Monthly Hours Trend, Hours by Client, Hours by Employee,
 *       Client x Service PO, Employee Bench %), all scoped by one shared
 *       filter set. Fiscal year runs Apr -> Mar. The Monthly Hours Trend
 *       chart always spans the full selected fiscal year (12 months);
 *       every other tile/chart is scoped to startDate/endDate, else
 *       month+year, else the selected quarter, else the whole fiscal year.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fiscalYear
 *         schema: { type: integer }
 *         description: Year the fiscal year starts in (e.g. 2026 = Apr-2026 -> Mar-2027). Defaults to the current fiscal year.
 *       - in: query
 *         name: quarter
 *         schema: { type: integer, minimum: 1, maximum: 4 }
 *         description: 1=Apr-Jun, 2=Jul-Sep, 3=Oct-Dec, 4=Jan-Mar. Ignored if startDate/endDate or month+year given.
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Calendar month (1-12). Requires year. Overrides quarter; ignored if startDate/endDate given.
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Four-digit year. Requires month.
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         description: Explicit period start (YYYY-MM-DD). Requires endDate. Overrides month/year and quarter.
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *         description: Explicit period end (YYYY-MM-DD). Requires startDate. Overrides month/year and quarter.
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter to a single Service PO
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *         description: Filter to a single Service Type. Currently only scopes financials.total_po_value_fiscal_year.
 *       - in: query
 *         name: serviceCategoryId
 *         schema: { type: integer }
 *         description: Filter to a single Service Category. Currently only scopes financials.total_po_value_fiscal_year.
 *     responses:
 *       200:
 *         description: Analytics dashboard tiles and charts
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/analytics',
  authenticate,
  validate(analyticsQuerySchema, 'query'),
  dashboardController.getAnalyticsDashboard
);

/**
 * @swagger
 * /dashboard/analytics2:
 *   get:
 *     summary: >
 *       Monthly Resource Utilization Percentage + Cost Trend by Type +
 *       Client Wise Cost Analytics + Top Clients by Cost + Client x Category
 *       Cost Matrix + Client Wise Analytics + Leave Hours Trend +
 *       No Work Trend + Project Wise Analytics
 *     description: >
 *       Nine reports sharing one response. Period-scoped (use the filters
 *       and period resolution shared with GET /dashboard/analytics — fiscal
 *       year, quarter, month/year, period, employee, client, Service PO;
 *       serviceTypeId additionally scopes these six): monthly_resource_utilization
 *       (per month with any logged hours, total hours, hours logged against
 *       Billable-category Service POs, and the resulting utilization
 *       percentage = billable_hours / total_hours x 100); cost_trend_by_type
 *       (per month, total cost broken down by service-type category — all 12
 *       fiscal months for a fiscal-year-only query, the quarter's 3 months
 *       for a quarter query, or the single month for a month+year query;
 *       category names read dynamically from service_categories);
 *       client_wise_analytics (per client for the resolved period: total
 *       cost, total hours, average cost/hour, project count, and % of
 *       overall total cost); leave_hours_trend (per month, total hours
 *       logged against the "Leaves" service type only); no_work_trend (per
 *       month, total hours logged against Service POs named "Idle" or
 *       "On Bench" only); project_wise_analytics (one row per Service PO for
 *       the resolved period — client, dynamic category, total cost, and a
 *       month-by-month cost breakdown using the same month set as
 *       cost_trend_by_type). Always unfiltered (no query parameter affects
 *       any of these — always the COMPLETE, all-time dataset):
 *       client_wise_cost_analytics (total hours/cost per client, sorted by
 *       total cost descending); top_clients_by_cost (same, paginated
 *       independently via topClientsPage/topClientsLimit, default page size
 *       15); client_category_cost_matrix (per client, total cost broken down
 *       by category, plus overall total cost).
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fiscalYear
 *         schema: { type: integer }
 *         description: Year the fiscal year starts in (e.g. 2026 = Apr-2026 -> Mar-2027). Defaults to the current fiscal year.
 *       - in: query
 *         name: quarter
 *         schema: { type: integer, minimum: 1, maximum: 4 }
 *         description: 1=Apr-Jun, 2=Jul-Sep, 3=Oct-Dec, 4=Jan-Mar. Ignored if startDate/endDate or month+year given.
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Calendar month (1-12). Requires year. Overrides quarter; ignored if startDate/endDate given.
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Four-digit year. Requires month.
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         description: Explicit period start (YYYY-MM-DD). Requires endDate. Overrides month/year and quarter.
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *         description: Explicit period end (YYYY-MM-DD). Requires startDate. Overrides month/year and quarter.
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter to a single Service PO
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *         description: >
 *           Filter to a single Service Type. Applied to cost_trend_by_type,
 *           client_wise_analytics, leave_hours_trend, no_work_trend, and
 *           project_wise_analytics only.
 *       - in: query
 *         name: topClientsPage
 *         schema: { type: integer, minimum: 1 }
 *         description: Page number for top_clients_by_cost only. Independent of every other report on this endpoint.
 *       - in: query
 *         name: topClientsLimit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *         description: Page size for top_clients_by_cost only. Defaults to 15.
 *     responses:
 *       200:
 *         description: >
 *           { monthly_resource_utilization: [{ month: "Jun-26", total_hours: 6672,
 *           billable_hours: 3156, utilization_percentage: 47.30 }, ...],
 *           cost_trend_by_type: [{ month: "Apr-26", categories: [{ category_name:
 *           "Billable", cost: 125000 }, ...] }, ...],
 *           client_wise_cost_analytics: [{ client_id: 15, client_name: "Arvaya
 *           Healthcare Limited", total_hours: 3892, total_cost: 817044 }, ...],
 *           top_clients_by_cost: { data: [{ rank: 1, client_id: 15, client_name:
 *           "Arvaya Healthcare Limited", total_hours: 3892, total_cost: 817044 }, ...],
 *           pagination: { page: 1, limit: 15, total_records: 50, total_pages: 4 } },
 *           client_category_cost_matrix: [{ client_id: 15, client_name: "Arvaya
 *           Healthcare Limited", categories: { Billable: 817044, "Non-Billable": 0,
 *           "Customer Non-Billable": 0 }, total_cost: 817044 }, ...],
 *           client_wise_analytics: [{ client_id: 15, client_name: "Arvaya
 *           Healthcare Limited", total_cost: 817044, total_hours: 3892,
 *           average_cost_per_hour: 209.93, total_projects: 2,
 *           percentage_of_total_cost: 22.7 }, ...],
 *           leave_hours_trend: [{ month: "Jun-26", leave_hours: 20 }, ...],
 *           no_work_trend: [{ month: "Jun-26", no_work_hours: 10 }, ...],
 *           project_wise_analytics: [{ service_po_id: 152, project_name: "Arvaya",
 *           client_name: "Arvaya Healthcare Limited", category_name: "Billable",
 *           total_cost: 405096, monthly_cost_breakdown: [{ month: "Apr-26", cost: 90509 },
 *           { month: "May-26", cost: 187822 }, { month: "Jun-26", cost: 126765 }] }, ...] }
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Validation error
 */
router.get(
  '/analytics2',
  authenticate,
  validate(analyticsQuerySchema, 'query'),
  dashboardController.getMonthlyResourceUtilization
);

module.exports = router;
