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
 *       and bench employees, budget vs billed — plus a `previous` sibling
 *       object (same period one month back) for trend deltas, and a
 *       portfolio-wide `project_status_breakdown` for a status donut/pie
 *       chart.
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
 *       200:
 *         description: >
 *           PM Dashboard KPI summary. `previous.team_size` and
 *           `previous.active_projects` are always null — see
 *           `previous_period_note` in the response body for why (this
 *           schema has no historical team-roster/Project-status tracking).
 *           `project_status_breakdown` is `[{status, count}]` for all 4
 *           canonical statuses (on_track/at_risk/delayed/inactive), zero-
 *           filled — `at_risk_projects` is exactly the sum of that
 *           breakdown's at_risk + delayed counts, so the two never disagree.
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
 *         description: >
 *           Raw Project lifecycle filter (active/inactive — the only two
 *           values projects.status itself carries). NOT the same as
 *           healthStatus below.
 *       - in: query
 *         name: healthStatus
 *         schema: { type: string, enum: [on_track, at_risk, delayed, inactive] }
 *         description: >
 *           Filter by the COMPUTED health status (see /pm-dashboard/summary's
 *           project_status_breakdown) — this is what the Project Overview
 *           Status filter should use, not `status` above.
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
 *           enum: [project_name, team_size, planned_hours, actual_hours, variance_pct, overdue_po_count, nearest_end_date, health_status]
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
 *       200:
 *         description: >
 *           Paginated project rollup records. Each row carries both
 *           `risk_flag` (boolean) and `health_status`
 *           (on_track/at_risk/delayed/inactive) — the canonical status enum,
 *           computed server-side (see /pm-dashboard/summary's
 *           project_status_breakdown for the same categorization portfolio-
 *           wide).
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

/**
 * @swagger
 * /pm-dashboard/monthly-hours-trend:
 *   get:
 *     summary: >
 *       Monthly Logged vs Required Hours trend for this Project Manager's
 *       team, one full calendar year (Jan-Dec) at a time.
 *     description: >
 *       BU narrowing uses the SAME mechanism as every other endpoint in this
 *       module — the `company_id` query param or `X-Company-Id` header —
 *       there is no separate `buId` parameter. `required_hours` is a flat
 *       current-team-headcount x 160h/employee/month figure applied to
 *       every month shown (see the response's own required_hours_note) —
 *       this schema has no historical team-roster data, so it cannot
 *       reflect headcount changes that happened during the year.
 *     tags: [PMDashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Defaults to the current server year.
 *     responses:
 *       200:
 *         description: >
 *           { year, team_size, required_hours_per_employee_per_month,
 *           required_hours_note, trend: [{ month, year, logged_hours,
 *           required_hours }] } — always 12 rows, zero-filled for months
 *           with no logged hours.
 *       401: { description: Unauthorized }
 *       403: { description: Requires the Project Manager tier or above }
 */
router.get('/monthly-hours-trend', authenticatePMDashboard, pmDashboardController.getMonthlyHoursTrend);

module.exports = router;
