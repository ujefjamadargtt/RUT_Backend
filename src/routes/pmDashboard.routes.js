'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
const authorize = require('../middlewares/authorize');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');
const pmDashboardController = require('../controllers/pmDashboardController');

/**
 * Auth stack: identity + BU role-reach (req.companyIds) — same convention as
 * report.routes.js/managementReport.routes.js — PLUS a capability gate
 * restricting this dashboard to the Project Manager tier and above.
 * `servicepo.view_mapped_employees` is Project Manager's own capability
 * (granted to the role formerly named "Service PO Admin" — see
 * database/migrations/20260836_seed_target_roles_and_capabilities.sql),
 * inherited by Project Admin, and bypassed entirely by the senior tier
 * (ranks 1-4 — Platform Admin/Admin/Entity Admin/BU Admin). Team Lead/
 * Employee/HR do not hold it, so this module is unreachable for them —
 * unlike every other report in this codebase, which carries no capability
 * gate at all (see the PM Dashboard audit for that finding).
 */
const authenticatePMDashboard = [
  authenticateBase.authenticateIdentity,
  resolveReportCompanyScope,
  authorize(['servicepo.view_mapped_employees']),
];

router.use(heavyReportLimiter);

/**
 * @swagger
 * tags:
 *   name: PMDashboard
 *   description: >
 *     Project Manager Dashboard. Composes existing report/compliance
 *     services rather than re-implementing their access rules — team
 *     visibility reuses employeeAccessControlService.resolveEmployeeAccessWhere
 *     (the same resolver Employee Master and the Work Log Compliance report
 *     use), and Service PO/Project/Client visibility is BU-wide via
 *     req.companyIds, matching every other report in this codebase.
 */

/**
 * @swagger
 * /pm-dashboard/summary:
 *   get:
 *     summary: >
 *       KPI row: team size, active projects/Service POs, logged hours,
 *       missing work logs, pending approvals, at-risk projects, overallocated
 *       and bench employees, budget vs billed.
 *     tags: [PMDashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Defaults to the current server month.
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Defaults to the current server year.
 *       - in: query
 *         name: asOfDate
 *         schema: { type: string, format: date }
 *         description: Defaults to today — used for the at-risk/overdue project calculation.
 *       - in: query
 *         name: varianceThresholdPct
 *         schema: { type: number, default: 20 }
 *         description: "|planned-vs-actual hours variance %| at or above this counts a Project as at risk."
 *     responses:
 *       200: { description: PM Dashboard KPI summary }
 *       401: { description: Unauthorized }
 *       403: { description: Requires the Project Manager tier or above }
 */
router.get('/summary', authenticatePMDashboard, pmDashboardController.getSummary);

/**
 * @swagger
 * /pm-dashboard/projects:
 *   get:
 *     summary: >
 *       Project rollup — one row per Project, aggregated across its Service
 *       POs (team size, planned/actual hours, variance %, risk flag, nearest
 *       upcoming deadline).
 *     tags: [PMDashboard]
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
 *         name: status
 *         schema: { type: string }
 *         description: Project status filter (e.g. active/inactive).
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: asOfDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: varianceThresholdPct
 *         schema: { type: number, default: 20 }
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [project_name, team_size, planned_hours, actual_hours, variance_pct, overdue_po_count, nearest_end_date]
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated project rollup records }
 *       401: { description: Unauthorized }
 *       403: { description: Requires the Project Manager tier or above }
 */
router.get('/projects', authenticatePMDashboard, pmDashboardController.getProjects);

/**
 * @swagger
 * /pm-dashboard/team:
 *   get:
 *     summary: >
 *       Team capacity — planned vs actual hours per employee, utilization %,
 *       over/under-allocation, and leave/no-work hours (reusing the existing
 *       Dashboard's Leave/Bench service-type-name heuristic — this codebase
 *       has no structured leave/absence model).
 *     tags: [PMDashboard]
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
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: benchThresholdHours
 *         schema: { type: number, default: 40 }
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [full_name, planned_hours, actual_hours, capacity_used_pct, leave_hours, no_work_hours]
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Paginated team capacity records }
 *       401: { description: Unauthorized }
 *       403: { description: Requires the Project Manager tier or above }
 */
router.get('/team', authenticatePMDashboard, pmDashboardController.getTeam);

/**
 * @swagger
 * /pm-dashboard/worklog:
 *   get:
 *     summary: >
 *       Work log compliance for this Project Manager's team — a thin
 *       pass-through to the existing Employee Work Log Compliance report
 *       (GET /reports/employee-work-log-compliance), already correctly
 *       team-scoped.
 *     tags: [PMDashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *         description: Single date (DATE mode, threshold 8h). Mutually exclusive with month+year.
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
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
 *       200: { description: Paginated work log compliance records for this Project Manager's team }
 *       401: { description: Unauthorized }
 *       403: { description: Requires the Project Manager tier or above }
 */
router.get('/worklog', authenticatePMDashboard, pmDashboardController.getWorklog);

/**
 * @swagger
 * /pm-dashboard/action-required:
 *   get:
 *     summary: >
 *       Merged exception feed — missing work logs, pending approvals,
 *       at-risk projects, overallocated employees, and bench employees
 *       (each list capped at 20).
 *     tags: [PMDashboard]
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
 *         name: asOfDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: varianceThresholdPct
 *         schema: { type: number, default: 20 }
 *     responses:
 *       200: { description: Merged action-required feed }
 *       401: { description: Unauthorized }
 *       403: { description: Requires the Project Manager tier or above }
 */
router.get('/action-required', authenticatePMDashboard, pmDashboardController.getActionRequired);

module.exports = router;
