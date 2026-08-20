'use strict';

const costBudgetService = require('../services/costBudgetService');
const { sendSuccess, sendCreated, sendNoContent, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Cost Budget Controller
 * Thin layer: parse request, delegate to service, format response.
 */

/**
 * POST /api/v1/cost-budgets
 */
const create = async (req, res) => {
  try {
    const record = await costBudgetService.create(req.body, req.userId, req);
    return sendCreated(res, record, 'Cost budget created successfully.');
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 400) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('create (CostBudget) error', { error: error.message, body: req.body, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * PUT /api/v1/cost-budgets/:id
 */
const update = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid cost budget ID.', 400);
    }

    const record = await costBudgetService.update(id, req.body, req.userId, req);
    return sendSuccess(res, record, 'Cost budget updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('update (CostBudget) error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * DELETE /api/v1/cost-budgets/:id
 */
const deactivate = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid cost budget ID.', 400);
    }

    await costBudgetService.deactivate(id, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('deactivate (CostBudget) error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/cost-budgets/service-po/:servicePoId
 */
const listByServicePO = async (req, res) => {
  try {
    const servicePOId = parseInt(req.params.servicePoId, 10);
    if (isNaN(servicePOId) || servicePOId < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const records = await costBudgetService.listByServicePO(servicePOId, req.companyId);
    return sendSuccess(res, records, 'Cost budgets fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('listByServicePO (CostBudget) error', { error: error.message, servicePoId: req.params.servicePoId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/cost-budgets
 */
const list = async (req, res) => {
  try {
    const records = await costBudgetService.list(req.query, req.companyId);
    return sendSuccess(res, records, 'Cost budgets fetched successfully.');
  } catch (error) {
    logger.error('list (CostBudget) error', { error: error.message, query: req.query });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  create,
  update,
  deactivate,
  listByServicePO,
  list,
};
