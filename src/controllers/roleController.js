'use strict';

const roleService = require('../services/roleService');
const {
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
} = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');

/**
 * Role Controller
 * Thin layer: parse request -> call service -> send response.
 */

/**
 * GET /api/v1/roles
 */
const getAll = async (req, res, next) => {
  try {
    const roles = await roleService.getAll(req.query);
    return sendSuccess(res, roles, 'Roles fetched successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/roles/:id
 */
const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid role ID.', 400);
    }
    const role = await roleService.getById(id);
    return sendSuccess(res, role, 'Role fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role');
    }
    next(err);
  }
};

/**
 * POST /api/v1/roles
 */
const create = async (req, res, next) => {
  try {
    const role = await roleService.create(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, role, 'Role created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    next(err);
  }
};

/**
 * PUT /api/v1/roles/:id
 */
const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid role ID.', 400);
    }
    const role = await roleService.update(id, req.body, req.userId, getIpAddress(req));
    return sendSuccess(res, role, 'Role updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role');
    }
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    next(err);
  }
};

/**
 * DELETE /api/v1/roles/:id
 * Hard delete: removes the role's role_form_mapping rows and the role row
 * itself in one transaction. Blocked (409) if the role is assigned to any
 * user.
 */
const deleteRole = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid role ID.', 400);
    }
    await roleService.delete(id, req.userId, getIpAddress(req));
    return sendSuccess(res, null, 'Role deleted successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role');
    }
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteRole,
};
