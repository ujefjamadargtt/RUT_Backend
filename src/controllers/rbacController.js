'use strict';

const rbacService = require('../services/rbacService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * RBAC Controller
 * User <-> Role mappings, Role <-> Form mappings (including the dedicated
 * soft map/unmap endpoint), and the admin Forms-for-Role(s) lookup used to
 * power the Role-Form mapping screen. A regular user's own accessible forms
 * come back from the login response instead (see authService.js).
 */

/**
 * Parse a route param into a positive integer, or null if invalid.
 * @param {string} value
 * @returns {number|null}
 */
function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// ── User <-> Role mappings ───────────────────────────────────────────────────

/**
 * GET /api/v1/roles/user-mappings/:userId
 * Management only. Lists every role currently mapped to one user.
 */
const userMappings = async (req, res, next) => {
  try {
    const userId = parsePositiveInt(req.params.userId);
    if (!userId) {
      return sendError(res, 'Invalid user ID.', 400);
    }

    const mappings = await rbacService.listUserMappings(userId);
    return sendSuccess(res, mappings, 'User role mappings fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.userMappings error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * POST /api/v1/roles/user-mappings
 * Management only. Maps one additional role onto one user.
 * Body: { user_id, role_id }
 */
const createUserMapping = async (req, res, next) => {
  try {
    const mapping = await rbacService.createUserMapping(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, mapping, 'User role mapping created successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.createUserMapping error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PUT /api/v1/roles/user-mappings/:userId
 * Management only. Replaces ALL of a user's role mappings with the given
 * set in one transaction.
 * Body: { role_ids: number[] }
 */
const replaceUserRoles = async (req, res, next) => {
  try {
    const userId = parsePositiveInt(req.params.userId);
    if (!userId) {
      return sendError(res, 'Invalid user ID.', 400);
    }

    const mappings = await rbacService.replaceUserRoles(userId, req.body.role_ids, req.userId, getIpAddress(req));
    return sendSuccess(res, mappings, 'User role mappings updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User or role');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.replaceUserRoles error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * DELETE /api/v1/roles/user-mappings/:userId/:roleId
 * Management only. Removes one role mapping from one user.
 */
const deleteUserMapping = async (req, res, next) => {
  try {
    const userId = parsePositiveInt(req.params.userId);
    const roleId = parsePositiveInt(req.params.roleId);
    if (!userId || !roleId) {
      return sendError(res, 'Invalid user ID or role ID.', 400);
    }

    await rbacService.deleteUserMapping({ user_id: userId, role_id: roleId }, req.userId, getIpAddress(req));
    return sendSuccess(res, null, 'User role mapping deleted successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'User role mapping');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.deleteUserMapping error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ── Role <-> Form mappings ───────────────────────────────────────────────────

/**
 * GET /api/v1/roles/form-mappings/:roleId
 * Management only. Lists every form currently mapped to one role.
 */
const roleFormMappings = async (req, res, next) => {
  try {
    const roleId = parsePositiveInt(req.params.roleId);
    if (!roleId) {
      return sendError(res, 'Invalid role ID.', 400);
    }

    const mappings = await rbacService.listRoleFormMappings(roleId);
    return sendSuccess(res, mappings, 'Role form mappings fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.roleFormMappings error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * GET /api/v1/roles/form-mappings?id=:id
 * Management only. Fetches a single role-form mapping row by its own
 * primary key (query param) — distinct from GET /form-mappings/:roleId,
 * which lists every mapping for one role (path param).
 */
const getRoleFormMappingById = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.query.id);
    if (!id) {
      return sendError(res, 'Invalid mapping ID.', 400);
    }

    const mapping = await rbacService.getRoleFormMappingById(id);
    return sendSuccess(res, mapping, 'Role form mapping fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role form mapping');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.getRoleFormMappingById error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * POST /api/v1/roles/form-mappings
 * Management only. Maps one additional form onto one role.
 * Body: { role_id, form_id }
 */
const createRoleFormMapping = async (req, res, next) => {
  try {
    const mapping = await rbacService.createRoleFormMapping(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, mapping, 'Role form mapping created successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.createRoleFormMapping error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * DELETE /api/v1/roles/form-mappings/:roleId/:formId
 * Management only. Removes one form mapping from one role.
 */
const deleteRoleFormMapping = async (req, res, next) => {
  try {
    const roleId = parsePositiveInt(req.params.roleId);
    const formId = parsePositiveInt(req.params.formId);
    if (!roleId || !formId) {
      return sendError(res, 'Invalid role ID or form ID.', 400);
    }

    await rbacService.deleteRoleFormMapping({ role_id: roleId, form_id: formId }, req.userId, getIpAddress(req));
    return sendSuccess(res, null, 'Role form mapping deleted successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role form mapping');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.deleteRoleFormMapping error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PUT /api/v1/roles/form-mappings/:roleId
 * Management only. Replaces the role's entire set of form mappings in one
 * call — every form_id given is set active, every other form currently
 * mapped to this role is unmapped. Bulk counterpart to the single-form
 * POST/DELETE /roles/form-mappings endpoints above.
 */
const replaceRoleFormMappings = async (req, res, next) => {
  try {
    const roleId = parsePositiveInt(req.params.roleId);
    if (!roleId) {
      return sendError(res, 'Invalid role ID.', 400);
    }

    const mappings = await rbacService.replaceRoleFormMappings(roleId, req.body.form_ids, req.userId, getIpAddress(req));
    return sendSuccess(res, mappings, 'Role form mappings updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role or one of the given forms');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.replaceRoleFormMappings error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * POST /api/v1/roles/forms/mapping
 * Management only. Maps or unmaps a form for a role via the status flag —
 * a dedicated endpoint that never physically deletes a row (soft-mapping).
 * Idempotent: mapping an already-active form, or unmapping an
 * already-inactive one, both succeed without change.
 * Body: { roleId, formId, status }
 */
const mapForm = async (req, res, next) => {
  try {
    const mapping = await rbacService.mapForm(req.body, req.userId, getIpAddress(req));
    const message = req.body.status
      ? 'Form mapped to role successfully.'
      : 'Form unmapped from role successfully.';
    return sendSuccess(res, mapping, message);
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Role or form');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.mapForm error', { error: err.message, stack: err.stack });
    next(err);
  }
};

// ── Get Forms for Role(s) ────────────────────────────────────────────────────

/**
 * POST /api/v1/roles/forms
 * Management only. Fetches EVERY active form in the system for the given
 * role IDs, each annotated with whether it is currently actively mapped —
 * the admin Role-Form mapping screen's data source (a complete checklist,
 * not just currently-mapped forms). Grouped by module.
 * Body: { roleIds: number[] }
 */
const formsForRoles = async (req, res, next) => {
  try {
    const forms = await rbacService.getFormsWithMappingStatus(req.body.roleIds);
    return sendSuccess(res, forms, 'Forms fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('rbacController.formsForRoles error', { error: err.message, stack: err.stack });
    next(err);
  }
};

module.exports = {
  userMappings,
  createUserMapping,
  replaceUserRoles,
  deleteUserMapping,
  roleFormMappings,
  getRoleFormMappingById,
  createRoleFormMapping,
  deleteRoleFormMapping,
  replaceRoleFormMappings,
  mapForm,
  formsForRoles,
};
