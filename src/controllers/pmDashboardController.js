'use strict';

const pmDashboardService = require('../services/pmDashboardService');
const companyAccessControlService = require('../services/companyAccessControlService');
const { parseIdList } = require('../utils/idListParser');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * The BU scope every PM Dashboard endpoint queries with.
 *
 * Default (no multi-select): req.companyIds exactly as resolveReportCompanyScope
 * set it — role reach, narrowed to the X-Company-Id header's BU (+ Sub-BUs)
 * when one is sent. Unchanged behaviour.
 *
 * Multi-select (`businessUnitIds=12,45` and/or `buId=all`): the header's
 * single-BU narrowing is ignored — otherwise it would already have cut
 * req.companyIds down to ONE BU and every other selected BU would be
 * silently dropped. Instead start from the caller's FULL reach and narrow it
 * to the selected ids, each including its own Sub-BUs. Never widens access:
 * an id outside the caller's reach simply drops out; if ALL of them are
 * outside it, 403.
 *
 * @param {import('express').Request} req
 * @returns {Promise<number[]>}
 */
async function resolvePMDashboardCompanyIds(req) {
  const requestedIds = parseIdList(req.query.businessUnitIds) || [];
  const allBusinessUnits = String(req.query.buId || '').trim().toLowerCase() === 'all';
  if (requestedIds.length === 0 && !allBusinessUnits) {
    return req.companyIds;
  }

  const fullReach = await companyAccessControlService.resolveActorFullReach({
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
    employeeBusinessUnits: req.employeeBusinessUnits,
  });
  const scoped = await companyAccessControlService.intersectIdsWithBuHierarchy(fullReach, requestedIds);
  if (scoped.length === 0) {
    // Every selected id is outside the caller's reach — same 403 an
    // unauthorised X-Company-Id header already gets (and the downstream
    // `IN (:companyIds)` queries can't take an empty list).
    const err = new Error('Access denied: none of the selected Business Units are within your authorised scope.');
    err.statusCode = 403;
    throw err;
  }
  return scoped;
}

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
      const companyIds = await resolvePMDashboardCompanyIds(req);
      const result = await serviceFn(req.query, authContext, companyIds);

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
  // Fixed-size (12-row) array, not a paginated list — same convention as
  // managementReportController.getServiceLineBusinessMix.
  getMonthlyHoursTrend: buildHandler('PM Dashboard monthly hours trend', pmDashboardService.getMonthlyHoursTrend),
};
