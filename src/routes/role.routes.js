'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  createRoleSchema,
  updateRoleSchema,
} = require('../validations/roleValidation');
const roleController = require('../controllers/roleController');

/**
 * @swagger
 * tags:
 *   name: Roles
 *   description: Role management (Platform Admin only)
 */

/**
 * Role Master — CRUD and single-role detail reveal the complete system role
 * hierarchy (hierarchy_rank, inherits_role_id, is_system, ...), so those
 * routes (GET /:id, POST, PUT, DELETE) are gated by requirePlatformAdmin,
 * NOT the generic authorize() middleware: authorize()'s rank-based
 * senior-tier bypass (ranks 1-4) would let Admin/Entity Admin/BU Admin
 * straight through, but the seeded RBAC data (role_capabilities:
 * platform.manage_role_master) grants Role Master management to Platform
 * Admin ONLY — the same reasoning requireAdmin.js/requirePlatformAdmin.js
 * already document for other Platform-Admin-exclusive actions (e.g.
 * creating an Admin).
 *
 * GET / (the plain list) is the one exception, deliberately left open to
 * ANY authenticated role via `authenticate` alone: it's the role-selection
 * dropdown source for non-Platform-Admin flows like BU Admin's Create
 * Employee / Create User screens (see userService.js's ROLE_CREATION_MATRIX
 * / assertActorCanAssignRoles, which is what actually enforces who may be
 * assigned which role — this list endpoint is read-only and never the
 * authorization boundary itself). roleRepository.findAll() already excludes
 * "Platform Admin" from the result set regardless of caller.
 */

/**
 * @swagger
 * /roles:
 *   get:
 *     summary: List all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search on role_name
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, default: role_name }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC], default: ASC }
 *     responses:
 *       200:
 *         description: Role list
 */
router.get(
  '/',
  authenticate,
  roleController.getAll
);

/**
 * @swagger
 * /roles/{id}:
 *   get:
 *     summary: Get a single role by ID
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Role record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  requirePlatformAdmin,
  roleController.getById
);

/**
 * @swagger
 * /roles:
 *   post:
 *     summary: Create a new role (Management only)
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateRole'
 *     responses:
 *       201:
 *         description: Role created
 *       409:
 *         description: Role name already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requirePlatformAdmin,
  validate(createRoleSchema),
  roleController.create
);

/**
 * @swagger
 * /roles/{id}:
 *   put:
 *     summary: Update a role (Management only)
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateRole'
 *     responses:
 *       200:
 *         description: Role updated
 *       404:
 *         description: Not found
 *       409:
 *         description: Role name conflict
 */
router.put(
  '/:id',
  authenticate,
  requirePlatformAdmin,
  validate(updateRoleSchema),
  roleController.update
);

/**
 * @swagger
 * /roles/{id}:
 *   delete:
 *     summary: Permanently delete a role (Management only)
 *     description: >
 *       Hard delete. Blocked if the role is assigned to any user (via
 *       users.role_id or the user_roles table), in which case neither the
 *       role nor its role_form_mapping rows are touched. Otherwise, the
 *       role's role_form_mapping rows and the role row itself are deleted
 *       in a single transaction.
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Role deleted
 *       404:
 *         description: Role not found
 *       409:
 *         description: Role is in use and cannot be deleted because it is assigned to one or more users
 */
router.delete(
  '/:id',
  authenticate,
  requirePlatformAdmin,
  roleController.delete
);

module.exports = router;
