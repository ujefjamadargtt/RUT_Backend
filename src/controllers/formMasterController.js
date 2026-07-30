'use strict';

const formMasterService = require('../services/formMasterService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Form Master Controller
 * Every screen/form available in the application — CRUD for Requirement 3.
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
 * Management only. Lists all forms, optionally filtered by status/search.
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
 * Management only. Registers a new screen/form.
 * Body: { module_name, form_name, status? }
 */
const create = async (req, res, next) => {
  try {
    const form = await formMasterService.create(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, form, 'Form created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    logger.error('formMasterController.create error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PUT /api/v1/forms/:id
 * Management only.
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
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    logger.error('formMasterController.update error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * DELETE /api/v1/forms/:id
 * Management only. Soft-deactivates a form (status = 'inactive') rather
 * than hard-deleting it, since existing role_form_mapping rows reference it.
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
    logger.error('formMasterController.remove error', { error: err.message, stack: err.stack });
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
};
