'use strict';

const express = require('express');
const router = express.Router();

const employeeAuth = require('../middlewares/employeeAuth');
const { validate } = require('../middlewares/validateRequest');
const {
  submitMonthlyWorkLogSchema,
  monthYearQuerySchema,
} = require('../validations/employeeMonthlyWorkLogValidation');
const controller = require('../controllers/employeeMonthlyWorkLogController');

/**
 * @swagger
 * tags:
 *   name: Employee Monthly Work Log
 *   description: >
 *     Employee Monthly Work Log — a second mode alongside Daily Work Log
 *     (see Employee Timesheet). Lets an employee submit one month's hours
 *     in a single go, only once that month has ended or on its last
 *     calendar day. Stored in the same `employee_work_logs` table as Daily,
 *     dated on the month's last calendar day. Submitting a Monthly entry
 *     replaces any Daily entries already in that month; resubmitting
 *     updates the existing Monthly entry rather than duplicating it.
 *     Requires an Employee access token, same as Daily.
 */

/**
 * @swagger
 * /employee-timesheets/monthly:
 *   get:
 *     summary: Fetch the Monthly Work Log for one month, plus eligibility
 *     tags: [Employee Monthly Work Log]
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
 *           { month, year, work_date, eligible, service_pos: [...] } — same
 *           service_pos hierarchy shape as Daily's /daily and /monthly-summary.
 */
router.get(
  '/',
  employeeAuth,
  validate(monthYearQuerySchema, 'query'),
  controller.getMonthly
);

/**
 * @swagger
 * /employee-timesheets/monthly:
 *   post:
 *     summary: >
 *       Submit (create) the Monthly Work Log for one month. Only allowed
 *       once the month has ended, or on its last calendar day. Deletes
 *       every existing entry (Daily or Monthly) for that month and inserts
 *       the given entries dated on the month's last calendar day.
 *     tags: [Employee Monthly Work Log]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [month, year, entries]
 *             properties:
 *               month: { type: integer }
 *               year: { type: integer }
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
 *         description: The month's Monthly Work Log after the save
 *       400:
 *         description: 176-hour cap exceeded, or duplicate (service_po_id, hierarchy_node_id) within the payload
 *       403:
 *         description: A Service PO in the payload is not mapped to this employee
 *       422:
 *         description: Selected month is not yet eligible for Monthly Work Log
 */
router.post(
  '/',
  employeeAuth,
  validate(submitMonthlyWorkLogSchema),
  controller.submitMonthly
);

/**
 * @swagger
 * /employee-timesheets/monthly:
 *   put:
 *     summary: Update the existing Monthly Work Log for one month (same as POST — upsert)
 *     tags: [Employee Monthly Work Log]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The month's Monthly Work Log after the save
 */
router.put(
  '/',
  employeeAuth,
  validate(submitMonthlyWorkLogSchema),
  controller.submitMonthly
);

/**
 * @swagger
 * /employee-timesheets/monthly:
 *   delete:
 *     summary: Delete the Monthly Work Log for one month
 *     tags: [Employee Monthly Work Log]
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
 *         description: Monthly Work Log deleted
 */
router.delete(
  '/',
  employeeAuth,
  validate(monthYearQuerySchema, 'query'),
  controller.deleteMonthly
);

module.exports = router;
