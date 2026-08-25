'use strict';

const formMasterService = require('../services/formMasterService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Form Master Controller
 * Every screen/module available in the application — CRUD, module dropdown,
 * and reorder support (Requirement 3 + Form Sequence).
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

/**
 * GET /api/v1/forms
 * Management only. Lists all forms and modules, optionally filtered by
 * status/search/module_name.
 */
const getAll = async (req, res, next) => {
  try {
    const forms = await formMasterService.getAll(req.query);
    return sendSuccess(res, forms, 'Forms fetched successfully.');
  } catch (err) {
    logger.error('formMasterController.getAll error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * GET /api/v1/forms/modules
 * Management only. Lists only module rows (module_name IS NULL) — the
 * Create Form screen's Module dropdown data source.
 */
const getModules = async (req, res, next) => {
  try {
    const modules = await formMasterService.getModules(req.query.status);
    return sendSuccess(res, modules, 'Modules fetched successfully.');
  } catch (err) {
    logger.error('formMasterController.getModules error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * GET /api/v1/forms/:id
 * Management only.
 */
const getById = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid form ID.', 400);
    }

    const form = await formMasterService.getById(id);
    return sendSuccess(res, form, 'Form fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Form');
    }
    logger.error('formMasterController.getById error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * POST /api/v1/forms
 * Management only. Registers a new module (module_name omitted/null) or a
 * new form under an existing module (module_name = the module's name).
 */
const create = async (req, res, next) => {
  try {
    const form = await formMasterService.create(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, form, 'Form created successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('formMasterController.create error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PUT /api/v1/forms/:id
 * Management only. A row can never flip between module and form here.
 */
const update = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid form ID.', 400);
    }

    const form = await formMasterService.update(id, req.body, req.userId, getIpAddress(req));
    return sendSuccess(res, form, 'Form updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Form');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('formMasterController.update error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * DELETE /api/v1/forms/:id
 * Management only. Soft-deactivates a form or module (status = 'inactive')
 * rather than hard-deleting it, since existing role_form_mapping rows may
 * reference it. Blocked if a module still has forms registered under it.
 */
const remove = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid form ID.', 400);
    }

    const form = await formMasterService.deactivate(id, req.userId, getIpAddress(req));
    return sendSuccess(res, form, 'Form deactivated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Form');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('formMasterController.remove error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * GET /api/v1/forms/hierarchy
 * Management only. The full Module -> Category -> Form tree.
 */
const getHierarchy = async (req, res, next) => {
  try {
    const hierarchy = await formMasterService.getHierarchy();
    return sendSuccess(res, hierarchy, 'Form hierarchy fetched successfully.');
  } catch (err) {
    logger.error('formMasterController.getHierarchy error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PUT /api/v1/forms/:id/move
 * Management only. Moves a form Module<->Category/Category<->Category —
 * never renames or (de)activates it (use PUT /forms/:id for that).
 */
const move = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid form ID.', 400);
    }

    const form = await formMasterService.moveForm(id, req.body, req.userId, getIpAddress(req));
    return sendSuccess(res, form, 'Form moved successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Form');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('formMasterController.move error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PATCH /api/v1/forms/modules/reorder
 * Management only. Bulk-updates module seq values.
 * Body: { items: [{ id, seq }] }
 */
const reorderModules = async (req, res, next) => {
  try {
    const modules = await formMasterService.reorderModules(req.body.items, req.userId, getIpAddress(req));
    return sendSuccess(res, modules, 'Modules reordered successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('formMasterController.reorderModules error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PATCH /api/v1/forms/reorder
 * Management only. Bulk-updates form seq values within one module.
 * Body: { module_name, items: [{ id, seq }] }
 */
const reorderForms = async (req, res, next) => {
  try {
    const forms = await formMasterService.reorderForms(
      req.body.module_name,
      req.body.items,
      req.userId,
      getIpAddress(req)
    );
    return sendSuccess(res, forms, 'Forms reordered successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('formMasterController.reorderForms error', { error: err.message, stack: err.stack });
    next(err);
  }
};

module.exports = {
  getAll,
  getModules,
  getById,
  getHierarchy,
  create,
  update,
  move,
  remove,
  reorderModules,
  reorderForms,
};
