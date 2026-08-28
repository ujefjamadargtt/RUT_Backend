'use strict';

const adminService = require('../services/adminService');
const { sendCreated, sendSuccess, sendPaginated, sendNotFound, sendError } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Admin Controller — Platform-level only, gated by requirePlatformAdmin.
 */

const create = async (req, res, next) => {
  try {
    const result = await adminService.createAdmin(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, result, 'Admin created successfully.');
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
    const { data, meta } = await adminService.getAll(req.query, req.userId);
    return sendPaginated(res, data, meta, 'Admins fetched successfully.');
  } catch (err) {
    logger.error('admin getAll error', { error: err.message, userId: req.userId });
    next(err);
  }
};

const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Admin ID.', 400);
    }
    const user = await adminService.getById(id, req.userId);
    return sendSuccess(res, user, 'Admin fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Admin');
    }
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Admin ID.', 400);
    }
    const user = await adminService.update(id, req.body, req.userId, req);
    return sendSuccess(res, user, 'Admin updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Admin');
    }
    next(err);
  }
};

module.exports = {
  create,
  getAll,
  getById,
  update,
};
