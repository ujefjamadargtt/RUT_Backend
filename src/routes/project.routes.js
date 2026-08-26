'use strict';

/**
 * @swagger
 * tags:
 *   name: Projects
 *   description: Project Master — every Service PO must belong to a Project
 */

const express = require('express');
const router = express.Router();

const projectController = require('../controllers/projectController');
const authenticate = require('../middlewares/auth');
const { importLimiter } = require('../middlewares/rateLimiters');
const { validate } = require('../middlewares/validateRequest');
const {
  createProjectSchema,
  updateProjectSchema,
  listProjectsQuerySchema,
} = require('../validations/projectValidation');
const { handleProjectUpload } = require('../middlewares/upload');

// ─── Import projects from Excel/CSV (before /:id to avoid route shadowing) ────
/**
 * @swagger
 * /projects/import:
 *   post:
 *     summary: Import projects from an Excel or CSV file
 *     tags: [Projects]
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
 *                 description: .xlsx or .csv file. Required columns - "Project Name" and either "Client Code" or "Client Name". Optional columns - "Project Code", "Description", "Status".
 *               company_id:
 *                 type: integer
 *                 description: Optional. Only used for a company-less actor (Admin/Entity Admin) to import the whole file into one of their own Business Units. A BU-scoped actor (BU Admin and below) always has every row created under their own Business Unit regardless of this field.
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
 *                   description: Total non-empty rows in file
 *                 imported:
 *                   type: integer
 *                   description: Successfully inserted rows
 *                 skipped:
 *                   type: integer
 *                   description: Duplicate rows skipped
 *                 error_rows:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       row_number: { type: integer }
 *                       row_data:   { type: object }
 *                       errors:     { type: array, items: { type: string } }
 *                       skipped:    { type: boolean }
 *       400:
 *         description: No file uploaded
 *       422:
 *         description: File parse or header error
 */
router.post(
  '/import',
  authenticate,
  importLimiter,
  handleProjectUpload,
  projectController.importProjects
);

// ─── Active projects dropdown (must come before /:id to avoid route shadowing) ──
/**
 * @swagger
 * /projects/active/list:
 *   get:
 *     summary: Get all active projects (dropdown list)
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active projects returned successfully
 */
router.get(
  '/active/list',
  authenticate,
  projectController.getActiveProjects
);

// ─── List all projects ────────────────────────────────────────────────────────
/**
 * @swagger
 * /projects:
 *   get:
 *     summary: List projects with pagination, search and filters
 *     tags: [Projects]
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
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: client_id
 *         schema: { type: integer }
 *         description: Filter to Projects belonging to this Client — used by the Service PO create flow's Project dropdown
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by project_name or project_code
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, enum: [project_name, project_code, created_at], default: project_name }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC], default: ASC }
 *     responses:
 *       200:
 *         description: Paginated list of projects
 */
router.get(
  '/',
  authenticate,
  validate(listProjectsQuerySchema, 'query'),
  projectController.getAllProjects
);

// ─── Get single project ───────────────────────────────────────────────────────
/**
 * @swagger
 * /projects/{id}:
 *   get:
 *     summary: Get a single project by ID
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Project record
 *       404:
 *         description: Project not found
 */
router.get(
  '/:id',
  authenticate,
  projectController.getProjectById
);

// ─── Create project ───────────────────────────────────────────────────────────
/**
 * @swagger
 * /projects:
 *   post:
 *     summary: Create a new project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_name]
 *             properties:
 *               project_name: { type: string }
 *               project_description: { type: string }
 *               status: { type: string, enum: [active, inactive] }
 *     responses:
 *       201:
 *         description: Project created
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  validate(createProjectSchema),
  projectController.createProject
);

// ─── Update project ───────────────────────────────────────────────────────────
/**
 * @swagger
 * /projects/{id}:
 *   put:
 *     summary: Update an existing project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Project updated
 *       404:
 *         description: Project not found
 */
router.put(
  '/:id',
  authenticate,
  validate(updateProjectSchema),
  projectController.updateProject
);

// ─── Soft-delete project ──────────────────────────────────────────────────────
/**
 * @swagger
 * /projects/{id}:
 *   delete:
 *     summary: Delete a project (soft delete)
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Project deleted
 *       409:
 *         description: Project has Service POs still linked to it
 */
router.delete(
  '/:id',
  authenticate,
  projectController.deleteProject
);

module.exports = router;
