'use strict';

const subProjectService = require('../services/subProjectService');
const { validate } = require('../middlewares/validateRequest');
const {
  createSubProjectSchema,
  updateSubProjectSchema,
  listSubProjectsQuerySchema,
} = require('../validations/subProjectValidation');
const {
  sendSuccess,
  sendCreated,
  sendPaginated,
  sendNotFound,
  sendError,
} = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Sub-Project Controller
 * Thin HTTP layer — delegates all logic to subProjectService.
 */

// ─── GET /sub-projects ────────────────────────────────────────────────────────
/**
 * @swagger
 * /sub-projects:
 *   get:
 *     summary: List sub-projects (paginated)
 *     tags: [SubProjects]
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
 *         schema: { type: string, enum: [active, inactive, completed, on-hold, all] }
 *       - in: query
 *         name: service_po_id
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, enum: [sub_project_name, sub_project_code, start_date, end_date, created_at] }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC] }
 *     responses:
 *       200:
 *         description: Paginated list of sub-projects
 */
const getAll = [
  validate(listSubProjectsQuerySchema, 'query'),
  async (req, res) => {
    try {
      const { data, meta } = await subProjectService.getAll(req.query, req.companyId);
      return sendPaginated(res, data, meta, 'Sub-projects fetched successfully.');
    } catch (error) {
      logger.error('SubProjectController.getAll error', { error: error.message });
      return sendError(res, error.message, error.statusCode || 500);
    }
  },
];

// ─── GET /sub-projects/:id ────────────────────────────────────────────────────
/**
 * @swagger
 * /sub-projects/{id}:
 *   get:
 *     summary: Get a sub-project by ID
 *     tags: [SubProjects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Sub-project record
 *       404:
 *         description: Not found
 */
const getById = async (req, res) => {
  try {
    const subProject = await subProjectService.getById(req.params.id, req.companyId);
    return sendSuccess(res, subProject, 'Sub-project fetched successfully.');
  } catch (error) {
    logger.error('SubProjectController.getById error', { id: req.params.id, error: error.message });
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Sub-project');
    }
    return sendError(res, error.message, error.statusCode || 500);
  }
};

// ─── GET /sub-projects/by-po/:poId ────────────────────────────────────────────
/**
 * @swagger
 * /sub-projects/by-po/{poId}:
 *   get:
 *     summary: Get all sub-projects for a Service PO
 *     tags: [SubProjects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: poId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Sub-projects list
 *       404:
 *         description: Service PO not found
 */
const getByPO = async (req, res) => {
  try {
    const subProjects = await subProjectService.getByPO(req.params.poId, req.companyId);
    return sendSuccess(res, subProjects, 'Sub-projects for PO fetched successfully.');
  } catch (error) {
    logger.error('SubProjectController.getByPO error', { poId: req.params.poId, error: error.message });
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    return sendError(res, error.message, error.statusCode || 500);
  }
};

// ─── POST /sub-projects ───────────────────────────────────────────────────────
/**
 * @swagger
 * /sub-projects:
 *   post:
 *     summary: Create a new sub-project
 *     tags: [SubProjects]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_id, sub_project_name, start_date, end_date]
 *             properties:
 *               service_po_id:
 *                 type: integer
 *               sub_project_name:
 *                 type: string
 *               description:
 *                 type: string
 *               start_date:
 *                 type: string
 *                 format: date
 *               end_date:
 *                 type: string
 *                 format: date
 *               status:
 *                 type: string
 *                 enum: [active, inactive, completed, on-hold]
 *     description: sub_project_code is generated by the server
 *     responses:
 *       201:
 *         description: Sub-project created
 *       400:
 *         description: Validation error or inactive PO
 *       404:
 *         description: Service PO not found
 */
const create = [
  validate(createSubProjectSchema),
  async (req, res) => {
    try {
      const subProject = await subProjectService.create(
        req.body,
        req.userId,
        getIpAddress(req),
        req.companyId
      );
      return sendCreated(res, subProject, 'Sub-project created successfully.');
    } catch (error) {
      logger.error('SubProjectController.create error', { error: error.message, body: req.body });
      return sendError(res, error.message, error.statusCode || 500);
    }
  },
];

// ─── PUT /sub-projects/:id ────────────────────────────────────────────────────
/**
 * @swagger
 * /sub-projects/{id}:
 *   put:
 *     summary: Update a sub-project
 *     tags: [SubProjects]
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
 *     responses:
 *       200:
 *         description: Sub-project updated
 *       404:
 *         description: Not found
 */
const update = [
  validate(updateSubProjectSchema),
  async (req, res) => {
    try {
      const subProject = await subProjectService.update(
        req.params.id,
        req.body,
        req.userId,
        getIpAddress(req),
        req.companyId
      );
      return sendSuccess(res, subProject, 'Sub-project updated successfully.');
    } catch (error) {
      logger.error('SubProjectController.update error', { id: req.params.id, error: error.message });
      if (error.statusCode === 404) {
        return sendNotFound(res, 'Sub-project');
      }
      return sendError(res, error.message, error.statusCode || 500);
    }
  },
];

// ─── DELETE /sub-projects/:id ─────────────────────────────────────────────────
/**
 * @swagger
 * /sub-projects/{id}:
 *   delete:
 *     summary: Soft-delete a sub-project
 *     tags: [SubProjects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Sub-project deleted
 *       404:
 *         description: Not found
 *       409:
 *         description: Conflict — timesheets exist
 */
const deleteSubProject = async (req, res) => {
  try {
    await subProjectService.delete(
      req.params.id,
      req.userId,
      getIpAddress(req),
      req.companyId
    );
    return sendSuccess(res, null, 'Sub-project deleted successfully.');
  } catch (error) {
    logger.error('SubProjectController.delete error', { id: req.params.id, error: error.message });
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Sub-project');
    }
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getAll,
  getById,
  getByPO,
  create,
  update,
  delete: deleteSubProject,
};
