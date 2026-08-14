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
 *       Role-scoped from the authenticated JWT identity, never a request
 *       parameter: Manager sees only Service POs granted to them; every
 *       other role (e.g. BU Admin, Service PO Admin) sees every active
 *       Service PO in their own company/BU. Always further scoped to the
 *       caller's own company — never another company's Service POs.
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

// ─── Service PO dropdown — no budget data ──────────────────────────────────────
/**
 * @swagger
 * /service-po-monthly-budgets/service-pos:
 *   get:
 *     summary: Service PO dropdown — active Service POs the caller may select
 *     description: >
 *       Returns only Service PO identity/client info, no budget data — feeds
 *       the "select a Service PO" dropdown before the caller picks a
 *       month/year and fills in a budget. Role-scoped from the authenticated
 *       JWT identity, never a request parameter: Manager sees only Service
 *       POs granted to them; every other role (e.g. BU Admin, Service PO
 *       Admin) sees every active Service PO in their own company/BU. Always
 *       further scoped to the caller's own company — never another
 *       company's Service POs.
 *     tags: [ServicePOMonthlyBudgets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Service PO list (service_po_id, service_po_code, service_po_name, is_billable, status, client)
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/service-pos',
  servicePOMonthlyBudgetController.listServicePOs
);

// ─── Get one record for a Service PO + month/year, or list by month/year ──────
/**
 * @swagger
 * /service-po-monthly-budgets:
 *   get:
 *     summary: Get monthly budget record(s) for a year, optionally narrowed to one month and/or one Service PO
 *     description: >
 *       year is always required. service_po_id and month are each
 *       independently optional, EXCEPT month becomes required the moment
 *       service_po_id is given (a single-record fetch needs both, since the
 *       table's uniqueness is service_po_id + month + year).
 *         - ?year=2026 -> every record in 2026 the caller's role can see
 *         - ?month=8&year=2026 -> every record in August 2026 the caller's role can see
 *         - ?service_po_id=101&month=8&year=2026 -> the single record for that PO
 *       Without service_po_id, response is an object with month, year, and
 *       a records array (month is null when not filtered; each record still
 *       carries its own month for grouping). With service_po_id, response
 *       is that single record.
 *       service_po_id (when given) is validated against the authenticated
 *       caller's role scope from the JWT (never trusted as-is): a Manager
 *       passing a service_po_id outside their own mapped scope gets 404,
 *       identical to a genuinely missing or another company's PO — this
 *       never reveals whether the PO exists outside their scope. Other
 *       roles (e.g. BU Admin, Service PO Admin) are unrestricted beyond
 *       their own company/BU. When service_po_id is omitted, the list is
 *       narrowed the same way (Manager: only their mapped POs' records).
 *     tags: [ServicePOMonthlyBudgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: service_po_id
 *         required: false
 *         schema: { type: integer }
 *         description: Optional — when given, month becomes required and the response is that single record
 *       - in: query
 *         name: month
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Optional — omit to list every month in the year. Required when service_po_id is given.
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: >
 *           Monthly budget record (service_po_id given) or an object with
 *           month, year, and a records array (service_po_id omitted).
 *       404:
 *         description: Service PO or monthly budget record not found (also returned when the PO exists but is outside the caller's role scope) — only when service_po_id is given
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
