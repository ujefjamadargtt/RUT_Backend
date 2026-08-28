'use strict';

/**
 * @swagger
 * tags:
 *   name: Admins
 *   description: >
 *     Platform Admin's create + "View Admins" module — creates a bare Admin
 *     User (no Company attached), and lists/views Admins THIS Platform
 *     Admin created (isolated per Platform Admin account, same principle as
 *     /entity-admins). Admin then creates Entity Admins and BU Admins
 *     itself (see /entity-admins, /bu-admins, /companies).
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
const { validate } = require('../middlewares/validateRequest');
const { createAdminSchema, updateAdminSchema, listAdminsQuerySchema } = require('../validations/adminValidation');
const adminController = require('../controllers/adminController');

/**
 * @swagger
 * /admins:
 *   post:
 *     summary: Create a new Admin user (Platform Admin only)
 *     tags: [Admins]
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
 *               email: { type: string, example: "admin@example.com" }
 *               password: { type: string, example: "Str0ng!Pass" }
 *     responses:
 *       201:
 *         description: Admin created
 *       409:
 *         description: Email already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requirePlatformAdmin,
  validate(createAdminSchema),
  adminController.create
);

/**
 * @swagger
 * /admins:
 *   get:
 *     summary: List Admins created by the calling Platform Admin
 *     tags: [Admins]
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
 *         description: Paginated Admin list
 */
router.get(
  '/',
  authenticate,
  requirePlatformAdmin,
  validate(listAdminsQuerySchema, 'query'),
  adminController.getAll
);

/**
 * @swagger
 * /admins/{id}:
 *   get:
 *     summary: Get a single Admin (must have been created by the calling Platform Admin)
 *     tags: [Admins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Admin record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  requirePlatformAdmin,
  adminController.getById
);

/**
 * @swagger
 * /admins/{id}:
 *   put:
 *     summary: Edit an Admin (Platform Admin only)
 *     tags: [Admins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Admin updated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id',
  authenticate,
  requirePlatformAdmin,
  validate(updateAdminSchema),
  adminController.update
);

module.exports = router;
