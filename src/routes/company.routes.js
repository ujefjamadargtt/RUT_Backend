'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requireEntityAdminOrAdmin = require('../middlewares/requireEntityAdminOrAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuerySchema,
} = require('../validations/companyValidation');
const companyController = require('../controllers/companyController');

/**
 * @swagger
 * tags:
 *   name: Companies
 *   description: >
 *     Company provisioning — Entity Admin only (repurposed from Platform
 *     Admin when Entity Admin was introduced; see
 *     database/migrations/20260826_add_entity_admin_role.sql). Every
 *     endpoint is scoped to the calling Entity Admin's own owned Entities.
 */

/**
 * @swagger
 * /companies:
 *   get:
 *     summary: List companies under the caller's owned Entities (Entity Admin only)
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Company list
 *       403:
 *         description: Not an Entity Admin
 */
router.get(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(listCompaniesQuerySchema, 'query'),
  companyController.getAll
);

/**
 * @swagger
 * /companies/{id}:
 *   get:
 *     summary: Get a single company by ID (must be under the caller's owned Entities)
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Company record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  companyController.getById
);

/**
 * @swagger
 * /companies:
 *   post:
 *     summary: Create a company and its first BU Admin (Entity Admin only)
 *     description: >
 *       Transactional — a company is never created without an owner. If
 *       admin-user creation fails, the company insert rolls back too.
 *       entity_id must be one of the calling Entity Admin's own owned
 *       Entities (403 otherwise).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entity_id, company_code, company_name, admin_email, admin_password]
 *             properties:
 *               entity_id: { type: integer }
 *               company_code: { type: string, example: "ACME" }
 *               company_name: { type: string, example: "Acme Corporation" }
 *               admin_email: { type: string, example: "admin@acme.com" }
 *               admin_password: { type: string, example: "Str0ng!Pass" }
 *     responses:
 *       201:
 *         description: Company and BU Admin created
 *       403:
 *         description: entity_id does not belong to the caller
 *       409:
 *         description: Company code or admin email already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(createCompanySchema),
  companyController.create
);

/**
 * @swagger
 * /companies/{id}:
 *   patch:
 *     summary: Update a company's name/status (must be under the caller's owned Entities)
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Company updated
 *       404:
 *         description: Not found
 *       422:
 *         description: Validation error
 */
router.patch(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(updateCompanySchema),
  companyController.update
);

module.exports = router;
