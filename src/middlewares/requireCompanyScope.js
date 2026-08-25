'use strict';

/**
 * Guards a personal/self-service route that reads/writes via `req.companyId`
 * directly (never companyAccessControlService's owned-Company-array form).
 * Platform Admin/Admin/Entity Admin are company-less BY DESIGN —
 * resolveCompany.js (run at the tail of authenticate()) skips company
 * resolution for them entirely, so `req.companyId` stays `undefined`
 * unconditionally, even if that same Employee ALSO holds an operational
 * role like Employee/Manager. Without this guard, a company-less caller
 * hitting a route like this crashes several layers down with a raw
 * "WHERE parameter \"company_id\" has invalid \"undefined\" value" Sequelize
 * error (undefined is rejected, unlike an explicit null) instead of a
 * clean, actionable response — see employee-timesheets/* (Employee Self
 * Timesheet module), which is exactly this shape.
 *
 * Must run AFTER authenticate() (which sets req.companyId/req.hierarchyRank).
 */
const requireCompanyScope = (req, res, next) => {
  if (req.companyId == null) {
    return res.status(400).json({
      success: false,
      message: 'This action requires a Business Unit assignment, which your account does not have.',
      code: 'COMPANY_SCOPE_REQUIRED',
    });
  }
  return next();
};

module.exports = requireCompanyScope;
