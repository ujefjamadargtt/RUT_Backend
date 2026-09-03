'use strict';

const complianceService = require('../services/employeeWorkLogComplianceService');
const { sendPaginated, sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Employee Work Log Compliance Controller
 *
 * Two handlers:
 *   getReport     — GET  /reports/employee-work-log-compliance
 *   sendReminder  — POST /reports/employee-work-log-compliance/remind
 *
 * Both handlers pull the auth context from req (set by authenticateIdentity)
 * and the company scope from req.companyIds (set by resolveReportCompanyScope).
 */

/**
 * Builds the standardised auth context object from the Express request.
 * Mirrors the identical pattern used by reportController.getEmployeeWorkLogHoursSummary.
 */
function buildAuthContext(req) {
  return {
    userId: req.userId,
    employeeId: req.employeeId,
    hierarchyRank: req.hierarchyRank,
    roleNames: req.userRoles || [],
  };
}

/**
 * GET /reports/employee-work-log-compliance
 *
 * Returns a paginated list of employees whose total logged hours for the
 * selected date or month are below the required threshold (< 8 for date,
 * < 160 for month).  Employees with zero work-log rows are included.
 *
 * Query params (validated by complianceReportQuerySchema):
 *   date | (month + year)  — period selector (exactly one required)
 *   company_id             — optional BU filter
 *   search                 — optional name / code search
 *   sortBy                 — employee_name | employee_code | total_hours | shortfall_hours
 *   sortOrder              — ASC | DESC
 *   page, limit            — pagination
 */
async function getReport(req, res, next) {
  try {
    const result = await complianceService.getReport(
      req.query,
      buildAuthContext(req),
      req.companyIds
    );

    return sendPaginated(
      res,
      { period: result.period, threshold: result.threshold, records: result.data },
      result.meta,
      'Employee work log compliance report fetched successfully.'
    );
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('getEmployeeWorkLogComplianceReport error', {
      error: err.message,
      stack: err.stack,
    });
    return next(err);
  }
}

/**
 * POST /reports/employee-work-log-compliance/remind
 *
 * Sends a work-log reminder email directly to the specified employee.
 * The backend:
 *   1. Validates the caller's authorisation over the employee.
 *   2. Re-calculates the employee's logged hours for the period.
 *   3. Rejects if the employee is already at/above the threshold.
 *   4. Resolves the employee email from the employee record (never from
 *      the request body).
 *   5. Sends the reminder.
 *
 * Body params (validated by complianceReminderBodySchema):
 *   employeeId             — target employee
 *   date | (month + year)  — same period the report was run for
 */
async function sendReminder(req, res, next) {
  try {
    const result = await complianceService.sendReminder(
      req.body,
      buildAuthContext(req),
      req.companyIds
    );

    return sendSuccess(res, result, 'Reminder sent successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('sendWorkLogComplianceReminder error', {
      error: err.message,
      stack: err.stack,
    });
    return next(err);
  }
}

/**
 * POST /reports/employee-work-log-compliance/remind-bulk
 *
 * Sends reminder emails to multiple employees in one request.
 * Two modes:
 *   remindAll = true  — remind every below-threshold employee in the caller's
 *                       authorised scope ("Remind All" / "Remind All Pages").
 *   employeeIds list  — remind only the explicitly selected employees
 *                       ("Remind Selected").
 *
 * Per-employee: hours are re-verified server-side; already-complete employees
 * and employees with no email are silently skipped (recorded in response).
 * Email failures never abort the rest of the batch.
 */
async function sendBulkReminder(req, res, next) {
  try {
    const result = await complianceService.sendBulkReminder(
      req.body,
      buildAuthContext(req),
      req.companyIds
    );
    return sendSuccess(res, result, result.message);
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('sendBulkWorkLogComplianceReminder error', {
      error: err.message,
      stack: err.stack,
    });
    return next(err);
  }
}

module.exports = {
  getReport,
  sendReminder,
  sendBulkReminder,
};
