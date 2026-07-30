'use strict';

const userService = require('../services/userService');
const {
  sendSuccess,
  sendCreated,
  sendPaginated,
  sendError,
  sendNotFound,
} = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');

/**
 * User Controller
 * Thin layer: parse request -> call service -> send response.
 */

/**
 * GET /api/v1/users
 */
const getAll = async (req, res, next) => {
  try {
    const { data, meta } = await userService.getAll(req.query, req.companyId);
    return sendPaginated(res, data, meta, 'Users fetched successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/users/:id
 */
const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid user ID.', 400);
    }
    const user = await userService.getById(id, req.companyId);
    return sendSuccess(res, user, 'User fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User');
    }
    next(err);
  }
};

/**
 * POST /api/v1/users
 */
const create = async (req, res, next) => {
  try {
    const user = await userService.create(req.body, req.userId, getIpAddress(req), req.companyId);
    return sendCreated(res, user, 'User created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    if (err.statusCode === 404) {
      return sendError(res, err.message, 404);
    }
    next(err);
  }
};

/**
 * PUT /api/v1/users/:id
 */
const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid user ID.', 400);
    }
    const user = await userService.update(id, req.body, req.userId, getIpAddress(req), req.companyId);
    return sendSuccess(res, user, 'User updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User');
    }
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    next(err);
  }
};

/**
 * DELETE /api/v1/users/:id
 */
const deleteUser = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid user ID.', 400);
    }
    const user = await userService.delete(id, req.userId, getIpAddress(req), req.companyId);
    return sendSuccess(res, user, 'User deactivated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User');
    }
    if (err.statusCode === 403) {
      return sendError(res, err.message, 403);
    }
    next(err);
  }
};

/**
 * PUT /api/v1/users/:id/change-password
 * Authenticated user changes their own password.
 */
const changePassword = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid user ID.', 400);
    }

    // A user can only change their own password unless they are HR/Management
    const isSelf = req.userId === id;
    const userRoles = Array.isArray(req.userRoles) ? req.userRoles : req.userRole ? [req.userRole] : [];
    const isAdmin = ['HR', 'Management'].some((role) =>
      userRoles.includes(role)
    );

    if (!isSelf && !isAdmin) {
      return sendError(res, 'You are not authorised to change this user\'s password.', 403);
    }

    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
      return sendError(res, 'Both old_password and new_password are required.', 400);
    }

    await userService.changePassword(id, old_password, new_password, getIpAddress(req), req.companyId);
    return sendSuccess(res, null, 'Password changed successfully.');
  } catch (err) {
    if (err.statusCode === 401) {
      return sendError(res, err.message, 401);
    }
    if (err.statusCode === 400) {
      return sendError(res, err.message, 400);
    }
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User');
    }
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteUser,
  changePassword,
};
