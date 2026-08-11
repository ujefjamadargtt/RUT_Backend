'use strict';

const entityAdminService = require('../services/entityAdminService');
const { sendSuccess, sendCreated, sendPaginated, sendNotFound, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const { getIpAddress } = require('../middlewares/auditLog');

/**
 * Entity Admin Controller — Admin's "Manage Entity Admins" module.
 * `create` is gated by requirePlatformAdmin (Platform Admin's only
 * user-creation action); the rest are gated by authorize('admin.*') —
 * Admin's own view/manage capabilities.
 */

const create = async (req, res, next) => {
  try {
    const result = await entityAdminService.createEntityAdmin(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, result, 'Entity Admin created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    if (err.statusCode === 500) {
      return sendError(res, err.message, 500);
    }
    next(err);
  }
};

const getAll = async (req, res, next) => {
  try {
    const { data, meta } = await entityAdminService.getAll(req.query, req.userId);
    return sendPaginated(res, data, meta, 'Entity Admins fetched successfully.');
  } catch (err) {
    logger.error('entityAdmin getAll error', { error: err.message, userId: req.userId });
    next(err);
  }
};

const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Entity Admin ID.', 400);
    }
    const user = await entityAdminService.getById(id, req.userId);
    return sendSuccess(res, user, 'Entity Admin fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Entity Admin');
    }
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Entity Admin ID.', 400);
    }
    const user = await entityAdminService.update(id, req.body, req.userId, req);
    return sendSuccess(res, user, 'Entity Admin updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Entity Admin');
    }
    next(err);
  }
};

const setStatus = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Entity Admin ID.', 400);
    }
    const user = await entityAdminService.setStatus(id, req.body.status, req.userId, req);
    return sendSuccess(res, user, `Entity Admin ${req.body.status === 'active' ? 'activated' : 'deactivated'} successfully.`);
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Entity Admin');
    }
    next(err);
  }
};

module.exports = {
  create,
  getAll,
  getById,
  update,
  setStatus,
};
