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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
 *     responses:
 *       200: { description: Un-paginated business-mix records (one row per category x type) }
 *       401: { description: Unauthorized }
 *       422: { description: month and year are required }
 */
router.get('/service-line-business-mix', authenticateMultiBU, managementReportController.getServiceLineBusinessMix);

/**
 * @swagger
 * /reports/pm-wise-utilization:
 *   get:
 *     summary: "[Report 11] Billable-only resource/project count and utilization %, rolled up per Project Manager"
 *     description: >
 *       A PM's "team" is driven by Service PO staffing, not the org
 *       hierarchy: (1) find every Service PO the PM is THEMSELVES
 *       individually mapped to (employee_servicepo_mapping — the same
 *       "Project Manager sees only individually-mapped Service POs" rule
 *       servicePOService.js already enforces for the PO Master screen), (2)
 *       `resource_count` = COUNT(DISTINCT employee) individually mapped to
 *       any of those Service POs (an employee mapped to 2 of the PM's
 *       Service POs is counted once, not twice), (3) `project_count` =
 *       COUNT(DISTINCT project) across those same Service POs, (4)
 *       `total_logged_hours` = actual timesheet hours logged against those
 *       specific (employee, Service PO) pairs, (5) `total_available_hours`
 *       = the PLANNED/BUDGETED hours for those same pairs, read from
 *       resource_budget_master (the "PO Master") for the requested months —
 *       NOT a flat capacity constant, so it reads 0 until a real budget has
 *       been entered for that employee/Service PO/month. `is_billable=true`
 *       on service_pos (not a service-po-name heuristic) excludes Bench/
 *       Leave/Training-type overhead POs from every column.
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
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
 *         name: search
 *         schema: { type: string }
 *         description: Matches Project Manager name/employee code
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [pm_name, resource_count, project_count, total_logged_hours, total_available_hours, utilization_pct] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
 *     responses:
 *       200: { description: Paginated PM-wise utilization records, plus a portfolio-wide summary totals block }
 *       401: { description: Unauthorized }
 *       422: { description: A month/year range must be provided }
 */
router.get('/pm-wise-utilization', authenticateMultiBU, managementReportController.getPMWiseUtilization);

/**
 * @swagger
 * /reports/project-wise-utilization:
 *   get:
 *     summary: "[Report 12] Billable-only resource count and utilization %, rolled up per Service PO (client/project/SPO)"
 *     description: >
 *       Despite the "project-wise" name (kept for continuity with the
 *       source spec), this is actually SERVICE PO-wise: one row per Service
 *       PO, carrying its Client and Project for context. Same staffing/
 *       hours/budget conventions as /reports/pm-wise-utilization — Service
 *       PO mapping (employee_servicepo_mapping) defines the resource pool,
 *       `total_logged_hours` from timesheets, `total_available_hours` from
 *       resource_budget_master ("PO Master") — just grouped by Service PO
 *       instead of Project Manager. `is_billable=true` excludes Bench/Leave/
 *       Training-type overhead POs from the listing entirely.
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
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
 *         name: search
 *         schema: { type: string }
 *         description: Matches Client/Project/Service PO name or Service PO code
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [client_name, project_name, service_po_name, resource_count, total_logged_hours, total_available_hours, utilization_pct] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
 *     responses:
 *       200:
 *         description: >
 *           Paginated Service PO-wise utilization records — each row:
 *           { service_po_id, service_po_code, service_po_name, project_id,
 *           project_code, project_name, client_id, client_name,
 *           resource_count, total_logged_hours, total_available_hours,
 *           utilization_pct } — plus a portfolio-wide summary totals block.
 *       401: { description: Unauthorized }
 *       422: { description: A month/year range must be provided }
 */
router.get('/project-wise-utilization', authenticateMultiBU, managementReportController.getProjectWiseUtilization);

/**
 * @swagger
 * /reports/month-wise-bench:
 *   get:
 *     summary: "[Report 13] Org-wide monthly Bench %, one row per calendar month in range"
 *     description: >
 *       Reuses the exact Bench heuristic already established elsewhere in
 *       this codebase (LOWER(service_po_name) IN ('idle', 'on bench')) — no
 *       structured leave/absence model exists. "Total Available Hrs (Org)"
 *       per month = COUNT(DISTINCT employees who logged ANY hours that
 *       month) x MONTHLY_CAP (176) — there is no historical headcount table,
 *       so this is a proxy for "who was active that month", not a read off
 *       today's employee roster. Companion report: /reports/resource-wise-bench
 *       (same source Excel tab, split into 2 separate reports).
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
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
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
 *     responses:
 *       200:
 *         description: >
 *           { data: [{month, year, resources_on_bench, total_bench_hours,
 *           total_available_hours, bench_pct}], period }
 *       401: { description: Unauthorized }
 *       422: { description: A month/year range must be provided }
 */
router.get('/month-wise-bench', authenticateMultiBU, managementReportController.getMonthWiseBench);

/**
 * @swagger
 * /reports/resource-wise-bench:
 *   get:
 *     summary: "[Report 14] Per-resource Bench % breakdown across a month range, one row per Employee"
 *     description: >
 *       Companion to /reports/month-wise-bench (same source Excel tab, split
 *       into 2 reports). Only lists employees with at least one Bench-tagged
 *       (idle/on bench) timesheet entry somewhere in the range, each with a
 *       `months` array (one entry per calendar month, `{month, year,
 *       bench_hours, bench_pct}`) and an `avg_bench_pct` across the range —
 *       a caller wanting fixed Apr/May/Jun-style columns pivots this array
 *       client-side. `project_manager_name` is resolved via the Employee's
 *       PRIMARY manager mapping only.
 *     tags: [ManagementReports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
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
 *         name: sortBy
 *         schema: { type: string, enum: [full_name, avg_bench_pct] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
 *     responses:
 *       200:
 *         description: >
 *           Paginated records: { employee_id, full_name, employee_code,
 *           project_manager_name, months: [{month, year, bench_hours,
 *           bench_pct}], avg_bench_pct }
 *       401: { description: Unauthorized }
 *       422: { description: A month/year range must be provided }
 */
router.get('/resource-wise-bench', authenticateMultiBU, managementReportController.getResourceWiseBench);

module.exports = router;
