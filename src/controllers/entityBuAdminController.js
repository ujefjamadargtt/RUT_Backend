'use strict';

const entityBuAdminService = require('../services/entityBuAdminService');
const { sendSuccess, sendPaginated, sendNotFound, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Entity BU Admin Controller — "BU Admin Master" screen. Every action is
 * scoped to req.entityIds (see requireEntityAdmin.js).
 */

const getAll = async (req, res) => {
  try {
    const { data, meta } = await entityBuAdminService.getAll(req.entityIds, req.query);
    return sendPaginated(res, data, meta, 'BU Admins fetched successfully.');
  } catch (error) {
    logger.error('entityBuAdmin getAll error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Admin ID.', 400);
    }
    const user = await entityBuAdminService.getById(id, req.entityIds);
    return sendSuccess(res, user, 'BU Admin fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'BU Admin');
    }
    logger.error('entityBuAdmin getById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const update = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Admin ID.', 400);
    }
    const user = await entityBuAdminService.update(id, req.body, req.entityIds, req.userId, req);
    return sendSuccess(res, user, 'BU Admin updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'BU Admin');
    }
    logger.error('entityBuAdmin update error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const setStatus = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Admin ID.', 400);
    }
    const user = await entityBuAdminService.setStatus(id, req.body.status, req.entityIds, req.userId, req);
    return sendSuccess(res, user, `BU Admin ${req.body.status === 'active' ? 'activated' : 'deactivated'} successfully.`);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'BU Admin');
    }
    logger.error('entityBuAdmin setStatus error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getAll,
  getById,
  update,
  setStatus,
};
