'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
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

// ─── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

// ─── Read routes — any authenticated role ─────────────────────────────────────

/**
 * GET /api/v1/sub-projects
 * List sub-projects with pagination, filtering, and sorting.
 */
router.get('/', ...subProjectController.getAll);

/**
 * GET /api/v1/sub-projects/by-po/:poId
 * Get all sub-projects belonging to a specific Service PO.
 * Placed BEFORE /:id so Express doesn't swallow "by-po" as an id.
 */
router.get('/by-po/:poId', subProjectController.getByPO);

/**
 * GET /api/v1/sub-projects/:id
 * Get a single sub-project by primary key.
 */
router.get('/:id', subProjectController.getById);

// ─── Write routes — Finance, Management, Project Manager only ─────────────────

/**
 * POST /api/v1/sub-projects
 * Create a new sub-project under an active Service PO.
 */
router.post(
  '/',
  ...subProjectController.create
);

/**
 * PUT /api/v1/sub-projects/:id
 * Update an existing sub-project.
 */
router.put(
  '/:id',
  ...subProjectController.update
);

/**
 * DELETE /api/v1/sub-projects/:id
 * Soft-delete a sub-project (sets status = inactive).
 * Blocked if any timesheets reference this record.
 */
router.delete(
  '/:id',
  subProjectController.delete
);

module.exports = router;
