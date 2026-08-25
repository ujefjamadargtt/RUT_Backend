'use strict';

const formMasterService = require('../services/formMasterService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Category Controller
 * The optional Module -> Category -> Form layer (Management only). A
 * category always belongs to exactly one module — see
 * formMasterService.js's category functions.
 */

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * GET /api/v1/forms/categories
 * Management only. Lists categories, optionally filtered by module_id/status.
 */
const getAll = async (req, res, next) => {
  try {
    const categories = await formMasterService.getCategories(req.query);
    return sendSuccess(res, categories, 'Categories fetched successfully.');
  } catch (err) {
    logger.error('categoryController.getAll error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * GET /api/v1/forms/categories/:id
 * Management only.
 */
const getById = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid category ID.', 400);
    }

    const category = await formMasterService.getCategoryById(id);
    return sendSuccess(res, category, 'Category fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Category');
    }
    logger.error('categoryController.getById error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * POST /api/v1/forms/categories
 * Management only. Creates a category under an existing module.
 */
const create = async (req, res, next) => {
  try {
    const category = await formMasterService.createCategory(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, category, 'Category created successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('categoryController.create error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PUT /api/v1/forms/categories/:id
 * Management only. Renames/describes/(de)activates a category. module_id
 * is immutable — a category is never moved between modules.
 */
const update = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid category ID.', 400);
    }

    const category = await formMasterService.updateCategory(id, req.body, req.userId, getIpAddress(req));
    return sendSuccess(res, category, 'Category updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Category');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('categoryController.update error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * DELETE /api/v1/forms/categories/:id
 * Management only. Soft-deactivates a category. Blocked if it still has
 * forms assigned to it.
 */
const remove = async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return sendError(res, 'Invalid category ID.', 400);
    }

    const category = await formMasterService.deactivateCategory(id, req.userId, getIpAddress(req));
    return sendSuccess(res, category, 'Category deactivated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Category');
    }
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('categoryController.remove error', { error: err.message, stack: err.stack });
    next(err);
  }
};

/**
 * PATCH /api/v1/forms/categories/reorder
 * Management only. Bulk-updates category seq values within one module.
 * Body: { module_id, items: [{ id, seq }] }
 */
const reorder = async (req, res, next) => {
  try {
    const categories = await formMasterService.reorderCategories(
      req.body.module_id,
      req.body.items,
      req.userId,
      getIpAddress(req)
    );
    return sendSuccess(res, categories, 'Categories reordered successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('categoryController.reorder error', { error: err.message, stack: err.stack });
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
  reorder,
};
