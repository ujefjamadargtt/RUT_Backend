'use strict';

/**
 * @swagger
 * tags:
 *   name: ResourceBudgets
 *   description: Planned monthly employee/resource hours per Service PO, capped at 176 hours/employee/month across all Service POs
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const resourceBudgetController = require('../controllers/resourceBudgetController');
const {
  createResourceBudgetSchema,
  updateResourceBudgetSchema,
  bulkResourceBudgetSchema,
  listResourceBudgetQuerySchema,
} = require('../validations/resourceBudgetValidation');

// ─── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

/**
 * @swagger
 * /resource-budgets/service-po/{servicePoId}/mapped-employees:
 *   get:
 *     summary: Employees mapped/staffed to a Service PO — for the "select employees to budget hours for" screen
 *     description: >
 *       Reuses the existing employee_servicepo_mapping table (only 'active'
 *       mappings) — the same table the Employee Self Timesheet module uses
 *       to determine which Service POs an employee may log against — so no
 *       new Service PO API or mapping logic is introduced.
 *     tags: [ResourceBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Mapped employees
 *       404:
 *         description: Service PO not found
 */
router.get('/service-po/:servicePoId/mapped-employees', resourceBudgetController.getMappedEmployees);

/**
 * @swagger
 * /resource-budgets/service-po/{servicePoId}:
 *   get:
 *     summary: All resource budget records for one Service PO
 *     tags: [ResourceBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Resource budget records for the Service PO
 *       404:
 *         description: Service PO not found
 */
router.get('/service-po/:servicePoId', resourceBudgetController.listByServicePO);

/**
 * @swagger
 * /resource-budgets:
 *   get:
 *     summary: List resource budget records, optionally filtered by employee and/or month
 *     tags: [ResourceBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: emp_id
 *         required: false
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: false
 *         schema: { type: string, example: "2026-08" }
 *     responses:
 *       200:
 *         description: Matching resource budget records
 *       422:
 *         description: Validation error
 */
router.get('/', validate(listResourceBudgetQuerySchema, 'query'), resourceBudgetController.list);

/**
 * @swagger
 * /resource-budgets/bulk:
 *   post:
 *     summary: Create/update planned hours for multiple employees on one Service PO + month
 *     description: >
 *       Validates every employee's FINAL monthly total (across all Service
 *       POs) before writing anything — if even one employee would exceed
 *       176 hours/month, the entire request is rejected with 400 and no
 *       records are saved (all-or-nothing, wrapped in one DB transaction).
 *       Requires the servicepo.manage_future_budget capability.
 *     tags: [ResourceBudgets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_id, month, resources]
 *             properties:
 *               service_po_id: { type: integer }
 *               month: { type: string, example: "2026-08" }
 *               resources:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [emp_id, hours]
 *                   properties:
 *                     emp_id: { type: integer }
 *                     hours: { type: number, minimum: 0 }
 *     responses:
 *       200:
 *         description: Resource budgets saved
 *       400:
 *         description: Validation failed — see errors[] for per-employee reasons
 *       404:
 *         description: Service PO not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 *       422:
 *         description: Validation error
 */
router.post(
  '/bulk',
  authorize('servicepo.manage_future_budget'),
  validate(bulkResourceBudgetSchema),
  resourceBudgetController.bulkUpsert
);

/**
 * @swagger
 * /resource-budgets:
 *   post:
 *     summary: Create a single resource budget record
 *     description: >
 *       Rejects with 400 if a record already exists for this employee +
 *       Service PO + month, if the employee is not mapped to the Service
 *       PO, or if it would push the employee's monthly total across all
 *       Service POs above 176 hours. Requires the
 *       servicepo.manage_future_budget capability.
 *     tags: [ResourceBudgets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emp_id, service_po_id, month, hours]
 *             properties:
 *               emp_id: { type: integer }
 *               service_po_id: { type: integer }
 *               month: { type: string, example: "2026-08" }
 *               hours: { type: number, minimum: 0 }
 *     responses:
 *       201:
 *         description: Resource budget created
 *       400:
 *         description: Duplicate record, unmapped employee, or 176-hour cap exceeded
 *       404:
 *         description: Employee or Service PO not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authorize('servicepo.manage_future_budget'),
  validate(createResourceBudgetSchema),
  resourceBudgetController.create
);

/**
 * @swagger
 * /resource-budgets/{id}:
 *   put:
 *     summary: Update a resource budget record's hours
 *     description: >
 *       emp_id/service_po_id/month are immutable via update. Re-validates
 *       the 176-hour cap, correctly excluding this record's OWN existing
 *       hours from the running total before adding the new value back in.
 *       Requires the servicepo.manage_future_budget capability.
 *     tags: [ResourceBudgets]
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
 *             required: [hours]
 *             properties:
 *               hours: { type: number, minimum: 0 }
 *     responses:
 *       200:
 *         description: Resource budget updated
 *       400:
 *         description: 176-hour cap exceeded
 *       404:
 *         description: Resource budget record not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 *       422:
 *         description: Validation error
 */
router.put(
  '/:id',
  authorize('servicepo.manage_future_budget'),
  validate(updateResourceBudgetSchema),
  resourceBudgetController.update
);

/**
 * @swagger
 * /resource-budgets/{id}:
 *   delete:
 *     summary: Deactivate a resource budget record (soft delete)
 *     tags: [ResourceBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Deactivated
 *       404:
 *         description: Resource budget record not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 */
router.delete(
  '/:id',
  authorize('servicepo.manage_future_budget'),
  resourceBudgetController.deactivate
);

module.exports = router;
