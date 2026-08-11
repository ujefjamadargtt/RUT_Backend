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

module.exports = router;
