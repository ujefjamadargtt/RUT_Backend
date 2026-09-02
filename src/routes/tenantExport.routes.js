'use strict';

/**
 * @swagger
 * tags:
 *   name: TenantExport
 *   description: >
 *     Admin-level Tenant Data Export — one Excel workbook (All BUs, Service
 *     POs BU Wise, BU Wise Employees, Employee Work Logs, Employees Not
 *     Filled Timesheet) scoped to every Business Unit the caller owns.
 *     Mounted at the same /reports base path as report.routes.js /
 *     managementReport.routes.js — path is disjoint from both.
 */

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const requireEntityAdminOrAdmin = require('../middlewares/requireEntityAdminOrAdmin');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');
const { validate } = require('../middlewares/validateRequest');
const { tenantDataExportQuerySchema } = require('../validations/tenantExportValidation');
const tenantExportController = require('../controllers/tenantExportController');

/**
 * @swagger
 * /reports/tenant-data-export:
 *   get:
 *     summary: Export the full tenant (every owned Business Unit) as one multi-sheet Excel workbook — Admin / Entity Admin only
 *     tags: [TenantExport]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Reporting month for the Employee Work Logs / Not Filled Timesheet sheets
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Tenant_Data_Export_YYYY-MM.xlsx
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet: {}
 *       401: { description: Unauthorized }
 *       403: { description: Restricted to Admin or Entity Admin }
 *       422: { description: month and year are required }
 */
router.get(
  '/tenant-data-export',
  heavyReportLimiter,
  authenticateBase,
  requireEntityAdminOrAdmin,
  validate(tenantDataExportQuerySchema, 'query'),
  tenantExportController.exportTenantData
);

module.exports = router;
