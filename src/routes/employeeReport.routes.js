'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const {
  dailyReportQuerySchema,
  monthlyReportQuerySchema,
  rangeReportQuerySchema,
  projectHoursReportQuerySchema,
  timesheetApprovalStatusQuerySchema,
} = require('../validations/employeeReportValidation');
const controller = require('../controllers/employeeReportController');

/**
 * @swagger
 * tags:
 *   name: Employee Reports
 *   description: >
 *     Employee Self Timesheet reports — an Employee sees only their own
 *     data. Requires an Employee access token (employeeAuth), never the
 *     User token. Reads exclusively from `employee_work_logs` (including
 *     entries not yet synced to the official Timesheet) — never from
 *     `timesheets`. Admin Reports (/api/v1/reports/*) continue to read
 *     `timesheets` and are a separate, unmixed data source.
 */

/**
 * @swagger
 * /employee-reports/daily:
 *   get:
 *     summary: Daily report for one date
 *     tags: [Employee Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, excel, csv, pdf], default: json }
 *     responses:
 *       200:
 *         description: Report data or file
 */
router.get(
  '/daily',
  authenticate,
  authorize('employee.view_reports'),
  validate(dailyReportQuerySchema, 'query'),
  controller.getDaily
);

/**
 * @swagger
 * /employee-reports/monthly:
 *   get:
 *     summary: Monthly report
 *     tags: [Employee Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, excel, csv, pdf], default: json }
 *     responses:
 *       200:
 *         description: Report data or file
 */
router.get(
  '/monthly',
  authenticate,
  authorize('employee.view_reports'),
  validate(monthlyReportQuerySchema, 'query'),
  controller.getMonthly
);

/**
 * @swagger
 * /employee-reports/range:
 *   get:
 *     summary: Date-range report
 *     tags: [Employee Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, excel, csv, pdf], default: json }
 *     responses:
 *       200:
 *         description: Report data or file
 */
router.get(
  '/range',
  authenticate,
  authorize('employee.view_reports'),
  validate(rangeReportQuerySchema, 'query'),
  controller.getRange
);

/**
 * @swagger
 * /employee-reports/project-hours/filter-tree:
 *   get:
 *     summary: Project -> Service PO -> Parent -> Child filter tree (structure only, no hours)
 *     description: >
 *       The data source for the Project Hours report's Service PO/Project
 *       filter — only Service POs currently mapped to the authenticated
 *       Employee, grouped under their Project, each with its full
 *       Parent/Child hierarchy. No hours here; see /project-hours for the
 *       hours-bearing version over a selected period.
 *     tags: [Employee Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >
 *           Array of { project_id, project_name, service_pos: [{ service_po_id,
 *           service_po_name, children: [{ id, node_name, node_type, children }] }] }
 */
router.get(
  '/project-hours/filter-tree',
  authenticate,
  authorize('employee.view_reports'),
  controller.getProjectHoursFilterTree
);

/**
 * @swagger
 * /employee-reports/project-hours:
 *   get:
 *     summary: Employee hours by Project -> Service PO -> Parent -> Child hierarchy
 *     description: >
 *       How many hours the authenticated Employee has logged against their
 *       mapped Projects/Service POs, including the full Service PO
 *       hierarchy. Exactly one of date, month & year, or startDate & endDate
 *       is required — there is no default period, matching /daily,
 *       /monthly, and /range above. Optionally narrowed to one mapped
 *       service_po_id or project_id (never both). Every mapped Service PO
 *       and every Parent/Child node under it is always included, even at 0
 *       hours, so the Employee can see which mapped nodes had no activity.
 *       A Service PO's own `hours` is its direct-to-PO hours plus every
 *       hierarchy node's hours (no double-counting); each Parent/Child
 *       node's own `hours` is independent — entries logged directly against
 *       the Service PO, a Parent, and a Child are all separately represented.
 *     tags: [Employee Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: service_po_id
 *         schema: { type: integer }
 *         description: Optional — must be one of the caller's own mapped Service POs
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *         description: Optional — must be a Project with at least one Service PO mapped to the caller
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *         description: Specific date — mutually exclusive with month/year and startDate/endDate
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: >
 *           { projects: [{ project_id, project_name, service_pos: [{ service_po_id,
 *           service_po_name, hours, children: [{ hierarchy_id, name, type, hours, children }] }],
 *           total_hours }], grand_total_hours }
 *       400:
 *         description: No period given, more than one period given, or both service_po_id and project_id given
 *       403:
 *         description: service_po_id/project_id not mapped to the caller, or the caller has no linked Employee account
 */
router.get(
  '/project-hours',
  authenticate,
  authorize('employee.view_reports'),
  validate(projectHoursReportQuerySchema, 'query'),
  controller.getProjectHours
);

/**
 * @swagger
 * /employee-reports/timesheet-approval-status:
 *   get:
 *     summary: Timesheet hours + approval status, with full Service PO hierarchy
 *     description: >
 *       Answers "how many hours were logged, and what's their approval
 *       status" together. The approval UNIT is unchanged from the existing
 *       workflow — Employee + Date (daily) or Employee + Month + Year
 *       (monthly), see /my-team/timesheets/approve(-bulk) — this report
 *       never approves anything itself; hierarchy nodes shown here are
 *       informational, not independently approvable.
 *       Exactly one of date, month & year, or startDate & endDate is
 *       required, same convention as /daily, /monthly, /range, and
 *       /project-hours above.
 *       Scope is data-driven: if the caller actually has employees mapped
 *       to them (manager_employee_mappings), they get their whole mapped
 *       team (or one mapped employee_id) in one call; otherwise they only
 *       ever see their own records and any employee_id is rejected. No
 *       Service-PO-mapping restriction is applied to a Manager's team view
 *       — Employee mapping alone determines scope.
 *       Every mapped Service PO's complete Parent/Child hierarchy is always
 *       shown for a bucket that has any activity, including nodes at 0
 *       hours (approval_status is null for those — nothing was logged
 *       there, so there's no status to derive). approval_required mirrors
 *       the employee's is_timesheet_approval_required flag.
 *     tags: [Employee Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: employee_id
 *         schema: { type: integer }
 *         description: Manager only — must be one of the caller's own mapped Employees; omit for the whole team
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: log_type
 *         schema: { type: string, enum: [daily, monthly] }
 *         description: Only affects startDate/endDate range mode — daily buckets per date (default) or monthly buckets spanning the range
 *     responses:
 *       200:
 *         description: >
 *           { data: [{ employee_id, employee_name, log_type, date (daily) or month/year (monthly),
 *           total_hours, approval_required, approval_status, projects: [{ project_id, project_name,
 *           service_pos: [{ service_po_id, service_po_name, po_total_hours, approval_status,
 *           children: [{ hierarchy_id, name, type, hours, approval_status, children }] }] }] }] }
 *       400:
 *         description: No period given, or more than one period mode given
 *       403:
 *         description: employee_id not mapped to the caller, or the caller has no linked Employee account
 */
router.get(
  '/timesheet-approval-status',
  authenticate,
  validate(timesheetApprovalStatusQuerySchema, 'query'),
  controller.getTimesheetApprovalStatus
);

module.exports = router;
