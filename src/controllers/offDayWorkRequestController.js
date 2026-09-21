'use strict';

const offDayWorkRequestService = require('../services/offDayWorkRequestService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');

/**
 * Off-Day Approval Gate Controller — Employee side (Employee Self Timesheet
 * module). req.employeeId/req.companyId come from the employeeAuth
 * middleware, same as employeeTimesheetController.js.
 */

const handleServiceError = (err, res, next) => {
  if (err.statusCode === 404) return sendNotFound(res, 'Off-Day Work Request');
  if (err.statusCode === 403) return sendError(res, err.message, 403);
  if (err.statusCode === 409) return sendError(res, err.message, 409);
  if (err.statusCode === 400 || err.statusCode === 422) return sendError(res, err.message, err.statusCode);
  next(err);
};

/**
 * POST /api/v1/employee-timesheets/off-day-requests
 */
const createRequest = async (req, res, next) => {
  try {
    const request = await offDayWorkRequestService.createRequest(req.employeeId, req.companyId, req.body, req.employeeId);
    return sendCreated(res, request, 'Off-Day Work Request submitted successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * PUT /api/v1/employee-timesheets/off-day-requests/:id/resubmit
 */
const resubmitRequest = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const request = await offDayWorkRequestService.resubmitRequest(req.employeeId, id, req.body.reason);
    return sendSuccess(res, request, 'Off-Day Work Request resubmitted successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

/**
 * GET /api/v1/employee-timesheets/off-day-requests
 */
const listMyRequests = async (req, res, next) => {
  try {
    const requests = await offDayWorkRequestService.listMyRequests(req.employeeId, req.query);
    return sendSuccess(res, requests, 'Off-Day Work Requests fetched successfully.');
  } catch (err) {
    handleServiceError(err, res, next);
  }
};

module.exports = {
  createRequest,
  resubmitRequest,
  listMyRequests,
};
