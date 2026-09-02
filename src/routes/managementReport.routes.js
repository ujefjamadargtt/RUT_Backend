'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
// The 9 reports on the "no X-Company-Id -> role reach across every BU the
// caller is mapped to" convention (req.companyIds, an array) — see
// resolveReportCompanyScope.js. Deliberately authenticateIdentity, not the
// full authenticateBase default export: resolveCompany.js (its tail) 400s a
// BU-scoped caller mapped to more than one Business Unit who omits the
// header, before this middleware would ever get a chance to run.
// bu-performance-scorecard keeps its own separate req.entityIds mechanism
// below (restricted to Entity Admin/Admin, who are exempt from
// resolveCompany.js's BU logic entirely) — unaffected either way.
const authenticateMultiBU = [authenticateBase.authenticateIdentity, resolveReportCompanyScope];
const requireEntityAdminOrAdmin = require('../middlewares/requireEntityAdminOrAdmin');
const managementReportController = require('../controllers/managementReportController');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');

/**
 * @swagger
 * tags:
 *   name: ManagementReports
 *   description: >
 *     10 new management/business reports built on top of the existing
 *     Report module. The first consumers of cost_budget_master (planned
 *     monthly Invoice Amount per Service PO) and resource_budget_master
 *     (planned monthly hours per Employee + Service PO). Mounted at the
 *     same /reports base path as report.routes.js — paths are disjoint.
 */

router.use(heavyReportLimiter);

/**
 * @swagger
 * /reports/service-po-profitability:
 *   get:
 *     summary: "[Report 1] Actual invoice vs actual delivery cost margin per Service PO"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: isBillable
 *         schema: { type: boolean }
 *       - in: query
 *         name: serviceCategoryId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated PO profitability records with page-level totals }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/service-po-profitability', authenticateMultiBU, managementReportController.getServicePOProfitability);

/**
 * @swagger
 * /reports/budgeted-margin-forecast:
 *   get:
 *     summary: "[Report 2] Forecasted margin from cost_budget_master + resource_budget_master, before the month happens"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated forecast records — empty until future budgets are entered for the period }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/budgeted-margin-forecast', authenticateMultiBU, managementReportController.getBudgetedMarginForecast);

/**
 * @swagger
 * /reports/resource-staffing-plan-accuracy:
 *   get:
 *     summary: "[Report 3] Planned (resource_budget_master) vs actual (timesheet) hours per employee + Service PO"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: varianceThresholdPct
 *         schema: { type: number, default: 20 }
 *         description: "|variance %| at or above this flags at_risk=true (default 20)"
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated planned-vs-actual hour records }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/resource-staffing-plan-accuracy', authenticateMultiBU, managementReportController.getResourceStaffingPlanAccuracy);

/**
 * @swagger
 * /reports/client-profitability-concentration:
 *   get:
 *     summary: "[Report 4] Per-client margin plus each client's share of total company revenue"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated client profitability + concentration records }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/client-profitability-concentration', authenticateMultiBU, managementReportController.getClientProfitabilityConcentration);

/**
 * @swagger
 * /reports/bu-performance-scorecard:
 *   get:
 *     summary: "[Report 5] Cross-Business-Unit (Company) comparison — Entity Admin / Admin only"
 *     description: >
 *       Restricted to Entity Admin/Admin (requireEntityAdminOrAdmin) — the
 *       only report scoped to req.entityIds instead of a single companyId.
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: companyId
 *         schema: { type: integer }
 *         description: Restrict to one BU within the caller's allowed Entities
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated BU scorecard records }
 *       401: { description: Unauthorized }
 *       403: { description: Restricted to Admin or Entity Admin }
 *       422: { description: month and year are required }
 */
router.get('/bu-performance-scorecard', authenticateBase, requireEntityAdminOrAdmin, managementReportController.getBUPerformanceScorecard);

/**
 * @swagger
 * /reports/employee-capacity-forecast:
 *   get:
 *     summary: "[Report 6] Planned monthly hours vs the 176-hour cap, plus bench/overallocation flags"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: designation
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: benchThresholdHours
 *         schema: { type: number, default: 40 }
 *         description: Planned hours below this (with an active PO mapping) flags bench_flag=true
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated employee capacity records }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/employee-capacity-forecast', authenticateMultiBU, managementReportController.getEmployeeCapacityForecast);

/**
 * @swagger
 * /reports/service-po-timeline-risk:
 *   get:
 *     summary: "[Report 7] Elapsed time % vs consumed hours % per Service PO, with a projected exhaustion date"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: asOfDate
 *         schema: { type: string, format: date }
 *         description: Defaults to today
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated timeline/budget risk records }
 *       401: { description: Unauthorized }
 */
router.get('/service-po-timeline-risk', authenticateMultiBU, managementReportController.getServicePOTimelineRisk);

/**
 * @swagger
 * /reports/delivery-head-performance:
 *   get:
 *     summary: "[Report 8] Portfolio rollup (revenue, cost, margin, at-risk count) by Delivery Head"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: deliveryHeadEmployeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated delivery head performance records }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/delivery-head-performance', authenticateMultiBU, managementReportController.getDeliveryHeadPerformance);

/**
 * @swagger
 * /reports/invoice-realization-trend:
 *   get:
 *     summary: "[Report 9] Trended invoiced vs billed amounts per Service PO, with months_outstanding"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer }
 *         description: Single-month shorthand — equivalent to startMonth=endMonth=month, startYear=endYear=year
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startMonth
 *         schema: { type: integer }
 *       - in: query
 *         name: startYear
 *         schema: { type: integer }
 *       - in: query
 *         name: endMonth
 *         schema: { type: integer }
 *       - in: query
 *         name: endYear
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated invoice realization trend records }
 *       401: { description: Unauthorized }
 *       422: { description: A month/year range must be provided }
 */
router.get('/invoice-realization-trend', authenticateMultiBU, managementReportController.getInvoiceRealizationTrend);

/**
 * @swagger
 * /reports/service-line-business-mix:
 *   get:
 *     summary: "[Report 10] Hours, cost, revenue and margin per Service Category / Service Type"
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceCategoryId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: compareMonth
 *         schema: { type: integer }
 *         description: Optional prior period for revenue_growth_pct
 *       - in: query
 *         name: compareYear
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Un-paginated business-mix records (one row per category x type) }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/service-line-business-mix', authenticateMultiBU, managementReportController.getServiceLineBusinessMix);

module.exports = router;
