'use strict';

/**
 * @swagger
 * tags:
 *   name: ServiceCategories
 *   description: Service category reference data endpoints
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');

const serviceCategoryController = require('../controllers/serviceCategoryController');
const authenticate = require('../middlewares/auth');
// GET-only: lets a BU-scoped caller mapped to more than one Business Unit
// omit X-Company-Id instead of hitting resolveCompany.js's 400 — see
// resolveReportCompanyScope.js. (Service Category is actually a single
// GLOBAL master now — see serviceCategoryService.js — so this mainly just
// removes the header requirement; there's no per-BU data split to
// aggregate.) Writes below keep the full `authenticate` chain unchanged.
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
const authenticateReadMultiBU = [authenticate.authenticateIdentity, resolveReportCompanyScope];
const { validate } = require('../middlewares/validateRequest');

const WRITE_ROLES = ['Finance', 'Management'];

const createSchema = Joi.object({
  // Only meaningful for a company-less actor (Admin/Entity Admin) — see
  // companyAccessControlService.resolveCreateCompanyId(). A BU-scoped
  // actor's own req.companyId always wins over this field.
  company_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Business Unit (company_id) must be a number.',
  }),
  name: Joi.string().trim().min(2).max(100).required().messages({
    'string.min': 'Name must be at least 2 characters.',
    'string.max': 'Name cannot exceed 100 characters.',
    'any.required': 'Name is required.',
  }),
  status: Joi.string().valid('active', 'inactive').default('active'),
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional().messages({
    'string.min': 'Name must be at least 2 characters.',
    'string.max': 'Name cannot exceed 100 characters.',
  }),
  status: Joi.string().valid('active', 'inactive').optional(),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update.' });

const listQuerySchema = Joi.object({
  search: Joi.string().trim().max(100).optional().allow(''),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /service-categories:
 *   get:
 *     summary: Get all service categories
 *     tags: [ServiceCategories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *     responses:
 *       200:
 *         description: List of service categories
 */
router.get(
  '/',
  authenticateReadMultiBU,
  validate(listQuerySchema, 'query'),
  serviceCategoryController.getAllServiceCategories
);

/**
 * @swagger
 * /service-categories/{id}:
 *   get:
 *     summary: Get a single service category by ID
 *     tags: [ServiceCategories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Service category record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticateReadMultiBU,
  serviceCategoryController.getServiceCategoryById
);

/**
 * @swagger
 * /service-categories:
 *   post:
 *     summary: Create a new service category
 *     tags: [ServiceCategories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 100
 *               status:
 *                 type: string
 *                 enum: [active, inactive]
 *     responses:
 *       201:
 *         description: Service category created
 *       409:
 *         description: Name already exists
 */
router.post(
  '/',
  authenticate,
  validate(createSchema),
  serviceCategoryController.createServiceCategory
);

/**
 * @swagger
 * /service-categories/{id}:
 *   put:
 *     summary: Update a service category
 *     tags: [ServiceCategories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 100
 *               status:
 *                 type: string
 *                 enum: [active, inactive]
 *     responses:
 *       200:
 *         description: Service category updated
 *       404:
 *         description: Not found
 *       409:
 *         description: Name already exists
 */
router.put(
  '/:id',
  authenticate,
  validate(updateSchema),
  serviceCategoryController.updateServiceCategory
);

/**
 * @swagger
 * /service-categories/{id}:
 *   delete:
 *     summary: Soft-delete a service category
 *     tags: [ServiceCategories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Deleted successfully
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  authenticate,
  serviceCategoryController.deleteServiceCategory
);

module.exports = router;
