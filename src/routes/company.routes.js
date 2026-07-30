'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
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
 *   description: Platform-level company provisioning (Platform Admin only — the multi-tenancy retrofit's platform layer, sits above every company)
 */

/**
 * @swagger
 * /companies:
 *   get:
 *     summary: List all companies (Platform Admin only)
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Company list
 *       403:
 *         description: Not the platform administrator
 */
router.get(
  '/',
  authenticate,
  requirePlatformAdmin,
  validate(listCompaniesQuerySchema, 'query'),
  companyController.getAll
);

/**
 * @swagger
 * /companies/{id}:
 *   get:
 *     summary: Get a single company by ID (Platform Admin only)
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
  requirePlatformAdmin,
  companyController.getById
);

/**
 * @swagger
 * /companies:
 *   post:
 *     summary: Create a company and its first Company Admin (Platform Admin only)
 *     description: >
 *       Transactional — a company is never created without an owner. If
 *       admin-user creation fails, the company insert rolls back too.
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [company_code, company_name, admin_email, admin_password]
 *             properties:
 *               company_code: { type: string, example: "ACME" }
 *               company_name: { type: string, example: "Acme Corporation" }
 *               admin_email: { type: string, example: "admin@acme.com" }
 *               admin_password: { type: string, example: "Str0ng!Pass" }
 *     responses:
 *       201:
 *         description: Company and Company Admin created
 *       409:
 *         description: Company code or admin email already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requirePlatformAdmin,
  validate(createCompanySchema),
  companyController.create
);

/**
 * @swagger
 * /companies/{id}:
 *   patch:
 *     summary: Update a company's name/status (Platform Admin only)
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
  requirePlatformAdmin,
  validate(updateCompanySchema),
  companyController.update
);

module.exports = router;
