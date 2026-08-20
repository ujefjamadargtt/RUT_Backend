'use strict';

/**
 * @swagger
 * tags:
 *   name: CostBudgets
 *   description: Month-wise Invoice Amount master, strictly Service PO-wise
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const costBudgetController = require('../controllers/costBudgetController');
const {
  createCostBudgetSchema,
  updateCostBudgetSchema,
  listCostBudgetQuerySchema,
} = require('../validations/costBudgetValidation');

// ─── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

/**
 * @swagger
 * /cost-budgets/service-po/{servicePoId}:
 *   get:
 *     summary: All monthly cost budget records for one Service PO
 *     tags: [CostBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Cost budget records for the Service PO
 *       404:
 *         description: Service PO not found
 */
router.get('/service-po/:servicePoId', costBudgetController.listByServicePO);

/**
 * @swagger
 * /cost-budgets:
 *   get:
 *     summary: List cost budget records, optionally filtered by Service PO and/or month
 *     tags: [CostBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: service_po_id
 *         required: false
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: false
 *         schema: { type: string, example: "2026-08" }
 *     responses:
 *       200:
 *         description: Matching cost budget records
 *       422:
 *         description: Validation error
 */
router.get('/', validate(listCostBudgetQuerySchema, 'query'), costBudgetController.list);

/**
 * @swagger
 * /cost-budgets:
 *   post:
 *     summary: Create a Service PO's monthly cost budget entry
 *     description: >
 *       Rejects with 400 if a record already exists for this Service PO +
 *       month. Requires the servicepo.manage_future_budget capability.
 *     tags: [CostBudgets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_id, month, invoice_amount]
 *             properties:
 *               service_po_id: { type: integer }
 *               month: { type: string, example: "2026-08" }
 *               invoice_amount: { type: number, minimum: 0 }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Cost budget created
 *       400:
 *         description: Duplicate Service PO + month
 *       404:
 *         description: Service PO not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authorize('servicepo.manage_future_budget'),
  validate(createCostBudgetSchema),
  costBudgetController.create
);

/**
 * @swagger
 * /cost-budgets/{id}:
 *   put:
 *     summary: Update a cost budget record's invoice amount/description
 *     description: >
 *       Service PO and month are immutable via update. Requires the
 *       servicepo.manage_future_budget capability.
 *     tags: [CostBudgets]
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
 *             required: [invoice_amount]
 *             properties:
 *               invoice_amount: { type: number, minimum: 0 }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Cost budget updated
 *       404:
 *         description: Cost budget record not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 *       422:
 *         description: Validation error
 */
router.put(
  '/:id',
  authorize('servicepo.manage_future_budget'),
  validate(updateCostBudgetSchema),
  costBudgetController.update
);

/**
 * @swagger
 * /cost-budgets/{id}:
 *   delete:
 *     summary: Deactivate a cost budget record (soft delete)
 *     tags: [CostBudgets]
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
 *         description: Cost budget record not found
 *       403:
 *         description: Forbidden — requires servicepo.manage_future_budget
 */
router.delete(
  '/:id',
  authorize('servicepo.manage_future_budget'),
  costBudgetController.deactivate
);

module.exports = router;
