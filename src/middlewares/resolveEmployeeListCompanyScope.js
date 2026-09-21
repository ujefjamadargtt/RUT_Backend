'use strict';

const resolveCompany = require('./resolveCompany');
const { isBuAdminPeerRole } = require('../services/employeeAccessControlService');

/**
 * Company-scope resolution for GET /employees (Employee Master list) ONLY.
 * Must run AFTER authenticateIdentity (req.hierarchyRank/req.employeeBusinessUnits/
 * req.userRoles already set) — mounted as `[authenticate.authenticateIdentity,
 * resolveEmployeeListCompanyScope]` on the route, same pattern as
 * authenticateReadMultiBU.js.
 *
 * resolveCompany.js (authenticate()'s tail) 400s COMPANY_HEADER_REQUIRED for
 * ANY BU-scoped caller mapped to more than one active Business Unit who
 * omits X-Company-Id — correct for endpoints where exactly one active BU is
 * mandatory (Timesheet Admin, Cost Budget, ...), but wrong here: Employee
 * Master's own contract (see employee.routes.js's GET / doc comment) is
 * "X-Company-Id is not read as a filter" — omitting it must fall back to
 * every Business Unit the caller's role can reach (same "role reach, not
 * nothing" convention resolveReportCompanyScope.js already gives Clients/
 * Projects/Service POs), not reject the request outright.
 *
 * This is the fix for a real bug report: a multi-BU BU Admin's Employee
 * Master screen (which never sends X-Company-Id, by design) returned
 * COMPANY_HEADER_REQUIRED instead of their employees — resolveCompany.js
 * rejected the request before employeeAccessControlService
 * .resolveEmployeeAccessWhere's own BU-tier branch (which already falls
 * back to the caller's full employeeBusinessUnits array via
 * employeeRepository.employeeScope) ever got a chance to run.
 *
 * Only the "company-wide" tier (BU Admin/Project Admin/any BU-Admin-peer
 * role — see resolveEmployeeAccessWhere's own branch) is relaxed here, and
 * only in the exact ">1 mapped BU, no header" case. Every other caller
 * (Admin/Entity Admin/Platform Admin, a single-BU actor, anyone who DID send
 * a header, and Team Lead/Project Manager/Employee — whose own accessWhere
 * branch is individually-mapped and genuinely needs one concrete companyId)
 * goes through the EXACT existing resolveCompany.js behavior, unchanged.
 */
const resolveEmployeeListCompanyScope = async (req, res, next) => {
  const isCompanyWideTier =
    req.hierarchyRank === 4 ||
    req.hierarchyRank === 5 ||
    isBuAdminPeerRole(req.hierarchyRank, req.userRoles || []);
  const businessUnits = req.employeeBusinessUnits || [];
  const rawHeader = req.headers['x-company-id'];

  if (isCompanyWideTier && businessUnits.length > 1 && !rawHeader) {
    // Leave req.companyId unset — employeeAccessControlService
    // .resolveEmployeeAccessWhere falls back to req.employeeBusinessUnits
    // (already populated by authenticateIdentity) for this tier.
    return next();
  }

  return resolveCompany(req, res, next);
};

module.exports = resolveEmployeeListCompanyScope;
