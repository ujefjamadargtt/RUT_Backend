'use strict';

const servicePOMonthlyBudgetService = require('../services/servicePOMonthlyBudgetService');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Service PO Monthly Budget Controller
 * Thin layer: parse request, delegate to service, format response.
 */

/**
 * GET /api/v1/service-po-monthly-budgets
 */
const getOne = async (req, res) => {
  try {
    const record = await servicePOMonthlyBudgetService.getOne(req.query, req.companyId);
    return sendSuccess(res, record, 'Service PO monthly budget fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('getOne (ServicePOMonthlyBudget) error', { error: error.message, query: req.query });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-po-monthly-budgets/current
 */
const getCurrentMonth = async (req, res) => {
  try {
    const data = await servicePOMonthlyBudgetService.getCurrentMonth(req.companyId);
    return sendSuccess(res, data, 'Current month Service PO budget data fetched successfully.');
  } catch (error) {
    logger.error('getCurrentMonth (ServicePOMonthlyBudget) error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-po-monthly-budgets
 */
const upsert = async (req, res) => {
  try {
    const { record, deadline } = await servicePOMonthlyBudgetService.upsert(req.body, req.userId, req);
    return sendSuccess(res, { ...record.toJSON(), deadline }, 'Service PO monthly budget saved successfully.', 200);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('upsert (ServicePOMonthlyBudget) error', { error: error.message, body: req.body, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getOne,
  getCurrentMonth,
  upsert,
};
