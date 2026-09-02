'use strict';

const managementReportService = require('../services/managementReportService');
const { sendPaginated, sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Management Report Controller
 * The 10 new management/business reports approved on top of the existing
 * Report module. Each method maps 1:1 with a route in
 * managementReport.routes.js. All are GET-only endpoints.
 */

function buildHandler(name, serviceFn, { useReq = false } = {}) {
  return async function handler(req, res, next) {
    try {
      const filters = { ...req.body, ...req.query };
      const result = useReq
        ? await serviceFn(filters, req)
        : await serviceFn(filters, req.companyIds);
      const { data, meta, ...rest } = result;
      return sendPaginated(res, { records: data, ...rest }, meta, `${name} fetched successfully.`);
    } catch (err) {
      if (err.statusCode) {
        return sendError(res, err.message, err.statusCode);
      }
      logger.error(`${name} error`, { error: err.message, stack: err.stack });
      next(err);
    }
  };
}

const getServicePOProfitability = buildHandler('Service PO Profitability report', managementReportService.getServicePOProfitability);
const getBudgetedMarginForecast = buildHandler('Budgeted Margin Forecast report', managementReportService.getBudgetedMarginForecast);
const getResourceStaffingPlanAccuracy = buildHandler('Resource Staffing Plan Accuracy report', managementReportService.getResourceStaffingPlanAccuracy);
const getClientProfitabilityConcentration = buildHandler('Client Profitability & Concentration report', managementReportService.getClientProfitabilityConcentration);
const getBUPerformanceScorecard = buildHandler('BU Performance Scorecard', managementReportService.getBUPerformanceScorecard, { useReq: true });
const getEmployeeCapacityForecast = buildHandler('Employee Capacity & Bench Forecast report', managementReportService.getEmployeeCapacityForecast);
const getServicePOTimelineRisk = buildHandler('Service PO Budget & Timeline Risk report', managementReportService.getServicePOTimelineRisk);
const getDeliveryHeadPerformance = buildHandler('Delivery Head Performance report', managementReportService.getDeliveryHeadPerformance);
const getInvoiceRealizationTrend = buildHandler('Invoice Realization / Billing Efficiency report', managementReportService.getInvoiceRealizationTrend);

/**
 * Report 10 is not paginated (small, fixed-size result set — one row per
 * service category x service type combination) so it uses sendSuccess
 * directly instead of the shared buildHandler/sendPaginated helper.
 */
async function getServiceLineBusinessMix(req, res, next) {
  try {
    const filters = { ...req.body, ...req.query };
    const result = await managementReportService.getServiceLineBusinessMix(filters, req.companyIds);
    return sendSuccess(res, result, 'Service Line Business Mix report fetched successfully.');
  } catch (err) {
    if (err.statusCode) {
      return sendError(res, err.message, err.statusCode);
    }
    logger.error('getServiceLineBusinessMix error', { error: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = {
  getServicePOProfitability,
  getBudgetedMarginForecast,
  getResourceStaffingPlanAccuracy,
  getClientProfitabilityConcentration,
  getBUPerformanceScorecard,
  getEmployeeCapacityForecast,
  getServicePOTimelineRisk,
  getDeliveryHeadPerformance,
  getInvoiceRealizationTrend,
  getServiceLineBusinessMix,
};
