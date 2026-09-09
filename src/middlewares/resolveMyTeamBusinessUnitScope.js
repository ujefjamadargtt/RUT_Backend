'use strict';

const companyAccessControlService = require('../services/companyAccessControlService');

/**
 * Resolves the optional BU selection for GET /my-team/employees without
 * requiring X-Company-Id. This lets a multi-BU Manager select "All Business
 * Units" while retaining the normal entitlement check for either selector.
 * `business_unit_id` takes precedence when both selectors are supplied.
 */
const resolveMyTeamBusinessUnitScope = async (req, res, next) => {
  try {
    const rawHeader = req.headers['x-company-id'];
    const headerBusinessUnitId = rawHeader == null || rawHeader === '' ? null : parseInt(rawHeader, 10);
    if (rawHeader != null && (isNaN(headerBusinessUnitId) || headerBusinessUnitId <= 0)) {
      return res.status(400).json({ success: false, message: 'X-Company-Id must be a positive integer.', code: 'INVALID_COMPANY_HEADER' });
    }

    const requestedBusinessUnitId = req.query.business_unit_id ?? headerBusinessUnitId;
    // Exposed separately from req.companyIds so a Manager-tier caller's "no
    // filter selected" case can be told apart from "my own reachable BUs
    // happen to be this array" — see managerSelfServiceService.getMyEmployees's
    // doc comment for why that distinction matters (a mapped Employee in a
    // different Business Unit than the Manager must still show up by
    // default; the explicit selection is what narrows the list, not the
    // Manager's own BU membership).
    req.explicitBusinessUnitId = requestedBusinessUnitId == null ? null : requestedBusinessUnitId;
    req.companyIds = await companyAccessControlService.resolveReportCompanyScope(
      {
        hierarchyRank: req.hierarchyRank,
        employeeId: req.employeeId,
        employeeBusinessUnits: req.employeeBusinessUnits,
      },
      requestedBusinessUnitId == null ? null : requestedBusinessUnitId
    );
    return next();
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
    }
    return next(error);
  }
};

module.exports = resolveMyTeamBusinessUnitScope;
