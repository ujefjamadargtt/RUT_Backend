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
 *     endpoint is scoped to the calling Entity Admin's own owned Entities,
 *     EXCEPT GET / (see allowCompanyListing below).
 */

/**
 * GET / is also the "load BUs" dropdown the Service PO creation flow (and
 * other BU-dependent create screens) call — a BU Admin (hierarchy_rank 4)
 * legitimately needs to load THEIR OWN mapped BUs here too, without gaining
 * Entity Admin's "every company under my owned Entities" scope. Delegates
 * unchanged to requireEntityAdminOrAdmin for Admin/Entity Admin; for a BU
 * Admin with at least one active mapped BU, sets req.employeeBUsOnly so
 * companyController.getAll returns their own mapped BUs instead. Anyone
 * else (including a 0-BU BU Admin) is rejected exactly as before.
 *
 * Uses authenticate.authenticateIdentity (not the default authenticate)
 * because resolveCompany is irrelevant to both branches here (Entity Admin/
 * Admin's scope comes from req.entityIds, not req.companyId; a BU Admin's
 * own mapped BUs come straight from req.employeeBusinessUnits) and a
 * multi-BU BU Admin must be able to load this dropdown BEFORE they have
 * picked an active BU to put in X-Company-Id — the same bootstrap
 * requirement as GET /employees/:id/business-units.
 */
const allowCompanyListing = (req, res, next) => {
  if (req.hierarchyRank === 2 || (req.userRoleName && req.userRoleName.toLowerCase() === 'entity admin')) {
    return requireEntityAdminOrAdmin(req, res, next);
  }
  if (req.hierarchyRank === 4 && (req.employeeBusinessUnits || []).length > 0) {
    req.employeeBUsOnly = true;
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Access denied. This action is restricted to Admin, Entity Admin, or a BU Admin with a mapped Business Unit.',
    code: 'ENTITY_ADMIN_OR_ADMIN_OR_BU_ADMIN_REQUIRED',
  });
};

/**
 * @swagger
 * /companies:
 *   get:
 *     summary: >
 *       List companies under the caller's owned Entities (Entity Admin/
 *       Admin), or the caller's own mapped Business Units (BU Admin)
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Company list
 *       403:
 *         description: Not an Entity Admin, Admin, or mapped BU Admin
 */
router.get(
  '/',
  authenticate.authenticateIdentity,
  allowCompanyListing,
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
 *     summary: Create a company and its first BU Admin, together with that BU Admin's Employee record (Entity Admin only)
 *     description: >
 *       Transactional — a company is never created without its BU Admin,
 *       and the BU Admin is never created without a linked Employee
 *       record and both the "BU Admin" and "Employee" roles. If any step
 *       fails, every insert in this call rolls back. company.entity_id
 *       must be one of the calling Entity Admin's own owned Entities (403
 *       otherwise). employee.* fields/validation are the same as
 *       POST /employees (see employeeValidation.createEmployeeSchema)
 *       minus Manager assignment (doesn't apply to the first User in a
 *       brand-new company) and minus email/password (collected once,
 *       under `admin`, since they're this User's login credentials —
 *       employee.email is accepted too, for form-reuse convenience, but
 *       must match admin.admin_email if provided).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [company, admin, employee]
 *             properties:
 *               company:
 *                 type: object
 *                 required: [entity_id, company_code, company_name]
 *                 properties:
 *                   entity_id: { type: integer }
 *                   company_code: { type: string, example: "ACME" }
 *                   company_name: { type: string, example: "Acme Corporation" }
 *               admin:
 *                 type: object
 *                 required: [admin_email, admin_password]
 *                 properties:
 *                   admin_email: { type: string, example: "admin@acme.com" }
 *                   admin_password: { type: string, example: "Str0ng!Pass1" }
 *               employee:
 *                 type: object
 *                 required: [employee_code, full_name]
 *                 properties:
 *                   employee_code: { type: string, example: "EMP001" }
 *                   full_name: { type: string, example: "John Doe" }
 *                   designation: { type: string, example: "Software Developer" }
 *     responses:
 *       201:
 *         description: Company, BU Admin, and linked Employee created
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
