'use strict';

/**
 * @swagger
 * tags:
 *   name: ServiceTypes
 *   description: Service type reference data endpoints
 */

const express = require('express');
const router = express.Router();

const serviceTypeController = require('../controllers/serviceTypeController');
const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const Joi = require('joi');

// ─── Inline validation schemas (service types are simple) ─────────────────────

const createServiceTypeSchema = Joi.object({
  // Only meaningful for a company-less actor (Admin/Entity Admin) — see
  // companyAccessControlService.resolveCreateCompanyId(). A BU-scoped
  // actor's own req.companyId always wins over this field.
  company_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Business Unit (company_id) must be a number.',
  }),
  service_type_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .messages({
      'string.min': 'Service type name must be at least 2 characters.',
      'string.max': 'Service type name cannot exceed 100 characters.',
      'string.empty': 'Service type name is required.',
      'any.required': 'Service type name is required.',
    }),
  service_category_id: Joi.number().integer().positive().optional().allow(null).messages({
    'number.base': 'Service category ID must be a number.',
    'number.positive': 'Service category ID must be a positive integer.',
  }),
});

const updateServiceTypeSchema = Joi.object({
  service_type_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .optional()
    .messages({
      'string.min': 'Service type name must be at least 2 characters.',
      'string.max': 'Service type name cannot exceed 100 characters.',
    }),
  service_category_id: Joi.number().integer().positive().optional().allow(null).messages({
    'number.base': 'Service category ID must be a number.',
    'number.positive': 'Service category ID must be a positive integer.',
  }),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update.' });

const listServiceTypeQuerySchema = Joi.object({
  search: Joi.string().trim().max(100).optional().allow(''),
  service_category_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'Service category ID must be a number.',
    'number.positive': 'Service category ID must be a positive integer.',
  }),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /service-types:
 *   get:
 *     summary: Get all service types
 *     tags: [ServiceTypes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of service types
 */
router.get(
  '/',
  authenticate,
  validate(listServiceTypeQuerySchema, 'query'),
  serviceTypeController.getAllServiceTypes
);

/**
 * @swagger
 * /service-types/{id}:
 *   get:
 *     summary: Get a single service type by ID
 *     tags: [ServiceTypes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Service type record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  serviceTypeController.getServiceTypeById
);

/**
 * @swagger
 * /service-types:
 *   post:
 *     summary: Create a new service type
 *     tags: [ServiceTypes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_type_name]
 *             properties:
 *               service_type_name:
 *                 type: string
 *               service_category_id:
 *                 type: integer
 *                 description: ID of the service category
 *     responses:
 *       201:
 *         description: Service type created
 *       409:
 *         description: Name already exists
 */
router.post(
  '/',
  authenticate,
  validate(createServiceTypeSchema),
  serviceTypeController.createServiceType
);

/**
 * @swagger
 * /service-types/{id}:
 *   put:
 *     summary: Update a service type
 *     tags: [ServiceTypes]
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
 *             properties:
 *               service_type_name:
 *                 type: string
 *               service_category_id:
 *                 type: integer
 *                 description: ID of the service category
 *     responses:
 *       200:
 *         description: Service type updated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id',
  authenticate,
  validate(updateServiceTypeSchema),
  serviceTypeController.updateServiceType
);

/**
 * @swagger
 * /service-types/{id}:
 *   delete:
 *     summary: Soft-delete a service type
 *     tags: [ServiceTypes]
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
  serviceTypeController.deleteServiceType
);

module.exports = router;
