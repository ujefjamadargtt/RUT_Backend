'use strict';

const companyAccessControlService = require('../services/companyAccessControlService');

/**
 * Company-scope resolution for the `/reports/*`, `/management-reports/*`,
 * and BU-scoped list (`/clients`, `/projects`, `/service-pos`,
 * `/service-categories`, `/service-types`, `/sub-projects`) endpoints
 * converted to the "role reach, not nothing" convention (see
 * companyAccessControlService.resolveReportCompanyScope()'s doc comment) —
 * NOT mounted on bu-performance-scorecard, which already has its own
 * separate multi-BU mechanism via req.entityIds.
 *
 * This middleware NEVER rejects any actor purely for omitting
 * X-Company-Id — every rank falls back to its own full reach instead:
 * Platform Admin -> every Company on the platform; Admin/Entity Admin ->
 * every Company under their own owned Entities; a BU-scoped actor (BU Head/
 * BU Admin and below, rank >= 4) -> every Business Unit THEY are mapped to
 * (req.employeeBusinessUnits) — never a single arbitrarily-picked one, and
 * never every BU on the platform. A BU-scoped actor with zero active BU
 * mappings still gets 403 NO_BUSINESS_UNIT, same as before.
 *
 * Deliberately mounted AFTER authenticateIdentity (identity/role resolution
 * only), NOT the full authenticate() default export — resolveCompany.js
 * (authenticate()'s tail) 400s a multi-BU actor who omits the header before
 * this middleware would ever get a chance to run, which is exactly the
 * rejection this middleware exists to remove. req.companyId is therefore
 * never set on routes using this middleware; every route on this contract
 * must read req.companyIds (array) only.
 *
 * Also accepts an optional `company_id` query param as an alternative to
 * the `X-Company-Id` header, with the SAME entitlement check — a new
 * capability specific to these endpoints. The query param wins if both are
 * supplied.
 *
 * Sets `req.companyIds` (always an array, never undefined) for the
 * repository layer to scope with `IN (:companyIds)`.
 *
 * Must run AFTER authenticateIdentity (after req.hierarchyRank/req.employeeId/
 * req.employeeBusinessUnits are set) — never after the full authenticate().
 */
const resolveReportCompanyScope = async (req, res, next) => {
  try {
    const rawHeader = req.headers['x-company-id'];
    const headerCompanyId = rawHeader ? parseInt(rawHeader, 10) : null;
    const rawQuery = req.query.company_id;
    const queryCompanyId = rawQuery ? parseInt(rawQuery, 10) : null;
    const requestedCompanyId = queryCompanyId != null && !isNaN(queryCompanyId) ? queryCompanyId : headerCompanyId;

    req.companyIds = await companyAccessControlService.resolveReportCompanyScope(
      { hierarchyRank: req.hierarchyRank, employeeId: req.employeeId, employeeBusinessUnits: req.employeeBusinessUnits },
      requestedCompanyId != null && !isNaN(requestedCompanyId) ? requestedCompanyId : null
    );
    return next();
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
    }
    return next(err);
  }
};

module.exports = resolveReportCompanyScope;
