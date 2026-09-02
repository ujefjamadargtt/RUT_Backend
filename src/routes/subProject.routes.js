'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
// GET-only: lets a BU-scoped caller mapped to more than one Business Unit
// omit X-Company-Id, aggregating across every BU they're mapped to,
// instead of resolveCompany.js's 400 — see resolveReportCompanyScope.js.
// Write routes below keep the full `authenticate` (single req.companyId)
// chain unchanged — a create/update/delete always needs exactly one target BU.
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
const authenticateReadMultiBU = [authenticate.authenticateIdentity, resolveReportCompanyScope];
const subProjectController = require('../controllers/subProjectController');

/**
 * Role constants for readability.
 * Allowed mutators: Finance, Management, Project Manager
 */
const MUTATORS = ['Finance', 'Management', 'Project Manager'];

/**
 * @swagger
 * tags:
 *   name: SubProjects
 *   description: Sub-project management under Service POs
 */

// ─── Read routes — any authenticated role ─────────────────────────────────────

/**
 * GET /api/v1/sub-projects
 * List sub-projects with pagination, filtering, and sorting.
 */
router.get('/', authenticateReadMultiBU, ...subProjectController.getAll);

/**
 * GET /api/v1/sub-projects/by-po/:poId
 * Get all sub-projects belonging to a specific Service PO.
 * Placed BEFORE /:id so Express doesn't swallow "by-po" as an id.
 */
router.get('/by-po/:poId', authenticateReadMultiBU, subProjectController.getByPO);

/**
 * GET /api/v1/sub-projects/:id
 * Get a single sub-project by primary key.
 */
router.get('/:id', authenticateReadMultiBU, subProjectController.getById);

// ─── Write routes — Finance, Management, Project Manager only ─────────────────

/**
 * POST /api/v1/sub-projects
 * Create a new sub-project under an active Service PO.
 */
router.post(
  '/',
  authenticate,
  ...subProjectController.create
);

/**
 * PUT /api/v1/sub-projects/:id
 * Update an existing sub-project.
 */
router.put(
  '/:id',
  authenticate,
  ...subProjectController.update
);

/**
 * DELETE /api/v1/sub-projects/:id
 * Soft-delete a sub-project (sets status = inactive).
 * Blocked if any timesheets reference this record.
 */
router.delete(
  '/:id',
  authenticate,
  subProjectController.delete
);

module.exports = router;
