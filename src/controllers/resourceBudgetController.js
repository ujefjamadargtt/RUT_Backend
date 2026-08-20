'use strict';

const resourceBudgetService = require('../services/resourceBudgetService');
const { sendSuccess, sendCreated, sendNoContent, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Resource Budget Controller
 * Thin layer: parse request, delegate to service, format response.
 */

const isKnownClientError = (error) => error.statusCode === 404 || error.statusCode === 400;

/**
 * GET /api/v1/resource-budgets/service-po/:servicePoId/mapped-employees
 */
const getMappedEmployees = async (req, res) => {
  try {
    const servicePOId = parseInt(req.params.servicePoId, 10);
    if (isNaN(servicePOId) || servicePOId < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const employees = await resourceBudgetService.getMappedEmployees(servicePOId, req.companyId);
    return sendSuccess(res, employees, 'Mapped employees fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('getMappedEmployees (ResourceBudget) error', { error: error.message, servicePoId: req.params.servicePoId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/resource-budgets
 */
const create = async (req, res) => {
  try {
    const record = await resourceBudgetService.create(req.body, req.userId, req);
    return sendCreated(res, record, 'Resource budget created successfully.');
  } catch (error) {
    if (isKnownClientError(error)) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('create (ResourceBudget) error', { error: error.message, body: req.body, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/resource-budgets/bulk
 */
const bulkUpsert = async (req, res) => {
  try {
    const records = await resourceBudgetService.bulkUpsert(req.body, req.userId, req);
    return sendSuccess(res, records, 'Resource budgets saved successfully.', 200);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    if (error.statusCode === 400) {
      return sendError(res, error.message, 400, error.errors || []);
    }
    logger.error('bulkUpsert (ResourceBudget) error', { error: error.message, body: req.body, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * PUT /api/v1/resource-budgets/:id
 */
const update = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid resource budget ID.', 400);
    }

    const record = await resourceBudgetService.update(id, req.body, req.userId, req);
    return sendSuccess(res, record, 'Resource budget updated successfully.');
  } catch (error) {
    if (isKnownClientError(error)) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('update (ResourceBudget) error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * DELETE /api/v1/resource-budgets/:id
 */
const deactivate = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid resource budget ID.', 400);
    }

    await resourceBudgetService.deactivate(id, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('deactivate (ResourceBudget) error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/resource-budgets/service-po/:servicePoId
 */
const listByServicePO = async (req, res) => {
  try {
    const servicePOId = parseInt(req.params.servicePoId, 10);
    if (isNaN(servicePOId) || servicePOId < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const records = await resourceBudgetService.listByServicePO(servicePOId, req.companyId);
    return sendSuccess(res, records, 'Resource budgets fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('listByServicePO (ResourceBudget) error', { error: error.message, servicePoId: req.params.servicePoId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/resource-budgets
 */
const list = async (req, res) => {
  try {
    const records = await resourceBudgetService.list(req.query, req.companyId);
    return sendSuccess(res, records, 'Resource budgets fetched successfully.');
  } catch (error) {
    logger.error('list (ResourceBudget) error', { error: error.message, query: req.query });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getMappedEmployees,
  create,
  bulkUpsert,
  update,
  deactivate,
  listByServicePO,
  list,
};
