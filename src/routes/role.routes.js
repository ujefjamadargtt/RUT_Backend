'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
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
 *   description: Role management (Management only for write operations)
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
  roleController.delete
);

module.exports = router;
