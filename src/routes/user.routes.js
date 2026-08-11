'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
  adminResetPasswordSchema,
} = require('../validations/userValidation');
const userController = require('../controllers/userController');

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: Portal user management
 */

/**
 * @swagger
 * /users:
 *   get:
 *     summary: List all users with pagination and filters
 *     tags: [Users]
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
 *         name: search
 *         schema: { type: string }
 *         description: Search on email
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: role_id
 *         schema: { type: integer }
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, default: created_at }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC], default: DESC }
 *     responses:
 *       200:
 *         description: Paginated user list
 */
router.get(
  '/',
  authenticate,
  userController.getAll
);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get a single user by ID
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  userController.getById
);

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create a new portal user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateUser'
 *     responses:
 *       201:
 *         description: User created
 *       409:
 *         description: Email already registered
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  validate(createUserSchema),
  userController.create
);

/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update a user record
 *     tags: [Users]
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
 *             $ref: '#/components/schemas/UpdateUser'
 *     responses:
 *       200:
 *         description: User updated
 *       404:
 *         description: Not found
 *       409:
 *         description: Email conflict
 */
router.put(
  '/:id',
  authenticate,
  validate(updateUserSchema),
  userController.update
);

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Deactivate a user (soft delete)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User deactivated
 *       403:
 *         description: Cannot deactivate own account
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  authenticate,
  userController.delete
);

/**
 * @swagger
 * /users/{id}/change-password:
 *   put:
 *     summary: Change a user's password
 *     tags: [Users]
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
 *             required: [old_password, new_password]
 *             properties:
 *               old_password:
 *                 type: string
 *               new_password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password changed
 *       400:
 *         description: Same as current or missing fields
 *       401:
 *         description: Incorrect current password
 */
router.put(
  '/:id/change-password',
  authenticate,
  validate(changePasswordSchema),
  userController.changePassword
);

/**
 * @swagger
 * /users/{id}/reset-password:
 *   put:
 *     summary: Admin-side password reset (HR or a senior admin tier only) — no old password required
 *     tags: [Users]
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
 *             required: [new_password, confirm_password]
 *             properties:
 *               new_password: { type: string }
 *               confirm_password: { type: string }
 *     responses:
 *       200:
 *         description: Password reset
 *       403:
 *         description: Not authorised
 *       404:
 *         description: User not found
 */
router.put(
  '/:id/reset-password',
  authenticate,
  validate(adminResetPasswordSchema),
  userController.resetPassword
);

module.exports = router;
