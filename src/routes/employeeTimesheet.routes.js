'use strict';

const express = require('express');
const router = express.Router();

const employeeAuth = require('../middlewares/employeeAuth');
const { validate } = require('../middlewares/validateRequest');
const {
  createEntrySchema,
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
 *     summary: All of the employee's own entries for one date
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
 *         description: Daily entries
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
 *     summary: Total hours per Service PO for one month, plus a day-by-day breakdown matrix
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
 *         description: Monthly summary
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
 *     summary: Create a self-service timesheet entry
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_id, hours, description, timesheet_date]
 *             properties:
 *               service_po_id: { type: integer }
 *               sub_project_id: { type: integer }
 *               hours: { type: number }
 *               description: { type: string }
 *               timesheet_date: { type: string, format: date }
 *     responses:
 *       201:
 *         description: Entry created
 *       400:
 *         description: Future date, or daily/monthly hour cap exceeded
 *       403:
 *         description: Service PO not mapped to this employee
 *       409:
 *         description: Duplicate entry for this date/PO
 */
router.post(
  '/entries',
  employeeAuth,
  validate(createEntrySchema),
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
