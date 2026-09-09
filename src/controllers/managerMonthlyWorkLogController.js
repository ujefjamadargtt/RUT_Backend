'use strict';

const managerMonthlyWorkLogService = require('../services/managerMonthlyWorkLogService');
const { sendSuccess, sendError } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Manager Monthly Work Log Controller — thin layer: parse request -> call
 * service -> send response. Mirrors employeeMonthlyWorkLogController.js's
 * pattern; employeeId always comes from the path (never trusted from the
 * body) and is re-validated against the caller's mapped Employees inside
 * managerMonthlyWorkLogService (via assertOwnEmployee).
 */

function callerBuIds(req) {
  return (req.employeeBusinessUnits || []).map((bu) => bu.id);
}

const handleServiceError = (req, res, next, err) => {
  if (err.statusCode === 403) return sendError(res, err.message, 403);
  if (err.statusCode === 404) return sendError(res, err.message, 404);
  if (err.statusCode === 409) return sendError(res, err.message, 409);
  if (err.statusCode === 400 || err.statusCode === 422) return sendError(res, err.message, err.statusCode);
  logger.error('Manager monthly work log error', { error: err.message, userId: req.userId });
  next(err);
};

/**
 * GET /my-team/employees/:employeeId/monthly-worklog
 */
const getMonthly = async (req, res, next) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) return sendError(res, 'Invalid Employee ID.', 400);

    const { month, year } = req.query;
    const result = await managerMonthlyWorkLogService.getMonthlyWorkLogForEmployee(
      req.userId, employeeId, req.companyId, month, year, req.hierarchyRank, callerBuIds(req)
    );
    return sendSuccess(res, result, 'Monthly work log fetched successfully.');
  } catch (err) {
    handleServiceError(req, res, next, err);
  }
};

/**
 * POST /my-team/employees/:employeeId/monthly-worklog
 * PUT  /my-team/employees/:employeeId/monthly-worklog
 * Same handler for both — REPLACE SAVE / upsert semantics (see
 * managerMonthlyWorkLogService.submitMonthlyWorkLogForEmployee).
 */
const submitMonthly = async (req, res, next) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) return sendError(res, 'Invalid Employee ID.', 400);

    const result = await managerMonthlyWorkLogService.submitMonthlyWorkLogForEmployee(
      req.userId, employeeId, req.companyId, req.body, req.userId, getIpAddress(req), req.hierarchyRank, callerBuIds(req)
    );
    return sendSuccess(res, result, 'Monthly work log saved and approved successfully.');
  } catch (err) {
    handleServiceError(req, res, next, err);
  }
};

/**
 * DELETE /my-team/employees/:employeeId/monthly-worklog
 */
const deleteMonthly = async (req, res, next) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) return sendError(res, 'Invalid Employee ID.', 400);

    const { month, year } = req.query;
    await managerMonthlyWorkLogService.deleteMonthlyWorkLogForEmployee(
      req.userId, employeeId, req.companyId, month, year, req.hierarchyRank, callerBuIds(req)
    );
    return sendSuccess(res, null, 'Monthly work log deleted successfully.');
  } catch (err) {
    handleServiceError(req, res, next, err);
  }
};

/**
 * POST /my-team/monthly-worklog/bulk-upload
 * multipart/form-data: file (.xlsx/.csv), month, year.
 * Not employee-scoped by path — the file itself names multiple Employees
 * (by Employee Code); each is re-validated server-side (see
 * managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog's two-gate doc
 * comment) rather than trusted from the sheet.
 */
const bulkUpload = async (req, res, next) => {
  try {
    const result = await managerMonthlyWorkLogService.bulkUploadMonthlyWorkLog(
      req.userId,
      req.companyId,
      req.file.path,
      { month: req.body.month, year: req.body.year },
      req.userId,
      getIpAddress(req),
      req.hierarchyRank,
      callerBuIds(req)
    );
    const message = `Upload complete. ${result.employees_processed} employee(s) updated, ${result.total_rows} entries saved and approved.`;
    return sendSuccess(res, result, message);
  } catch (err) {
    if (err.statusCode === 422 && err.details) {
      return res.status(422).json({
        success: false,
        message: err.message,
        phase: err.details.phase,
        errors: err.details.error_rows,
      });
    }
    handleServiceError(req, res, next, err);
  }
};

module.exports = {
  getMonthly,
  submitMonthly,
  deleteMonthly,
  bulkUpload,
};
