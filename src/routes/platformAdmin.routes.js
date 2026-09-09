'use strict';

/**
 * @swagger
 * tags:
 *   name: Platform Admin
 *   description: >
 *     Platform Admin's system-wide organization overview — one consolidated,
 *     read-only view of every BU/Entity, Project/Service PO, and User in the
 *     system. Restricted to Platform Admin (hierarchy_rank === 1) only;
 *     every other role — including Admin, Entity Admin, BU Admin, Project
 *     Admin, Project Manager, Manager, Employee, HR — is denied with 403.
 *     See requirePlatformAdmin.js.
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');
const { validate } = require('../middlewares/validateRequest');
const {
  listTotalAdminsQuerySchema,
  employeeWorkLogSyncedQuerySchema,
  employeeWorkLogSyncedExportQuerySchema,
} = require('../validations/platformAdminReportValidation');
const platformAdminController = require('../controllers/platformAdminController');

/**
 * @swagger
 * /platform-admin/organization-overview:
 *   get:
 *     summary: System-wide BU / Project / Service PO / User overview (Platform Admin only)
 *     tags: [Platform Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Consolidated organization overview
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Authenticated but not Platform Admin
 */
router.get(
  '/organization-overview',
  authenticate,
  requirePlatformAdmin,
  platformAdminController.getOrganizationOverview
);

/**
 * @swagger
 * /platform-admin/total-admins:
 *   get:
 *     summary: Total Admins tab — every Admin-role Employee, system-wide (Platform Admin only)
 *     tags: [Platform Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of every Admin on the platform
 */
router.get(
  '/total-admins',
  authenticate,
  requirePlatformAdmin,
  heavyReportLimiter,
  validate(listTotalAdminsQuerySchema, 'query'),
  platformAdminController.getTotalAdmins
);

/**
 * @swagger
 * /platform-admin/employee-work-log-synced:
 *   get:
 *     summary: >
 *       Employee Work Log tab — one row per Employee, system-wide, for the
 *       selected month, with ONLY synced hours counted (0 if none). Columns:
 *       emp code, emp name, admin, entity name, BU name, total hours (synced).
 *     tags: [Platform Admin]
 *     security:
 *       - bearerAuth: []
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
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [employee_name, employee_code, total_hours] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated Employee Work Log (synced-only) summary
 */
router.get(
  '/employee-work-log-synced',
  authenticate,
  requirePlatformAdmin,
  heavyReportLimiter,
  validate(employeeWorkLogSyncedQuerySchema, 'query'),
  platformAdminController.getEmployeeWorkLogSynced
);

/**
 * @swagger
 * /platform-admin/employee-work-log-synced/export:
 *   get:
 *     summary: >
 *       Excel export of the Employee Work Log (synced) tab — one workbook,
 *       2 sheets: "Hours > 0" and "Hours = 0".
 *     tags: [Platform Admin]
 *     security:
 *       - bearerAuth: []
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
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: .xlsx workbook, 2 sheets
 */
router.get(
  '/employee-work-log-synced/export',
  authenticate,
  requirePlatformAdmin,
  heavyReportLimiter,
  validate(employeeWorkLogSyncedExportQuerySchema, 'query'),
  platformAdminController.exportEmployeeWorkLogSynced
);

module.exports = router;
