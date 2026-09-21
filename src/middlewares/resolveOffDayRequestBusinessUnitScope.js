'use strict';

const companyAccessControlService = require('../services/companyAccessControlService');

// Platform Admin (1) / Admin (2) / Entity Admin (3) — the cross-BU tier
// resolveCompany.js (part of the default authenticate() chain) short-circuits
// for, WITHOUT ever reading X-Company-Id.
const CROSS_BU_MAX_RANK = 3;

/**
 * GET /my-team/off-day-requests scopes its queue to ONE Business Unit at a
 * time via X-Company-Id, same as every other /my-team/* endpoint — but
 * resolveCompany.js returns early for a cross-BU actor (hierarchy_rank <= 3)
 * without ever looking at that header, leaving req.companyId permanently
 * undefined for them. offDayWorkRequestService.listPendingQueue() pushes
 * companyId straight into its repository WHERE clause, so an undefined
 * companyId silently returns every Business Unit's requests no matter which
 * X-Company-Id the caller actually sent — confirmed live: six different real
 * BU ids (plus no header at all) on an Admin login all returned the
 * identical 6 rows.
 *
 * Runs AFTER authenticate() (so req.hierarchyRank/req.employeeId/
 * req.employeeBusinessUnits are already populated) and only acts when
 * resolveCompany left req.companyId unset for a cross-BU actor — a BU-scoped
 * actor (rank >= 4) already has a correctly header-derived req.companyId by
 * this point and is left completely untouched. When X-Company-Id is
 * present, resolves + validates it via the SAME resolveReportCompanyScope()
 * every other cross-BU-aware /my-team and /reports endpoint already uses
 * (Platform Admin -> any real Company; Admin/Entity Admin -> one of their
 * own owned Companies), then narrows req.companyId to it. No header ->
 * req.companyId stays undefined, preserving the existing "every reachable
 * BU's queue at once" default for this tier — this fix only makes the
 * header actually work when the caller sends one, it doesn't newly require it.
 */
const resolveOffDayRequestBusinessUnitScope = async (req, res, next) => {
  try {
    if (req.companyId != null || !Number.isInteger(req.hierarchyRank) || req.hierarchyRank > CROSS_BU_MAX_RANK) {
      return next();
    }

    const rawHeader = req.headers['x-company-id'];
    if (rawHeader == null || rawHeader === '') {
      return next();
    }

    const headerCompanyId = parseInt(rawHeader, 10);
    if (isNaN(headerCompanyId) || headerCompanyId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'X-Company-Id must be a positive integer.',
        code: 'INVALID_COMPANY_HEADER',
      });
    }

    const scoped = await companyAccessControlService.resolveReportCompanyScope(
      { hierarchyRank: req.hierarchyRank, employeeId: req.employeeId, employeeBusinessUnits: req.employeeBusinessUnits },
      headerCompanyId
    );
    req.companyId = scoped[0];
    return next();
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
    }
    return next(error);
  }
};

module.exports = resolveOffDayRequestBusinessUnitScope;
