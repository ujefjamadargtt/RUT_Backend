'use strict';

const employeeTimesheetService = require('../services/employeeTimesheetService');
const { sendSuccess, sendError, sendNotFound } = require('../utils/response');

/**
 * Employee Timesheet Controller (Employee Self Timesheet module)
 * Thin layer: parse request -> call service -> send response.
 * req.employeeId / req.companyId come from the employeeAuth middleware —
 * request bodies never supply employee_id.
 *
 * REDESIGN NOTE: despite the `/employee-timesheets` URL namespace (kept
 * stable so the frontend contract never changes), this module reads/writes
 * ONLY the `employee_work_logs` table (Stage 1 draft data) via
 * employeeTimesheetService.js / employeeWorkLogRepository.js — it NEVER
 * touches the official `timesheets` table. Entries only become part of
 * `timesheets` after an Admin runs "Sync Employee Work Logs"
 * (see timesheetController.syncEmployeeWorkLogs).
 */

const handleServiceError = (err, res, next) => {
  if (err.statusCode === 404) return sendNotFound(res, 'Timesheet entry');
  if (err.statusCode === 403) return sendError(res, err.message, 403);
  if (err.statusCode === 409) return sendError(res, err.message, 409);
  if (err.statusCode === 400 || err.statusCode === 422) return sendError(res, err.message, err.statusCode);
  next(err);
};

/**
 * GET /api/v1/employee-timesheets/calendar
 */
const getCalendar = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const days = await employeeTimesheetService.getCalendarSummary(req.employeeId, month, year, req.companyId);
    return sendSuccess(res, days, 'Calendar summary fetched successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * GET /api/v1/employee-timesheets/daily
 * Returns { date, service_pos } — same Service PO -> Parent -> Child
 * hierarchy shape as one entry of monthly-summary's array.
 */
const getDaily = async (req, res, next) => {
  try {
    const { date } = req.query;
    const entries = await employeeTimesheetService.getDailyEntries(req.employeeId, date, req.companyId);
    return sendSuccess(res, entries, 'Daily entries fetched successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * GET /api/v1/employee-timesheets/monthly-summary
 */
const getMonthlySummary = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const summary = await employeeTimesheetService.getMonthlySummary(req.employeeId, month, year, req.companyId);
    return sendSuccess(res, summary, 'Monthly summary fetched successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * GET /api/v1/employee-timesheets/projects
 */
const getProjects = async (req, res, next) => {
  try {
    const projects = await employeeTimesheetService.getMappedProjects(req.employeeId, req.companyId);
    return sendSuccess(res, projects, 'Mapped projects fetched successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/employee-timesheets/entries
 * REPLACE SAVE: body is { timesheet_date, entries: [...] } — the employee's
 * COMPLETE set of entries for that date. Every existing entry for the date
 * is deleted and replaced with exactly this list, in one transaction —
 * never a duplicate-entry error for this endpoint.
 */
const createEntry = async (req, res, next) => {
  try {
    const entries = await employeeTimesheetService.replaceDailyEntries(req.employeeId, req.companyId, req.body);
    return sendSuccess(res, entries, 'Timesheet entries saved successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * PUT /api/v1/employee-timesheets/entries/:id
 */
const updateEntry = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid timesheet entry ID.', 400);
    }
    const entry = await employeeTimesheetService.updateEntry(req.employeeId, req.companyId, id, req.body);
    return sendSuccess(res, entry, 'Timesheet entry updated successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * DELETE /api/v1/employee-timesheets/entries/:id
 */
const deleteEntry = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid timesheet entry ID.', 400);
    }
    await employeeTimesheetService.deleteEntry(req.employeeId, req.companyId, id);
    return sendSuccess(res, null, 'Timesheet entry deleted successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

module.exports = {
  getCalendar,
  getDaily,
  getMonthlySummary,
  getProjects,
  createEntry,
  updateEntry,
  deleteEntry,
};
