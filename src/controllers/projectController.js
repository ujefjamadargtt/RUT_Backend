'use strict';

const projectService = require('../services/projectService');
const {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendPaginated,
  sendNotFound,
  sendError,
} = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Project Controller
 * Thin layer: parse request, delegate to service, format response.
 * Mirrors clientController.js's shape.
 */

/**
 * GET /api/v1/projects
 */
const getAllProjects = async (req, res) => {
  try {
    const { data, meta } = await projectService.getAll(req.query, req.companyId);
    return sendPaginated(res, data, meta, 'Projects fetched successfully.');
  } catch (error) {
    logger.error('getAllProjects error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/projects/:id
 */
const getProjectById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid project ID.', 400);
    }

    const project = await projectService.getById(id, req.companyId);
    return sendSuccess(res, project, 'Project fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Project');
    }
    logger.error('getProjectById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/projects
 */
const createProject = async (req, res) => {
  try {
    const project = await projectService.create(req.body, req.userId, req);
    return sendCreated(res, project, 'Project created successfully.');
  } catch (error) {
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('createProject error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * PUT /api/v1/projects/:id
 */
const updateProject = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid project ID.', 400);
    }

    const project = await projectService.update(id, req.body, req.userId, req);
    return sendSuccess(res, project, 'Project updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      // update() can 404 on the Project itself, or on the Client when
      // client_id is being changed — surface the service's precise message
      // rather than always assuming it's the Project.
      return sendError(res, error.message, 404);
    }
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('updateProject error', { error: error.message, id: req.params.id, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * DELETE /api/v1/projects/:id
 */
const deleteProject = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid project ID.', 400);
    }

    await projectService.deleteProject(id, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Project');
    }
    if (error.statusCode === 409 || error.statusCode === 400) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('deleteProject error', { error: error.message, id: req.params.id, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/projects/active/list
 */
const getActiveProjects = async (req, res) => {
  try {
    const projects = await projectService.getActiveProjects(req.companyId);
    return sendSuccess(res, projects, 'Active projects fetched successfully.');
  } catch (error) {
    logger.error('getActiveProjects error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getAllProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  getActiveProjects,
};
