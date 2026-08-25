'use strict';

const logger = require('../utils/logger');

/**
 * Company-scoping gate. Runs as the tail of authenticate() (see auth.js) so
 * it reaches every authenticated route without touching any of the
 * per-route authenticate() call sites.
 *
 * Employee-as-Identity redesign: every Employee (not just the old BU
 * Head) is now scoped to a SET of Business Units (employee_business_units,
 * req.employeeBusinessUnits — populated by auth.js), not a single
 * company_id column. Reads the X-Company-Id header and validates it
 * against that set:
 *   - 0 BUs -> 403 (nothing to scope into).
 *   - exactly 1 BU -> req.companyId is that BU; header optional, but if
 *     present it's cross-checked against it.
 *   - >1 BUs -> X-Company-Id header is required and must be one of them.
 *
 * Platform Admin (rank 1) and Admin/Entity Admin (ranks 2-3) are exempt —
 * they are platform-wide/Entity-scoped, not Business-Unit-scoped; see the
 * early-return block below, unchanged from the pre-redesign behavior.
 */
const resolveCompany = async (req, res, next) => {
  if (req.hierarchyRank === 1) {
    // Platform Admin has no company and never touches business routes.
    return next();
  }

  // Admin (rank 2) is platform-wide. Entity Admin (rank 3) is scoped to a
  // SET of Entities (req.entityIds, populated by requireEntityAdmin.js /
  // requireEntityAdminOrAdmin.js), not a single company. Skip
  // single-company resolution for both.
  if (req.hierarchyRank === 2 || req.hierarchyRank === 3) {
    return next();
  }

  const businessUnits = req.employeeBusinessUnits || [];

  if (businessUnits.length === 0) {
    logger.warn('Employee has no active Business Unit membership', {
      employeeId: req.employeeId,
      path: req.path,
      method: req.method,
    });
    return res.status(403).json({
      success: false,
      message: 'Access denied: no Business Unit is assigned to your account.',
      code: 'NO_BUSINESS_UNIT',
    });
  }

  const rawHeader = req.headers['x-company-id'];
  const headerCompanyId = rawHeader ? parseInt(rawHeader, 10) : null;

  if (businessUnits.length === 1) {
    const onlyBu = businessUnits[0];
    if (headerCompanyId && headerCompanyId !== onlyBu.id) {
      logger.warn('Company header does not match employee\'s sole Business Unit', {
        employeeId: req.employeeId,
        businessUnitId: onlyBu.id,
        headerCompanyId,
        path: req.path,
        method: req.method,
      });
      return res.status(403).json({
        success: false,
        message: 'Access denied: this Business Unit is not assigned to you.',
        code: 'BU_NOT_MAPPED',
      });
    }
    req.companyId = onlyBu.id;
    return next();
  }

  // More than one BU — the header is required and must be one of them.
  if (!headerCompanyId) {
    return res.status(400).json({
      success: false,
      message: 'X-Company-Id header is required.',
      code: 'COMPANY_HEADER_REQUIRED',
    });
  }

  const isMapped = businessUnits.some((bu) => bu.id === headerCompanyId);
  if (!isMapped) {
    logger.warn('Employee attempted to access an unmapped Business Unit', {
      employeeId: req.employeeId,
      headerCompanyId,
      path: req.path,
      method: req.method,
    });
    return res.status(403).json({
      success: false,
      message: 'Access denied: this Business Unit is not assigned to you.',
      code: 'BU_NOT_MAPPED',
    });
  }

  req.companyId = headerCompanyId;
  next();
};

module.exports = resolveCompany;
