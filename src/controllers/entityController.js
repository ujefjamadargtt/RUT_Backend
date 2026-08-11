'use strict';

const entityService = require('../services/entityService');
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
 * Entity Controller
 * Entity Master is reachable by both Admin and Entity Admin (see
 * requireEntityAdminOrAdmin.js), all actions scoped to req.entityIds — an
 * Entity Admin's own assigned Entities, or an Admin's owned Entities. An
 * Entity Admin creating a new Entity always has it self-assigned (see
 * entityService.create's isEntityAdmin param) regardless of what the
 * request body contains.
 */

const getAllEntities = async (req, res) => {
  try {
    const { data, meta } = await entityService.getAll(req.query, req.entityIds);
    return sendPaginated(res, data, meta, 'Entities fetched successfully.');
  } catch (error) {
    logger.error('getAllEntities error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getEntityById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid entity ID.', 400);
    }

    const entity = await entityService.getById(id, req.entityIds);
    return sendSuccess(res, entity, 'Entity fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Entity');
    }
    logger.error('getEntityById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const createEntity = async (req, res) => {
  try {
    const isEntityAdmin = !!(req.userRoleName && req.userRoleName.toLowerCase() === 'entity admin');
    const entity = await entityService.create(req.body, req.userId, req, isEntityAdmin);
    return sendCreated(res, entity, 'Entity created successfully.');
  } catch (error) {
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    if (error.statusCode === 403 || error.statusCode === 404) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('createEntity error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const updateEntity = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid entity ID.', 400);
    }

    const entity = await entityService.update(id, req.body, req.userId, req, req.entityIds);
    return sendSuccess(res, entity, 'Entity updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Entity');
    }
    if (error.statusCode === 409 || error.statusCode === 403) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('updateEntity error', { error: error.message, id: req.params.id, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const deleteEntity = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid entity ID.', 400);
    }

    await entityService.deleteEntity(id, req.userId, req, req.entityIds);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Entity');
    }
    if (error.statusCode === 409 || error.statusCode === 400) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('deleteEntity error', { error: error.message, id: req.params.id, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getAllEntities,
  getEntityById,
  createEntity,
  updateEntity,
  deleteEntity,
};
