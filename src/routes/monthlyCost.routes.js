'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const monthlyCostController = require('../controllers/monthlyCostController');
const { handleMonthlyCostUpload } = require('../middlewares/upload');
const { bulkIdsSchema, deleteBySheetSchema, idParamSchema } = require('../validations/monthlyCostValidation');
const { importLimiter } = require('../middlewares/rateLimiters');

/**
 * Role constants.
 * All write operations (create, update, delete, calculate) are restricted to
 * Finance and Management roles.
 */
const FINANCE_MANAGEMENT = ['Finance', 'Management'];

/**
 * @swagger
 * tags:
 *   name: MonthlyCosts
 *   description: Employee monthly cost management and bulk calculation
 */

// ─── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

// ─── Bulk calculate (Finance, Management) — placed BEFORE /:id ─────────────────────
/**
 * POST /api/v1/monthly-costs/calculate
 * Recalculate total_cost for all employees in a month.
 * Must come before /:id route to avoid "calculate" being parsed as an id.
 */
router.post(
  '/calculate',
  ...monthlyCostController.calculateForMonth
);

// ─── Excel Import (Finance, Management) — placed BEFORE /:id ───────────────────────────
/**
 * POST /api/v1/monthly-costs/import
 * Import bulk monthly cost records from an Excel (.xlsx) file.
 * Columns: Employee ID | Month Year | Salary Cost | Ops Cost | Total Cost | Billable Cost
 */
router.post(
  '/import',
  importLimiter,
  handleMonthlyCostUpload,
  monthlyCostController.importFromExcel
);

// ─── Read routes — any authenticated role ─────────────────────────────────────

/**
 * GET /api/v1/monthly-costs
 * Paginated list with optional filters: employee_id, month, year.
 */
router.get('/', ...monthlyCostController.getAll);

/**
 * GET /api/v1/monthly-costs/:id
 * Single monthly cost record by primary key.
 */
router.get('/:id', validate(idParamSchema, 'params'), monthlyCostController.getById);

// ─── Write routes — Finance, Management only ──────────────────────────────────

/**
 * POST /api/v1/monthly-costs
 * Create a new monthly cost entry with automatic cost formula calculation.
 */
router.post(
  '/',
  ...monthlyCostController.create
);

/**
 * PUT /api/v1/monthly-costs/:id
 * Update a monthly cost record; derived fields are recalculated automatically.
 */
router.put(
  '/:id',
  validate(idParamSchema, 'params'),
  ...monthlyCostController.update
);

/**
 * DELETE /api/v1/monthly-costs
 * Delete one or more monthly cost records in a single call.
 * Body: { ids: [1, 2, 3] } — pass a single-element array to delete just one row.
 * Placed BEFORE /:id so it isn't shadowed (different path pattern, but kept
 * alongside the other bulk routes for readability).
 */
router.delete(
  '/',
  validate(bulkIdsSchema, 'body'),
  monthlyCostController.bulkDelete
);

/**
 * DELETE /api/v1/monthly-costs/sheet
 * Delete an entire monthly cost "sheet" — every record for the given
 * month(s)/year(s) — in a single call.
 * Body: { months: [{ month: 6, year: 2026 }] }
 * Must come before /:id to avoid "sheet" being parsed as an id.
 */
router.delete(
  '/sheet',
  validate(deleteBySheetSchema, 'body'),
  monthlyCostController.deleteByMonth
);

/**
 * DELETE /api/v1/monthly-costs/:id
 * Hard-delete a monthly cost record.
 */
router.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  monthlyCostController.delete
);

module.exports = router;