'use strict';

const managerSelfServiceService = require('../services/managerSelfServiceService');
const { sendSuccess, sendCreated, sendNoContent, sendNotFound, sendPaginated, sendError } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Manager Self-Service Controller — a Manager's own "My Employees" +
 * Service PO assignment screen.
 */

const getMyEmployees = async (req, res) => {
  try {
    const employees = await managerSelfServiceService.getMyEmployees(req.userId, req.companyId);
    return sendSuccess(res, employees, 'My Employees fetched successfully.');
  } catch (error) {
    logger.error('getMyEmployees error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getMyServicePOs = async (req, res) => {
  try {
    const pos = await managerSelfServiceService.getMyGrantedServicePOs(req.userId, req.companyId);
    return sendSuccess(res, pos, 'My granted Service POs fetched successfully.');
  } catch (error) {
    logger.error('getMyServicePOs error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getTimesheets = async (req, res) => {
  try {
    const employeeId = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;
    if (req.query.employee_id && isNaN(employeeId)) {
      return sendError(res, 'Invalid employee_id.', 400);
    }

    const { data, meta } = await managerSelfServiceService.getTimesheets(
      req.userId,
      employeeId,
      req.employeeId,
      req.companyId,
      req.query
    );
    return sendPaginated(res, data, meta, 'Timesheets fetched successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    logger.error('getTimesheets error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const approveTimesheet = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendError(res, 'Invalid work log entry ID.', 400);

    const entry = await managerSelfServiceService.approveTimesheet(
      req.userId, id, req.companyId, req.userId, getIpAddress(req)
    );
    return sendSuccess(res, entry, 'Work log entry approved successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Work log entry');
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('approveTimesheet error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getApprovalSummary = async (req, res) => {
  try {
    const employeeId = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;
    if (req.query.employee_id && isNaN(employeeId)) {
      return sendError(res, 'Invalid employee_id.', 400);
    }

    const { data, meta } = await managerSelfServiceService.getApprovalSummary(
      req.userId,
      employeeId,
      req.employeeId,
      req.companyId,
      req.query
    );
    return sendPaginated(res, data, meta, 'Approval summary fetched successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    logger.error('getApprovalSummary error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const bulkApproveTimesheets = async (req, res) => {
  try {
    const result = await managerSelfServiceService.bulkApproveTimesheets(
      req.userId, req.body, req.companyId, req.userId, getIpAddress(req)
    );
    return sendSuccess(res, result, 'Timesheets approved successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Employee');
    logger.error('bulkApproveTimesheets error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const rejectWorkLogEntry = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendError(res, 'Invalid work log entry ID.', 400);

    const entry = await managerSelfServiceService.rejectWorkLogEntry(
      req.userId, id, req.body.remark, req.companyId, req.userId, getIpAddress(req)
    );
    return sendSuccess(res, entry, 'Work log entry rejected successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Work log entry');
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('rejectWorkLogEntry error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getEmployeeServicePOs = async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) return sendError(res, 'Invalid Employee ID.', 400);

    const mappings = await managerSelfServiceService.getEmployeeServicePOs(req.userId, employeeId, req.companyId);
    return sendSuccess(res, mappings, 'Employee Service POs fetched successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    logger.error('getEmployeeServicePOs error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const assignServicePO = async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) return sendError(res, 'Invalid Employee ID.', 400);

    const mapping = await managerSelfServiceService.assignServicePOToEmployee(
      req.userId, employeeId, req.body.service_po_id, req.companyId, req.userId
    );
    return sendCreated(res, mapping, 'Service PO assigned successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Employee or Service PO');
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('assignServicePO error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const removeServicePO = async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    const servicePOId = parseInt(req.params.servicePOId, 10);
    if (isNaN(employeeId) || isNaN(servicePOId)) return sendError(res, 'Invalid ID.', 400);

    await managerSelfServiceService.removeServicePOFromEmployee(req.userId, employeeId, servicePOId, req.companyId);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Mapping');
    logger.error('removeServicePO error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const mapEmployee = async (req, res) => {
  try {
    const mapping = await managerSelfServiceService.mapEmployeeToSelf(
      req.userId, req.body.employee_id, req.companyId, req.userId
    );
    return sendCreated(res, mapping, 'Employee mapped successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Employee');
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('mapEmployee error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const unmapEmployee = async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) return sendError(res, 'Invalid Employee ID.', 400);

    await managerSelfServiceService.unmapEmployeeFromSelf(req.userId, employeeId, req.companyId);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Mapping');
    logger.error('unmapEmployee error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getMyEmployees,
  getMyServicePOs,
  getEmployeeServicePOs,
  getTimesheets,
  approveTimesheet,
  getApprovalSummary,
  bulkApproveTimesheets,
  rejectWorkLogEntry,
  assignServicePO,
  removeServicePO,
  mapEmployee,
  unmapEmployee,
};
