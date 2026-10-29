'use strict';

const companyAccessControlService = require('../services/companyAccessControlService');

/**
 * Company-scope resolution for the AI Insight endpoints. Same contract as
 * resolveReportCompanyScope.js (role reach, never "nothing"; sets req.companyIds,
 * always an array) with one addition — a multi-select:
 *
 *   ?company_ids=1,2,3   comma-separated Business Unit / Sub-BU ids
 *
 * Precedence: company_ids  >  company_id (query)  >  X-Company-Id (header).
 *
 *   - company_ids: every id is validated against the caller's FULL reach — if ANY
 *     id is outside it the request is rejected with 403 BU_NOT_MAPPED (never
 *     silently dropped). A Parent BU id also pulls in its Sub-BUs, kept only if
 *     they are within the caller's reach, so the multi-select can never widen it.
 *   - company_id / header: unchanged — resolved exactly as resolveReportCompanyScope does.
 *   - A blank company_ids (`?company_ids=`) is treated as absent. A malformed one is a 400.
 *
 * Must run AFTER authenticateIdentity (req.hierarchyRank / req.employeeId /
 * req.employeeBusinessUnits set), never after the full authenticate().
 */
const MAX_COMPANY_IDS = 100;

function parseId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

/**
 * @param {string|string[]|undefined} raw - the company_ids query value
 * @returns {number[]|null} deduped ids, or null when absent/blank
 * @throws {Error} statusCode 400 when malformed
 */
function parseCompanyIds(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : raw;
  if (text === undefined || text === null || String(text).trim() === '') return null;

  const parts = String(text).split(',').map((part) => part.trim());
  const ids = parts.map((part) => (/^[1-9]\d*$/.test(part) ? parseInt(part, 10) : NaN));
  if (ids.some(Number.isNaN) || ids.length > MAX_COMPANY_IDS) {
    const err = new Error(`company_ids must be a comma-separated list of up to ${MAX_COMPANY_IDS} positive integers, e.g. 1,2,3.`);
    err.statusCode = 400;
    err.code = 'INVALID_COMPANY_IDS';
    throw err;
  }
  return [...new Set(ids)];
}

const resolveInsightCompanyScope = async (req, res, next) => {
  try {
    const authContext = {
      hierarchyRank: req.hierarchyRank,
      employeeId: req.employeeId,
      employeeBusinessUnits: req.employeeBusinessUnits,
    };

    const requestedIds = parseCompanyIds(req.query.company_ids);

    if (requestedIds) {
      // The caller's full reach (already includes every Sub-BU of a reachable Parent).
      const reach = await companyAccessControlService.resolveReportCompanyScope(authContext, null);
      const reachSet = new Set(reach);

      const outside = requestedIds.filter((id) => !reachSet.has(id));
      if (outside.length > 0) {
        const err = new Error('Access denied: a selected Business Unit is not assigned to your account.');
        err.statusCode = 403;
        err.code = 'BU_NOT_MAPPED';
        throw err;
      }

      // A Parent id includes its Sub-BUs — only those within the caller's reach.
      const expanded = await companyAccessControlService.expandBusinessUnitIdsWithDescendants(requestedIds);
      req.companyIds = [...new Set(expanded)].filter((id) => reachSet.has(id));
      return next();
    }

    const queryCompanyId = parseId(req.query.company_id);
    const headerCompanyId = parseId(req.headers['x-company-id']);

    req.companyIds = await companyAccessControlService.resolveReportCompanyScope(
      authContext,
      queryCompanyId != null ? queryCompanyId : headerCompanyId
    );
    return next();
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
    }
    return next(err);
  }
};

module.exports = resolveInsightCompanyScope;
module.exports.parseCompanyIds = parseCompanyIds;
