'use strict';

const logger = require('../utils/logger');
const companyAccessControlService = require('../services/companyAccessControlService');

/**
 * Additive companion to resolveCompany.js (run at the tail of authenticate())
 * for the handful of endpoints that read `req.companyId` directly with no
 * concept of an owned-Company-id ARRAY — Reports, Dashboard analytics,
 * Timesheet Admin CRUD, Cost Budget, Service PO Monthly Budget. For a
 * BU-scoped actor (rank >= 4), resolveCompany.js has already set a single
 * `req.companyId`, so this is a no-op. For a company-less actor (Admin rank
 * 2 / Entity Admin rank 3), resolveCompany.js deliberately leaves
 * `req.companyId` unset (they're Entity/platform-scoped, not
 * Business-Unit-scoped) — this fills it in with ONE of their OWNED
 * Companies, using the same "0 -> reject, 1 -> auto, >1 -> X-Company-Id
 * header required" contract resolveCompany.js already applies to BU Admins,
 * instead of leaving `req.companyId` undefined (which otherwise reaches a
 * repository as a raw `undefined` WHERE value, or silently filters out
 * every row).
 *
 * Deliberately does NOT apply to Platform Admin (rank 1) or to any resource
 * that legitimately wants the full owned-Company-id ARRAY (Client, Project,
 * Service PO, Employee, Resource Budget, ...) — those already resolve scope
 * themselves via companyAccessControlService.resolveActorCompanyScope() and
 * must keep receiving the array, not a single collapsed value. Only mount
 * this on the specific route files that need it.
 *
 * Must run AFTER authenticate() (which sets req.companyId/req.hierarchyRank/
 * req.employeeId).
 */
const resolveCompanyContextForCompanyLessActors = async (req, res, next) => {
  try {
    if (req.companyId != null) {
      return next();
    }

    if (req.hierarchyRank !== 2 && req.hierarchyRank !== 3) {
      // Platform Admin (rank 1) and any other company-less case: unchanged,
      // pre-existing behavior — not in scope for this BU-selection contract.
      return next();
    }

    const rawHeader = req.headers['x-company-id'];
    const headerCompanyId = rawHeader ? parseInt(rawHeader, 10) : null;

    const result = await companyAccessControlService.resolveSingleCompanyIdForCompanyLessActor(
      req.hierarchyRank,
      req.employeeId,
      headerCompanyId
    );

    if (result.error) {
      logger.warn('Company-less actor could not resolve a single Business Unit context', {
        employeeId: req.employeeId,
        hierarchyRank: req.hierarchyRank,
        headerCompanyId,
        path: req.path,
        method: req.method,
        code: result.error.code,
      });
      return res.status(result.error.statusCode).json({
        success: false,
        message: result.error.message,
        code: result.error.code,
      });
    }

    req.companyId = result.companyId;
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = resolveCompanyContextForCompanyLessActors;
