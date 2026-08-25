'use strict';

const employeeServicePOMappingService = require('../services/employeeServicePOMappingService');
const companyAccessControlService = require('../services/companyAccessControlService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');

/**
 * Employee Service PO Mapping Controller
 * Thin layer: parse request -> call service -> send response.
 */

/**
 * Resolve the caller's company scope from server-verified req fields only
 * (never body/query) — a plain companyId for a BU-scoped actor, or the
 * resolved array of owned Company ids for a company-less Admin/Entity
 * Admin (companyAccessControlService.resolveActorCompanyScope). This is
 * the fix for the cross-tenant mapping IDOR: every handler below used to
 * pass raw `req.companyId` (undefined for Admin/Entity Admin) straight into
 * the service/repository layer.
 *
 * @param {import('express').Request} req
 * @returns {Promise<number|number[]>}
 */
function resolveScope(req) {
  return companyAccessControlService.resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });
}

/**
 * POST /api/v1/employee-servicepo-mapping
 */
const assign = async (req, res, next) => {
  try {
    const companyId = await resolveScope(req);
    const mapping = await employeeServicePOMappingService.assign(
      req.body.employee_id,
      req.body.service_po_id,
      req.userId,
      companyId
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
    await employeeServicePOMappingService.removeMapping(id, await resolveScope(req));
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
    const mapping = await employeeServicePOMappingService.activateMapping(id, req.userId, await resolveScope(req));
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
    const mapping = await employeeServicePOMappingService.deactivateMapping(id, req.userId, await resolveScope(req));
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
      await resolveScope(req),
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
    // Passes the full authContext (not a pre-resolved companyId) — the
    // service itself now checks authorization directly against the Service
    // PO (servicePORepository.findById), which is what correctly handles a
    // Centralised (BU-less) PO the caller created; see
    // employeeServicePOMappingService.getServicePOEmployees()'s doc comment.
    const mappings = await employeeServicePOMappingService.getServicePOEmployees(
      servicePOId,
      { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId },
      req.query.status
    );
    return sendSuccess(res, mappings, 'Service PO employee mappings fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    next(err);
  }
};

/**
 * GET /api/v1/employee-servicepo-mapping/employee/:employeeId/options
 *
 * Data source for the "Manage Service PO Mapping" screen launched from the
 * Employee Master action of the same name: every Service PO this Employee
 * is eligible to be mapped to, plus their currently mapped Service PO ids.
 * The role check (Service PO Admin / Delivery Head -> unrestricted
 * visibility) is resolved server-side inside the service — the frontend
 * never asserts the Employee's role itself.
 */
const getServicePOOptions = async (req, res, next) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const options = await employeeServicePOMappingService.getServicePOOptionsForEmployee(employeeId, {
      companyId: req.companyId,
      hierarchyRank: req.hierarchyRank,
      employeeId: req.employeeId,
    });
    return sendSuccess(res, options, 'Eligible Service PO options fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
    }
    next(err);
  }
};

/**
 * PUT /api/v1/employee-servicepo-mapping/employee/:employeeId
 *
 * Save action for the "Manage Service PO Mapping" screen — replaces this
 * Employee's mapping set to exactly `service_po_ids`.
 */
const saveMappings = async (req, res, next) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (isNaN(employeeId)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const mappings = await employeeServicePOMappingService.saveEmployeeServicePOMappings(
      employeeId,
      req.body.service_po_ids,
      req.userId,
      { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId }
    );
    return sendSuccess(res, mappings, 'Employee Service PO mappings saved successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
    }
    if (err.statusCode === 400) {
      return sendError(res, err.message, 400);
    }
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
  getServicePOOptions,
  saveMappings,
};
