'use strict';

/**
 * @swagger
 * tags:
 *   name: ServicePOMonthlyBudgets
 *   description: Month-wise Invoice Amount / Billed Amount master for Service POs
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const servicePOMonthlyBudgetController = require('../controllers/servicePOMonthlyBudgetController');
const {
  getServicePOMonthlyBudgetQuerySchema,
  upsertServicePOMonthlyBudgetSchema,
} = require('../validations/servicePOMonthlyBudgetValidation');

// ─── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

// ─── Current month (Service PO Manager screen) — before / to keep it explicit ─
/**
 * @swagger
 * /service-po-monthly-budgets/current:
 *   get:
 *     summary: Current-month Service PO budget data + deadline status
 *     description: >
 *       Determines the current month/year from the server date and returns
 *       the fill-in deadline (configurable, defaults to the 10th of the
 *       month), days remaining, whether it has passed, and every active
 *       Service PO's existing Invoice/Billed amount entry for that month
 *       (defaulted to 0/null when nothing has been filled in yet).
 *     tags: [ServicePOMonthlyBudgets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current month data
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/current',
  servicePOMonthlyBudgetController.getCurrentMonth
);

// ─── Get one record for a Service PO + month/year ─────────────────────────────
/**
 * @swagger
 * /service-po-monthly-budgets:
 *   get:
 *     summary: Get the monthly budget record for one Service PO + month/year
 *     tags: [ServicePOMonthlyBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: service_po_id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Monthly budget record
 *       404:
 *         description: Service PO or monthly budget record not found
 *       422:
 *         description: Validation error
 */
router.get(
  '/',
  validate(getServicePOMonthlyBudgetQuerySchema, 'query'),
  servicePOMonthlyBudgetController.getOne
);

// ─── Create / update (upsert) — Service PO Manager only ───────────────────────
/**
 * @swagger
 * /service-po-monthly-budgets:
 *   post:
 *     summary: Create or update (upsert) a Service PO's monthly budget entry
 *     description: >
 *       Upserts on the (service_po_id, month, year) unique constraint — a
 *       second call for the same Service PO + month/year updates the
 *       existing row instead of creating a duplicate. Requires the
 *       servicepo.manage_future_budget capability. Editing after the
 *       deadline is allowed; the response still reports deadline status.
 *     tags: [ServicePOMonthlyBudgets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_id, month, year, invoice_amount, billed_amount]
 *             properties:
 *               service_po_id: { type: integer }
 *               month: { type: integer, minimum: 1, maximum: 12 }
 *               year: { type: integer }
 *               invoice_amount: { type: number, minimum: 0 }
 *               invoice_description: { type: string }
 *               billed_amount: { type: number, minimum: 0 }
 *               billed_remark: { type: string }
 *     responses:
 *       200:
 *         description: Monthly budget record saved (created or updated)
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
  validate(upsertServicePOMonthlyBudgetSchema),
  servicePOMonthlyBudgetController.upsert
);

module.exports = router;
