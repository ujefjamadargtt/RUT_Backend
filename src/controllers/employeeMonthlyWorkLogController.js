'use strict';

const employeeMonthlyWorkLogService = require('../services/employeeMonthlyWorkLogService');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * Employee Monthly Work Log Controller.
 * Thin layer: parse request -> call service -> send response.
 * req.employeeId / req.companyId come from the employeeAuth middleware —
 * request bodies never supply employee_id. Mirrors
 * employeeTimesheetController.js's pattern for Daily.
 */

const handleServiceError = (err, res, next) => {
  if (err.statusCode === 403) return sendError(res, err.message, 403);
  if (err.statusCode === 409) return sendError(res, err.message, 409);
  if (err.statusCode === 400 || err.statusCode === 422) return sendError(res, err.message, err.statusCode);
  next(err);
};

/**
 * GET /api/v1/employee-timesheets/monthly
 */
const getMonthly = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const result = await employeeMonthlyWorkLogService.getMonthlyWorkLog(req.employeeId, req.companyId, month, year);
    return sendSuccess(res, result, 'Monthly work log fetched successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * POST /api/v1/employee-timesheets/monthly
 * PUT  /api/v1/employee-timesheets/monthly
 * Same handler for both — REPLACE SAVE / upsert semantics, so create and
 * update behave identically (see employeeMonthlyWorkLogService.submitMonthlyWorkLog).
 */
const submitMonthly = async (req, res, next) => {
  try {
    const result = await employeeMonthlyWorkLogService.submitMonthlyWorkLog(req.employeeId, req.companyId, req.body);
    return sendSuccess(res, result, 'Monthly work log saved successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * DELETE /api/v1/employee-timesheets/monthly
 */
const deleteMonthly = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    await employeeMonthlyWorkLogService.deleteMonthlyWorkLog(req.employeeId, req.companyId, month, year);
    return sendSuccess(res, null, 'Monthly work log deleted successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

module.exports = {
  getMonthly,
  submitMonthly,
  deleteMonthly,
};
