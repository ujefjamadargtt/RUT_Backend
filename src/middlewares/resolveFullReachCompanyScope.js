'use strict';

const companyAccessControlService = require('../services/companyAccessControlService');

/**
 * Company-scope resolution for READING ONE record by id (e.g. GET /timesheets/import/:id): the
 * caller's FULL role reach, deliberately ignoring X-Company-Id and ?company_id.
 *
 * A list screen (GET /timesheets/import/history) shows records from every Business Unit the caller
 * can reach; opening one of them by id must resolve against that SAME reach. Resolving it against
 * the single BU in the header (resolveCompany) made every record from another BU/Sub-BU 404 as
 * "not found", even though the row had just been listed.
 *
 * Authorization is unchanged in strength: the record is still only returned when its company is
 * inside the caller's own reach (Platform Admin: every Company; Admin/Entity Admin: their owned
 * Entities' Companies; a BU-scoped actor: their own mapped BUs and Sub-BUs). Never mount this on a
 * write route.
 *
 * Sets `req.companyIds` (always an array). Must run AFTER authenticateIdentity.
 */
const resolveFullReachCompanyScope = async (req, res, next) => {
  try {
    req.companyIds = await companyAccessControlService.resolveReportCompanyScope(
      { hierarchyRank: req.hierarchyRank, employeeId: req.employeeId, employeeBusinessUnits: req.employeeBusinessUnits },
      null
    );
    return next();
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
    }
    return next(err);
  }
};

module.exports = resolveFullReachCompanyScope;
