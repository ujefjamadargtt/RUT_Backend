'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  createEmployeeSchema,
  updateEmployeeSchema,
  resetEmployeePasswordSchema,
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
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active employee list
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
 *                   Date of Joining, Date of Leaving, Status
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

/**
 * @swagger
 * /employees/{id}/reset-password:
 *   put:
 *     summary: Admin-side reset of an Employee's Self Timesheet login password
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
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Password reset
 *       404:
 *         description: Not found
 */
router.put(
  '/:id/reset-password',
  authenticate,
  validate(resetEmployeePasswordSchema),
  employeeController.resetPassword
);

module.exports = router;
