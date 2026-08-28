'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const resolveCompany = require('../middlewares/resolveCompany');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const {
  createEmployeeSchema,
  updateEmployeeSchema,
} = require('../validations/employeeValidation');
const employeeController = require('../controllers/employeeController');
const { handleEmployeeUpload } = require('../middlewares/upload');
const { importLimiter } = require('../middlewares/rateLimiters');

/**
 * @swagger
 * tags:
 *   name: Employees
 *   description: Employee management endpoints
 */

/**
 * @swagger
 * /employees/active/list:
 *   get:
 *     summary: Get all active employees (lightweight list for dropdowns)
 *     description: |
 *       Without `service_po_id`, behavior is unchanged: scoped via the
 *       caller's usual per-role access rules.
 *
 *       With `service_po_id`, this becomes the Service PO -> Map Employees
 *       screen's data source: the caller's per-role "own team" restriction
 *       is bypassed entirely in favor of their FULL authorized Admin/
 *       company/tenant scope — every Business Unit they manage, not just
 *       the Service PO's own BU or the currently selected Global BU. The
 *       Service PO id itself is still verified against the caller's
 *       tenant scope; an unknown or out-of-scope id 404s.
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: service_po_id
 *         schema: { type: integer }
 *         description: Switches to the Service PO -> Map Employees scope described above.
 *     responses:
 *       200:
 *         description: Active employee list
 *       404:
 *         description: service_po_id given but not found in the caller's tenant scope
 */
// NOTE: Static routes must be declared BEFORE /:id to avoid being parsed as an id parameter.

/**
 * @swagger
 * /employees/import:
 *   post:
 *     summary: Bulk-import employees from an Excel or CSV file
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: >
 *                   .xlsx or .csv file. Expected columns (header row flexible):
 *                   Employee Code*, Full Name*, Designation, Total Experience,
 *                   Company Experience, Email ID, Resource Description,
 *                   Date of Joining, Date of Leaving, Status, Business Units.
 *                   Business Units is optional — a comma-separated list of
 *                   Business Unit names, resolved within the importing
 *                   actor's own authorized Business Units (never the
 *                   currently-selected Global Business Unit). Left blank, the
 *                   employee is imported with no Business Unit mapping. A
 *                   name that doesn't resolve fails that row with a
 *                   validation error rather than being silently ignored.
 *     responses:
 *       200:
 *         description: Import summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                   description: Total rows in the file
 *                 imported:
 *                   type: integer
 *                   description: Rows successfully inserted
 *                 skipped:
 *                   type: integer
 *                   description: Rows skipped due to validation or DB errors
 *                 error_rows:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       row:
 *                         type: integer
 *                         description: 1-based row number in the file
 *                       errors:
 *                         type: array
 *                         items:
 *                           type: string
 *                 credentials:
 *                   type: array
 *                   description: >
 *                     One entry per imported row that had an Email ID —
 *                     a linked login account was created for it. The
 *                     temporary password is only ever returned here, once.
 *                   items:
 *                     type: object
 *                     properties:
 *                       employee_code:
 *                         type: string
 *                       email:
 *                         type: string
 *                       temporaryPassword:
 *                         type: string
 *       400:
 *         description: No file attached
 *       422:
 *         description: File format error (unreadable or no recognised header)
 */
router.post(
  '/import',
  authenticate,
  importLimiter,
  handleEmployeeUpload,
  employeeController.importEmployees
);

router.get(
  '/active/list',
  authenticate,
  employeeController.getActiveEmployees
);

/**
 * @swagger
 * /employees/eligible-delivery-heads:
 *   get:
 *     summary: Get employees eligible for Service PO Delivery Head selection
 *     description: >
 *       Active, non-deleted employees in the caller's own company. `email`
 *       is sourced from the employee's linked User account (Employee
 *       itself carries no email) and is `null` if none exists yet.
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Eligible Delivery Head employee list
 */
router.get(
  '/eligible-delivery-heads',
  authenticate,
  employeeController.getEligibleDeliveryHeads
);

/**
 * @swagger
 * /employees/eligible-managers:
 *   get:
 *     summary: Get employees eligible for Primary/Secondary Manager selection
 *     description: >
 *       Active employees in the caller's scope holding a role capable of
 *       managing Employees (Manager, Service PO Admin, Project Admin, or
 *       anything with manager.view_mapped_employees in its effective
 *       capability set) — the same eligibility rule enforced when the
 *       Employee Create/Edit form actually saves a Primary/Secondary
 *       Manager, so every value offered here is guaranteed acceptable.
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Eligible Manager employee list
 */
router.get(
  '/eligible-managers',
  authenticate,
  employeeController.getEligibleManagers
);

/**
 * @swagger
 * /employees:
 *   get:
 *     summary: List employees with pagination, search, and filters
 *     tags: [Employees]
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
 *         description: Search on full_name, employee_code, designation
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: designation
 *         schema: { type: string }
 *       - in: query
 *         name: business_unit_id
 *         schema: { type: integer }
 *         description: Narrows the list to employees mapped to this ONE Business Unit — stacks on top of (never widens) the caller's own access scope.
 *       - in: query
 *         name: service_po_id
 *         schema: { type: integer }
 *         description: >
 *           Service PO -> Map Employees data source. Bypasses the caller's
 *           normal per-role "own team" scope in favor of their FULL
 *           authorized Admin/company/tenant scope (every Business Unit they
 *           manage, not just the Service PO's own BU or the currently
 *           selected Global BU). An unknown/out-of-scope id 404s.
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, default: full_name }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC], default: ASC }
 *     responses:
 *       200:
 *         description: Paginated employee list
 */
router.get(
  '/',
  authenticate,
  employeeController.getAll
);

/**
 * @swagger
 * /employees/{id}:
 *   get:
 *     summary: Get a single employee by ID
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Employee record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  employeeController.getById
);

/**
 * @swagger
 * /employees/{id}/mappings:
 *   get:
 *     summary: Get an employee's current Role & Business Unit mappings
 *     description: >
 *       Dedicated data source for the Action → Role & BU Mapping screen
 *       (moved out of the Employee Drawer). Returns the SAME data
 *       GET /employees/{id} already carries (role_ids/roles/
 *       business_unit_ids/business_units) as a lighter-weight, mapping-only
 *       payload — reuses the same employee_roles/employee_business_units
 *       tables and the same object-level access check, not a separate
 *       mapping mechanism.
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Employee's current role/BU mappings
 *       404:
 *         description: Not found
 */
router.get(
  '/:id/mappings',
  authenticate,
  employeeController.getMappings
);

/**
 * @swagger
 * /employees/{id}/business-units:
 *   get:
 *     summary: Get an employee's mapped Business Units ("Mapped BUs")
 *     description: >
 *       Dedicated data source for loading Mapped BUs by empId — the login
 *       response no longer carries this data; the frontend fetches it
 *       here using the employee id from the login/select-role response.
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Employee's mapped Business Units
 *       404:
 *         description: Not found
 */
router.get(
  '/:id/business-units',
  authenticate.authenticateIdentity,
  (req, res, next) => {
    // Self-lookup ("what are MY mapped BUs") must work even before the
    // caller has an active BU/company context to put in X-Company-Id —
    // that's the whole point of this endpoint for a multi-BU actor (see
    // employeeService.getBusinessUnits' doc comment). Looking up SOME OTHER
    // employee's BUs still needs the normal company-scoped authorization,
    // so resolveCompany runs exactly as on every other route in that case.
    const requestedId = parseInt(req.params.id, 10);
    if (!isNaN(requestedId) && requestedId === req.employeeId) {
      return next();
    }
    return resolveCompany(req, res, next);
  },
  employeeController.getBusinessUnits
);

/**
 * @swagger
 * /employees:
 *   post:
 *     summary: Create a new employee
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateEmployee'
 *     responses:
 *       201:
 *         description: Employee created
 *       409:
 *         description: Duplicate employee code
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  authorize('hr.create_employee'),
  validate(createEmployeeSchema),
  employeeController.create
);

/**
 * @swagger
 * /employees/{id}:
 *   put:
 *     summary: Update an employee
 *     tags: [Employees]
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
 *             $ref: '#/components/schemas/UpdateEmployee'
 *     responses:
 *       200:
 *         description: Employee updated
 *       404:
 *         description: Not found
 *       409:
 *         description: Duplicate employee code
 */
router.put(
  '/:id',
  authenticate,
  validate(updateEmployeeSchema),
  employeeController.update
);

/**
 * @swagger
 * /employees/{id}:
 *   delete:
 *     summary: Deactivate an employee (soft delete)
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Employee deactivated
 *       404:
 *         description: Not found
 *       409:
 *         description: Employee allocated to active PO — cannot deactivate
 */
router.delete(
  '/:id',
  authenticate,
  employeeController.delete
);

// Resetting an Employee's login password is now a User Master operation —
// use PUT /api/v1/users/:id (userService.update supports a `password`
// field) against the Employee's linked users.id, since Employee itself no
// longer carries a password column (see database/migrations/
// 20260842_employees_drop_login_columns.sql). No dedicated endpoint here.

module.exports = router;
