'use strict';

/**
 * @swagger
 * tags:
 *   name: BU Heads
 *   description: >
 *     "BU Head Master" — Admin/Entity Admin's module for creating and
 *     managing BU Head users (same form/capability access as BU Admin, but
 *     scoped to a SET of existing Companies via bu_head_company_mappings
 *     rather than a single company_id). BU Head never creates a Company —
 *     see /companies for that flow. Gated by requireEntityAdminOrAdmin.js,
 *     the same middleware entityBuAdmin.routes.js (BU Admin Master) uses.
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requireEntityAdminOrAdmin = require('../middlewares/requireEntityAdminOrAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  createBuHeadSchema,
  updateBuHeadSchema,
  setStatusSchema,
  mapCompaniesSchema,
  listBuHeadsQuerySchema,
} = require('../validations/buHeadValidation');
const buHeadController = require('../controllers/buHeadController');

/**
 * @swagger
 * /bu-heads:
 *   post:
 *     summary: Create a new BU Head (Admin or Entity Admin only)
 *     tags: [BU Heads]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: BU Head created
 *       403:
 *         description: One or more company_ids is not one of the caller's own Entities' BUs
 *       409:
 *         description: Email or employee code already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(createBuHeadSchema),
  buHeadController.create
);

/**
 * @swagger
 * /bu-heads:
 *   get:
 *     summary: List BU Heads across the caller's owned Entities
 *     tags: [BU Heads]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated BU Head list
 */
router.get(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(listBuHeadsQuerySchema, 'query'),
  buHeadController.getAll
);

/**
 * @swagger
 * /bu-heads/{id}:
 *   get:
 *     summary: Get a single BU Head (must belong to the caller's owned Entities)
 *     tags: [BU Heads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: BU Head record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  buHeadController.getById
);

/**
 * @swagger
 * /bu-heads/{id}:
 *   put:
 *     summary: Edit a BU Head
 *     tags: [BU Heads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: BU Head updated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(updateBuHeadSchema),
  buHeadController.update
);

/**
 * @swagger
 * /bu-heads/{id}/status:
 *   patch:
 *     summary: Activate or deactivate a BU Head
 *     tags: [BU Heads]
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
  buHeadController.setStatus
);

/**
 * @swagger
 * /bu-heads/{id}/companies:
 *   get:
 *     summary: List the BUs (Companies) mapped to a BU Head
 *     tags: [BU Heads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Mapped BU list
 *       404:
 *         description: Not found
 */
router.get(
  '/:id/companies',
  authenticate,
  requireEntityAdminOrAdmin,
  buHeadController.getMappedCompanies
);

/**
 * @swagger
 * /bu-heads/{id}/companies:
 *   post:
 *     summary: Map one or more additional BUs (Companies) to a BU Head
 *     tags: [BU Heads]
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
 *             required: [company_ids]
 *             properties:
 *               company_ids: { type: array, items: { type: integer }, example: [52, 53] }
 *     responses:
 *       201:
 *         description: BUs mapped
 *       403:
 *         description: One or more company_ids is not one of the caller's own Entities' BUs
 *       404:
 *         description: BU Head not found
 *       409:
 *         description: A company_id is already mapped to this BU Head
 */
router.post(
  '/:id/companies',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(mapCompaniesSchema),
  buHeadController.mapCompanies
);

/**
 * @swagger
 * /bu-heads/{id}/companies/{companyId}:
 *   delete:
 *     summary: Unmap a single BU (Company) from a BU Head — removes only the mapping
 *     tags: [BU Heads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: BU unmapped
 *       404:
 *         description: BU Head or mapping not found
 */
router.delete(
  '/:id/companies/:companyId',
  authenticate,
  requireEntityAdminOrAdmin,
  buHeadController.unmapCompany
);

module.exports = router;
