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
 *     Admin, Service PO Admin, Manager, Employee, HR — is denied with 403.
 *     See requirePlatformAdmin.js.
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
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

module.exports = router;
