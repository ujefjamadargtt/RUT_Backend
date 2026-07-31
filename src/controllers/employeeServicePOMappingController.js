'use strict';

const employeeServicePOMappingService = require('../services/employeeServicePOMappingService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');

/**
 * Employee Service PO Mapping Controller
 * Thin layer: parse request -> call service -> send response.
 */

/**
 * POST /api/v1/employee-servicepo-mapping
 */
const assign = async (req, res, next) => {
  try {
    const mapping = await employeeServicePOMappingService.assign(
      req.body.employee_id,
      req.body.service_po_id,
      req.userId,
      req.companyId
    );
    return sendCreated(res, mapping, 'Service PO assigned to employee successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee or Service PO');
    }
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    next(err);
  }
};

/**
 * DELETE /api/v1/employee-servicepo-mapping/:id
 */
const removeMapping = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid mapping ID.', 400);
    }
    await employeeServicePOMappingService.removeMapping(id, req.companyId);
    return sendSuccess(res, null, 'Mapping removed successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Mapping');
    }
    next(err);
  }
};

/**
 * PUT /api/v1/employee-servicepo-mapping/:id/activate
 */
const activateMapping = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid mapping ID.', 400);
    }
    const mapping = await employeeServicePOMappingService.activateMapping(id, req.userId, req.companyId);
    return sendSuccess(res, mapping, 'Mapping activated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Mapping');
    }
    next(err);
  }
};

/**
 * PUT /api/v1/employee-servicepo-mapping/:id/deactivate
 */
const deactivateMapping = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid mapping ID.', 400);
    }
    const mapping = await employeeServicePOMappingService.deactivateMapping(id, req.userId, req.companyId);
    return sendSuccess(res, mapping, 'Mapping deactivated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Mapping');
    }
    next(err);
  }
};

/**
 * GET /api/v1/employee-servicepo-mapping/employee/:employeeId
 */
const getEmployeeMappings = async (req, res, next) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const mappings = await employeeServicePOMappingService.getEmployeeMappings(
      employeeId,
      req.companyId,
      req.query.status
    );
    return sendSuccess(res, mappings, 'Employee Service PO mappings fetched successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/employee-servicepo-mapping/service-po/:servicePOId
 */
const getServicePOEmployees = async (req, res, next) => {
  try {
    const servicePOId = parseInt(req.params.servicePOId, 10);
    if (isNaN(servicePOId)) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }
    const mappings = await employeeServicePOMappingService.getServicePOEmployees(
      servicePOId,
      req.companyId,
      req.query.status
    );
    return sendSuccess(res, mappings, 'Service PO employee mappings fetched successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  assign,
  removeMapping,
  activateMapping,
  deactivateMapping,
  getEmployeeMappings,
  getServicePOEmployees,
};
