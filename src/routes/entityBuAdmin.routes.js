'use strict';

/**
 * @swagger
 * tags:
 *   name: BU Admin Master
 *   description: >
 *     Entity Admin only. View/edit/activate/deactivate BU Admin Users
 *     across every Company under the calling Entity Admin's owned
 *     Entities. Cannot create Managers, Employees, Head Managers, or BU HR
 *     Heads — creating a BU Admin happens via POST /api/v1/companies
 *     (creates the Company + its first BU Admin together).
 */

const express = require('express');
const router = express.Router();

const entityBuAdminController = require('../controllers/entityBuAdminController');
const authenticate = require('../middlewares/auth');
const requireEntityAdminOrAdmin = require('../middlewares/requireEntityAdminOrAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  updateBuAdminSchema,
  setStatusSchema,
  listBuAdminsQuerySchema,
} = require('../validations/entityBuAdminValidation');

/**
 * @swagger
 * /bu-admins:
 *   get:
 *     summary: List BU Admins across the caller's owned Entities
 *     tags: [BU Admin Master]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated BU Admin list
 */
router.get(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(listBuAdminsQuerySchema, 'query'),
  entityBuAdminController.getAll
);

/**
 * @swagger
 * /bu-admins/{id}:
 *   get:
 *     summary: Get a single BU Admin (must belong to the caller's owned Entities)
 *     tags: [BU Admin Master]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: BU Admin record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  entityBuAdminController.getById
);

/**
 * @swagger
 * /bu-admins/{id}:
 *   put:
 *     summary: Edit a BU Admin
 *     tags: [BU Admin Master]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: BU Admin updated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(updateBuAdminSchema),
  entityBuAdminController.update
);

/**
 * @swagger
 * /bu-admins/{id}/status:
 *   patch:
 *     summary: Activate or deactivate a BU Admin
 *     tags: [BU Admin Master]
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
  requireEntityAdminOrAdmin,
  validate(setStatusSchema),
  entityBuAdminController.setStatus
);

module.exports = router;
