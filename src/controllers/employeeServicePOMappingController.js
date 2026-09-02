'use strict';

const employeeServicePOMappingService = require('../services/employeeServicePOMappingService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');

/**
 * Employee Service PO Mapping Controller
 * Thin layer: parse request -> call service -> send response.
 */

/**
 * Resolve the caller's authorized scope for an Employee-ServicePO mapping
 * write (assign/remove/activate/deactivate) from server-verified req fields
 * only (never body/query) — for Admin/Entity Admin (company-less), the
 * resolved array of owned Company ids (unchanged); for every BU-scoped rank
 * (BU Admin/Service PO Admin/Delivery Head/etc), the caller's OWNING ADMIN's
 * FULL multi-BU scope (employeeServicePOMappingService.
 * resolveEmployeeMappingScope) — NOT just the single currently-selected
 * X-Company-Id.
 *
 * This must match the scope getEmployeeOptionsForServicePO()/
 * getServicePOOptionsForEmployee() already expose on the "Map Employees" /
 * "Manage Service PO Mapping" screens (their own doc comments: a BU Admin
 * managing multiple Business Units under the same Admin sees Employees/
 * Service POs across ALL of them, not just whichever ONE happens to be the
 * active Global BU). Previously this used
 * companyAccessControlService.resolveActorCompanyScope(), which narrows a
 * BU-scoped actor to their single active req.companyId — so the moment such
 * a caller picked an Employee or Service PO from a DIFFERENT Business Unit
 * than their currently-selected one (exactly what the screen's own Entity/BU
 * filter invites them to do), assign() 404'd with "Employee or Service PO
 * not found" even though that same Employee/Service PO was legitimately
 * listed as eligible.
 *
 * @param {import('express').Request} req
 * @returns {Promise<number|number[]>}
 */
function resolveScope(req) {
  return employeeServicePOMappingService.resolveEmployeeMappingScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
    employeeBusinessUnits: (req.employeeBusinessUnits || []).map((bu) => bu.id),
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
    // employeeBusinessUnits is required here — this route runs
    // authenticateIdentity (not the full authenticate), so req.companyId is
    // never set; the service resolves scope from employeeBusinessUnits
    // instead, letting a multi-BU BU Admin/Service PO Admin/Delivery Head
    // open a PO in ANY of their managed BUs without an X-Company-Id header.
    const mappings = await employeeServicePOMappingService.getServicePOEmployees(
      servicePOId,
      {
        companyId: req.companyId,
        hierarchyRank: req.hierarchyRank,
        employeeId: req.employeeId,
        employeeBusinessUnits: (req.employeeBusinessUnits || []).map((bu) => bu.id),
      },
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

/**
 * GET /api/v1/employee-servicepo-mapping/service-po/:servicePOId/options
 *
 * Data source for the "Map Employees" screen launched from a Service PO:
 * every Employee within the caller's authorized Admin/company scope
 * (NEVER narrowed by Business Unit — see employeeServicePOMappingService.
 * getEmployeeOptionsForServicePO()'s doc comment), plus which of them are
 * already mapped to this Service PO. The caller's own role/authority is
 * resolved server-side (req.userRoles/req.hierarchyRank, from the verified
 * JWT) — the frontend never asserts it.
 */
const getServicePOEmployeeOptions = async (req, res, next) => {
  try {
    const servicePOId = parseInt(req.params.servicePOId, 10);
    if (isNaN(servicePOId)) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }
    const options = await employeeServicePOMappingService.getEmployeeOptionsForServicePO(
      servicePOId,
      {
        companyId: req.companyId,
        hierarchyRank: req.hierarchyRank,
        employeeId: req.employeeId,
        roleNames: req.userRoles,
        employeeBusinessUnits: (req.employeeBusinessUnits || []).map((bu) => bu.id),
      },
      req.query
    );
    return sendSuccess(res, options, 'Eligible Employee options fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    if (err.statusCode === 403) {
      return sendError(res, err.message, 403);
    }
    next(err);
  }
};

/**
 * GET /api/v1/employee-servicepo-mapping/filter-options
 *
 * Entity → Business Unit filter dropdown options for the "Map Employees"
 * screen (see employeeServicePOMappingService.getEmployeeMappingFilterOptions()'s
 * doc comment for why this can't just reuse GET /entities or GET /companies).
 * Not scoped to one Service PO — the caller's authorized scope is the same
 * across every Service PO they can open this screen for.
 */
const getMappingFilterOptions = async (req, res, next) => {
  try {
    const options = await employeeServicePOMappingService.getEmployeeMappingFilterOptions({
      companyId: req.companyId,
      hierarchyRank: req.hierarchyRank,
      employeeId: req.employeeId,
      roleNames: req.userRoles,
      employeeBusinessUnits: (req.employeeBusinessUnits || []).map((bu) => bu.id),
    });
    return sendSuccess(res, options, 'Filter options fetched successfully.');
  } catch (err) {
    if (err.statusCode === 403) {
      return sendError(res, err.message, 403);
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
  getServicePOEmployeeOptions,
  getMappingFilterOptions,
};
