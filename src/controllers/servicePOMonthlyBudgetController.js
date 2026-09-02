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
 *
 * With service_po_id: the single record for that Service PO (404 if it
 * doesn't exist, belongs to another company, or is outside the caller's
 * role scope). Without it: every monthly budget record saved for month/year
 * across every Service PO the caller's role is allowed to see.
 */
const getOne = async (req, res) => {
  try {
    // req.companyIds (array): every BU this BU-scoped caller is mapped to
    // when X-Company-Id is omitted, or their role reach for a company-less
    // Admin/Entity Admin/Platform Admin — see resolveReportCompanyScope.js.
    // This route runs authenticateReadMultiBU, not the single-req.companyId
    // chain GET /current and POST / still use.
    if (req.query.service_po_id !== undefined) {
      const record = await servicePOMonthlyBudgetService.getOne(req.query, req.companyIds, req.userId, req.userRoleName, req.employeeId);
      return sendSuccess(res, record, 'Service PO monthly budget fetched successfully.');
    }

    const data = await servicePOMonthlyBudgetService.listMonthlyBudgets(req.query, req.companyIds, req.userId, req.userRoleName, req.employeeId);
    return sendSuccess(res, data, 'Service PO monthly budgets fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('getOne (ServicePOMonthlyBudget) error', { error: error.message, query: req.query });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-po-monthly-budgets/service-pos
 * The Service PO dropdown — active Service POs the caller's role is
 * allowed to see, no budget data.
 */
const listServicePOs = async (req, res) => {
  try {
    const data = await servicePOMonthlyBudgetService.listServicePOsForDropdown(req.companyIds, req.userId, req.userRoleName, req.employeeId);
    return sendSuccess(res, data, 'Service PO list fetched successfully.');
  } catch (error) {
    logger.error('listServicePOs (ServicePOMonthlyBudget) error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-po-monthly-budgets/current
 */
const getCurrentMonth = async (req, res) => {
  try {
    const data = await servicePOMonthlyBudgetService.getCurrentMonth(req.companyId, req.userId, req.userRoleName, req.employeeId);
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
  listServicePOs,
  getCurrentMonth,
  upsert,
};
