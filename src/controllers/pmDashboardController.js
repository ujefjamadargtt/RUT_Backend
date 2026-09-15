'use strict';

const pmDashboardService = require('../services/pmDashboardService');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Project Manager Dashboard Controller
 * Each method maps 1:1 with a route in pmDashboard.routes.js. All are
 * GET-only endpoints. Mirrors managementReportController.js's buildHandler
 * pattern.
 */

function buildAuthContext(req) {
  return {
    userId: req.userId,
    employeeId: req.employeeId,
    hierarchyRank: req.hierarchyRank,
    roleNames: req.userRoles || [],
  };
}

function buildHandler(name, serviceFn, { paginated = false } = {}) {
  return async function handler(req, res, next) {
    try {
      const authContext = buildAuthContext(req);
      const result = await serviceFn(req.query, authContext, req.companyIds);

      if (paginated) {
        const { data, meta, ...rest } = result;
        return sendPaginated(res, { records: data, ...rest }, meta, `${name} fetched successfully.`);
      }
      return sendSuccess(res, result, `${name} fetched successfully.`);
    } catch (err) {
      if (err.statusCode) {
        return sendError(res, err.message, err.statusCode);
      }
      logger.error(`${name} error`, { error: err.message, stack: err.stack });
      next(err);
    }
  };
}

module.exports = {
  getSummary: buildHandler('PM Dashboard summary', pmDashboardService.getSummary),
  getProjects: buildHandler('PM Dashboard project rollup', pmDashboardService.getProjects, { paginated: true }),
  getTeam: buildHandler('PM Dashboard team capacity', pmDashboardService.getTeam, { paginated: true }),
  getWorklog: buildHandler('PM Dashboard work log compliance', pmDashboardService.getWorklog, { paginated: true }),
  getActionRequired: buildHandler('PM Dashboard action required', pmDashboardService.getActionRequired),
};
