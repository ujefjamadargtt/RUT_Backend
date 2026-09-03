'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');
const { validate } = require('../middlewares/validateRequest');
const {
  complianceReportQuerySchema,
  complianceReminderBodySchema,
  complianceReminderBulkBodySchema,
} = require('../validations/employeeWorkLogComplianceValidation');
const controller = require('../controllers/employeeWorkLogComplianceController');

/**
 * Auth middleware stack — identical to every other report in report.routes.js
 * and managementReport.routes.js:
 *   authenticateIdentity   — verifies JWT, populates req.userId/employeeId/
 *                            hierarchyRank/userRoles/employeeBusinessUnits.
 *   resolveReportCompanyScope — resolves req.companyIds (always an array);
 *                            never 400s a multi-BU caller who omits the
 *                            X-Company-Id header — falls back to full
 *                            role reach instead.
 *
 * Both endpoints read req.companyIds, never a single req.companyId.
 */
const authenticateMultiBU = [authenticateBase.authenticateIdentity, resolveReportCompanyScope];

/**
 * @swagger
 * tags:
 *   name: EmployeeWorkLogCompliance
 *   description: >
 *     Employee Work Log Compliance / Missing Work Log report.
 *     Identifies employees who have not filled enough work-log hours for the
 *     selected date (threshold: 8 h) or month (threshold: 160 h).
 *     Mounted at /reports — paths are disjoint from all existing report routes.
 */

// Rate-limit this report the same way every other heavy report is limited.
router.use(heavyReportLimiter);

/**
 * @swagger
 * /reports/employee-work-log-compliance:
 *   get:
 *     summary: >
 *       Employee Work Log Compliance report — employees below the required
 *       hours threshold for a selected date (< 8 h) or month (< 160 h).
 *     tags: [EmployeeWorkLogCompliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *         description: >
 *           Single date (DATE mode, threshold 8 h). Mutually exclusive with
 *           month + year.
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: >
 *           Month number (MONTH mode, threshold 160 h). Must be paired with year.
 *       - in: query
 *         name: year
 *         schema: { type: integer, minimum: 2000 }
 *         description: Year — required when month is supplied.
 *       - in: query
 *         name: company_id
 *         schema: { type: integer }
 *         description: Optional BU filter (must be within the caller's authorised scope).
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Optional name / employee-code search.
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [employee_name, employee_code, total_hours, shortfall_hours]
 *           default: employee_name
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC], default: ASC }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 100 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated list of employees below the threshold.
 *           Each record: { employee_id, employee_name, employee_code,
 *           business_unit, logged_hours, required_hours, shortfall_hours, status }.
 *       400:
 *         description: Invalid or missing period parameters.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: No Business Unit assigned or BU not in authorised scope.
 *       422:
 *         description: Validation error.
 */
router.get(
  '/employee-work-log-compliance',
  authenticateMultiBU,
  validate(complianceReportQuerySchema, 'query'),
  controller.getReport
);

/**
 * @swagger
 * /reports/employee-work-log-compliance/remind:
 *   post:
 *     summary: >
 *       Send a work-log reminder email directly to an employee who is below
 *       the required hours threshold.  The backend re-verifies the employee's
 *       hours before sending — will reject if the employee is already complete.
 *     tags: [EmployeeWorkLogCompliance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employeeId]
 *             properties:
 *               employeeId:
 *                 type: integer
 *                 description: Target employee ID.
 *               date:
 *                 type: string
 *                 format: date
 *                 description: DATE mode period (mutually exclusive with month+year).
 *               month:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 12
 *                 description: MONTH mode — must be paired with year.
 *               year:
 *                 type: integer
 *                 minimum: 2000
 *     responses:
 *       200:
 *         description: >
 *           { message, employee: { id, full_name, employee_code, email },
 *           period, logged_hours, required_hours, shortfall_hours }
 *       400:
 *         description: >
 *           Employee already meets the threshold, no email configured, or
 *           invalid period.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: >
 *           Employee is outside the caller's authorised scope — reminder
 *           blocked.
 *       404:
 *         description: Employee not found.
 *       422:
 *         description: Validation error.
 *       502:
 *         description: Email delivery failed.
 */
router.post(
  '/employee-work-log-compliance/remind',
  authenticateMultiBU,
  validate(complianceReminderBodySchema),
  controller.sendReminder
);

/**
 * @swagger
 * /reports/employee-work-log-compliance/remind-bulk:
 *   post:
 *     summary: >
 *       Send work-log reminder emails to multiple employees at once.
 *       Two modes: (1) supply an explicit employeeIds list ("Remind Selected"),
 *       or (2) set remindAll=true to remind every below-threshold employee
 *       in the caller's authorised scope ("Remind All"). The backend
 *       re-verifies each employee's hours — already-complete employees and
 *       employees with no email are silently skipped and listed in the
 *       response. Email failures never abort the rest of the batch.
 *     tags: [EmployeeWorkLogCompliance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               date:
 *                 type: string
 *                 format: date
 *                 description: DATE mode period (mutually exclusive with month+year).
 *               month:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 12
 *               year:
 *                 type: integer
 *                 minimum: 2000
 *               employeeIds:
 *                 type: array
 *                 items: { type: integer }
 *                 maxItems: 200
 *                 description: >
 *                   Explicit list of employee IDs to remind. Required unless
 *                   remindAll is true.
 *               remindAll:
 *                 type: boolean
 *                 default: false
 *                 description: >
 *                   When true, ignore employeeIds and remind ALL below-threshold
 *                   employees in the caller's authorised scope.
 *     responses:
 *       200:
 *         description: >
 *           { message, total, sent: [...], skipped: [...], failed: [...] }.
 *           sent: employees who received the email.
 *           skipped: already complete, no email, or not found.
 *           failed: email delivery failed (work-log data unchanged).
 *       400:
 *         description: Missing employeeIds and remindAll not set, or invalid period.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: One or more employee IDs outside caller's authorised scope.
 *       422:
 *         description: Validation error.
 */
router.post(
  '/employee-work-log-compliance/remind-bulk',
  authenticateMultiBU,
  validate(complianceReminderBulkBodySchema),
  controller.sendBulkReminder
);

module.exports = router;
