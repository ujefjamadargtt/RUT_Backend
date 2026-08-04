'use strict';

const express = require('express');
const router = express.Router();

const employeeAuth = require('../middlewares/employeeAuth');
const { validate } = require('../middlewares/validateRequest');
const {
  replaceDailyEntriesSchema,
  updateEntrySchema,
  monthYearQuerySchema,
  dailyQuerySchema,
} = require('../validations/employeeTimesheetValidation');
const controller = require('../controllers/employeeTimesheetController');

/**
 * @swagger
 * tags:
 *   name: Employee Timesheet
 *   description: >
 *     Employee Self Timesheet module — an Employee manages only their own
 *     entries, against Service POs they are mapped to. Requires an Employee
 *     access token (issued by the dynamic /auth/login), never the User token.
 *     These entries are stored in `employee_work_logs` (a draft table) and
 *     never directly in the official `timesheets` table — an Admin must run
 *     "Sync Employee Work Logs" on the Admin Timesheet page before an entry
 *     becomes part of the official Timesheet / Admin Reports.
 */

/**
 * @swagger
 * /employee-timesheets/calendar:
 *   get:
 *     summary: Calendar summary for one month (date, totalHours, hasEntries, futureDisabled)
 *     tags: [Employee Timesheet]
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
 *     responses:
 *       200:
 *         description: Calendar summary
 */
router.get(
  '/calendar',
  employeeAuth,
  validate(monthYearQuerySchema, 'query'),
  controller.getCalendar
);

/**
 * @swagger
 * /employee-timesheets/daily:
 *   get:
 *     summary: Service PO -> Parent -> Child hierarchy with hours-per-node, for one date
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: >
 *           { date, service_pos: [{ service_po_id, service_po_name, hours,
 *           po_total_hrs, children: [{ hierarchy_id, name, type, hours,
 *           children? }] }] } — same schema as one entry of the Monthly
 *           Summary array, so the frontend can reuse one rendering component
 *           for both.
 */
router.get(
  '/daily',
  employeeAuth,
  validate(dailyQuerySchema, 'query'),
  controller.getDaily
);

/**
 * @swagger
 * /employee-timesheets/monthly-summary:
 *   get:
 *     summary: Per-date Service PO -> Parent -> Child hierarchy with hours-per-node, for one month
 *     tags: [Employee Timesheet]
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
 *     responses:
 *       200:
 *         description: >
 *           Array of { date, service_pos: [{ service_po_id, service_po_name,
 *           hours, po_total_hrs, children: [{ hierarchy_id, name, type,
 *           hours, children? }] }] } — one entry per calendar date, every
 *           mapped Service PO and its complete hierarchy always present
 *           (hours default to 0).
 */
router.get(
  '/monthly-summary',
  employeeAuth,
  validate(monthYearQuerySchema, 'query'),
  controller.getMonthlySummary
);

/**
 * @swagger
 * /employee-timesheets/projects:
 *   get:
 *     summary: Service POs mapped to the logged-in employee (Project Loading)
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Mapped project list
 */
router.get(
  '/projects',
  employeeAuth,
  controller.getProjects
);

/**
 * @swagger
 * /employee-timesheets/entries:
 *   post:
 *     summary: >
 *       REPLACE SAVE the employee's complete set of timesheet entries for
 *       one date. Deletes every existing entry for (employee, date) and
 *       reinserts exactly the given `entries` list, in one transaction —
 *       never a duplicate-entry error. Pass an empty `entries` array to
 *       clear the date entirely.
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [timesheet_date, entries]
 *             properties:
 *               timesheet_date: { type: string, format: date }
 *               entries:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [service_po_id, hours, description]
 *                   properties:
 *                     service_po_id: { type: integer }
 *                     sub_project_id: { type: integer }
 *                     hierarchy_node_id: { type: integer }
 *                     hours: { type: number }
 *                     description: { type: string }
 *     responses:
 *       200:
 *         description: The date's entries after the replace (array)
 *       400:
 *         description: Future date, daily hour cap exceeded, or duplicate (service_po_id, hierarchy_node_id) within the payload
 *       403:
 *         description: A Service PO in the payload is not mapped to this employee
 *       422:
 *         description: Validation error
 */
router.post(
  '/entries',
  employeeAuth,
  validate(replaceDailyEntriesSchema),
  controller.createEntry
);

/**
 * @swagger
 * /employee-timesheets/entries/{id}:
 *   put:
 *     summary: Update the employee's own timesheet entry
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry updated
 *       404:
 *         description: Not found (or not owned by this employee)
 */
router.put(
  '/entries/:id',
  employeeAuth,
  validate(updateEntrySchema),
  controller.updateEntry
);

/**
 * @swagger
 * /employee-timesheets/entries/{id}:
 *   delete:
 *     summary: Delete the employee's own timesheet entry
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry deleted
 *       404:
 *         description: Not found (or not owned by this employee)
 */
router.delete(
  '/entries/:id',
  employeeAuth,
  controller.deleteEntry
);

module.exports = router;
