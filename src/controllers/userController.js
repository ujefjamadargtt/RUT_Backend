'use strict';

const userService = require('../services/userService');
const roleHierarchyService = require('../services/roleHierarchyService');
const userAccessControlService = require('../services/userAccessControlService');
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

const USER_MANAGEMENT_DENIED_MESSAGE = 'You are not authorized to access user management.';

/**
 * GET /api/v1/users
 *
 * User Management is an administrative function (see
 * userAccessControlService.js) — a caller with no User Management
 * permission at all (Project Admin, Service PO Admin, Manager, Employee)
 * gets a flat 403 for the WHOLE endpoint, never a filtered/empty list:
 * this check runs, and denies, BEFORE any User row is loaded.
 */
const getAll = async (req, res, next) => {
  try {
    if (!userAccessControlService.hasUserManagementPermission(req)) {
      return sendError(res, USER_MANAGEMENT_DENIED_MESSAGE, 403);
    }

    const authContext = { userId: req.userId, companyId: req.companyId, hierarchyRank: req.hierarchyRank };
    const { data, meta } = await userService.getAll(req.query, authContext);
    return sendPaginated(res, data, meta, 'Users fetched successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/users/:id
 *
 * Same function-level gate as getAll() above — denied with the identical
 * generic 403 regardless of the requested ID, so an unauthorized caller
 * can never distinguish "you can't see users" from "this ID doesn't
 * exist." A caller WITH User Management permission but outside their
 * object-level scope (wrong Company/Entity) instead 404s, indistinguishable
 * from a genuinely nonexistent ID — see userAccessControlService.js and
 * userRepository.findById's doc comment.
 */
const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid user ID.', 400);
    }
    if (!userAccessControlService.hasUserManagementPermission(req)) {
      return sendError(res, USER_MANAGEMENT_DENIED_MESSAGE, 403);
    }

    const accessWhere = await userAccessControlService.resolveUserAccessWhere({
      userId: req.userId, companyId: req.companyId, hierarchyRank: req.hierarchyRank,
    });
    const user = await userService.getById(id, req.companyId, accessWhere);
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
    const user = await userService.create(req.body, req.userId, getIpAddress(req), req.companyId, req.userRoleName);
    return sendCreated(res, user, 'User created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    if (err.statusCode === 404) {
      return sendError(res, err.message, 404);
    }
    if (err.statusCode === 403) {
      return sendError(res, err.message, 403);
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
    const user = await userService.update(id, req.body, req.userId, getIpAddress(req), req.companyId, req.userRoleName);
    return sendSuccess(res, user, 'User updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User');
    }
    if (err.statusCode === 409 || err.statusCode === 403) {
      return sendError(res, err.message, err.statusCode);
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

    // A user can only change their own password unless they hold HR's
    // 'hr.manage_employee' capability (owns Employee lifecycle management —
    // checked via req.capabilities, not a primary-role string match, so an
    // Employee-primary user granted HR as an ADDITIONAL role correctly
    // qualifies too, see database/migrations/20260850_add_user_additional_roles.sql)
    // or a senior admin tier (Platform Admin/Admin/Entity Admin/BU Admin
    // manage everything within their own scope — see
    // roleHierarchyService.isSeniorTier, the generalized replacement for
    // the old hardcoded ['HR', 'Management'] check; 'Management' no longer
    // exists as a role — see database/migrations/20260838_remap_legacy_roles.sql).
    const isSelf = req.userId === id;
    const isAdmin = roleHierarchyService.hasCapability(req.capabilities, 'hr.manage_employee')
      || roleHierarchyService.isSeniorTier(req.user.role);

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

/**
 * PUT /api/v1/users/:id/reset-password
 *
 * Admin-side reset — sets a new password WITHOUT requiring the old one.
 * Restricted to HR or a senior admin tier (same rule as the "reset
 * someone else's password" branch of changePassword() above) — a plain
 * user may never reset their own or anyone else's password this way; use
 * PUT /:id/change-password (self-service, requires the old password)
 * instead.
 */
const resetPassword = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid user ID.', 400);
    }

    const isAdmin = roleHierarchyService.hasCapability(req.capabilities, 'hr.manage_employee')
      || roleHierarchyService.isSeniorTier(req.user.role);
    if (!isAdmin) {
      return sendError(res, 'You are not authorised to reset this user\'s password.', 403);
    }

    await userService.resetPassword(id, req.body.new_password, req.userId, getIpAddress(req), req.companyId);
    return sendSuccess(res, null, 'Password reset successfully.');
  } catch (err) {
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
  resetPassword,
};
