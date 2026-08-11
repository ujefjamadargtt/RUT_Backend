'use strict';

/**
 * @swagger
 * tags:
 *   name: Entity Admins
 *   description: >
 *     Admin's "Manage Entity Admins" module — create/list/view/edit/
 *     activate/deactivate Entity Admin Users, scoped to the ones the
 *     calling Admin created (see entityAdminService.js). Gated by
 *     requireAdmin.js (a direct hierarchy_rank === 2 check), NOT the
 *     generic authorize() capability middleware — authorize()'s senior-tier
 *     bypass (ranks 1-4) would otherwise let Entity Admin itself through
 *     these Admin-only endpoints. Per the RBAC redesign, Platform Admin no
 *     longer creates Entity Admin directly — that's Admin's job now
 *     (Platform Admin's only user-creation action is POST /admins).
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requireAdmin = require('../middlewares/requireAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  createEntityAdminSchema,
  updateEntityAdminSchema,
  setStatusSchema,
  listEntityAdminsQuerySchema,
} = require('../validations/entityAdminValidation');
const entityAdminController = require('../controllers/entityAdminController');

/**
 * @swagger
 * /entity-admins:
 *   post:
 *     summary: Create a new Entity Admin user (Admin only)
 *     tags: [Entity Admins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: "entity.admin@example.com" }
 *               password: { type: string, example: "Str0ng!Pass" }
 *     responses:
 *       201:
 *         description: Entity Admin created
 *       409:
 *         description: Email already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requireAdmin,
  validate(createEntityAdminSchema),
  entityAdminController.create
);

/**
 * @swagger
 * /entity-admins:
 *   get:
 *     summary: List Entity Admins, platform-wide (Admin only)
 *     tags: [Entity Admins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated Entity Admin list
 */
router.get(
  '/',
  authenticate,
  requireAdmin,
  validate(listEntityAdminsQuerySchema, 'query'),
  entityAdminController.getAll
);

/**
 * @swagger
 * /entity-admins/{id}:
 *   get:
 *     summary: Get a single Entity Admin (Admin only)
 *     tags: [Entity Admins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entity Admin record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  requireAdmin,
  entityAdminController.getById
);

/**
 * @swagger
 * /entity-admins/{id}:
 *   put:
 *     summary: Edit an Entity Admin (Admin only)
 *     tags: [Entity Admins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entity Admin updated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id',
  authenticate,
  requireAdmin,
  validate(updateEntityAdminSchema),
  entityAdminController.update
);

/**
 * @swagger
 * /entity-admins/{id}/status:
 *   patch:
 *     summary: Activate or deactivate an Entity Admin (Admin only)
 *     tags: [Entity Admins]
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
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [active, inactive] }
 *     responses:
 *       200:
 *         description: Status updated
 *       404:
 *         description: Not found
 */
router.patch(
  '/:id/status',
  authenticate,
  requireAdmin,
  validate(setStatusSchema),
  entityAdminController.setStatus
);

module.exports = router;
