'use strict';

const employeeService = require('../services/employeeService');
const employeeImportService = require('../services/employeeImportService');
const {
  sendSuccess,
  sendCreated,
  sendPaginated,
  sendError,
  sendNotFound,
} = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');

/**
 * Employee Controller
 * Thin layer: parse request -> call service -> send response.
 */

/**
 * The object-level authorization context every Employee-record read needs
 * (see employeeAccessControlService.resolveEmployeeAccessWhere) — built
 * once, here, from server-verified req fields ONLY (populated by
 * authenticate/resolveCompany in auth.js). Never derived from the request
 * body/query/params: employee_id, company_id, role_id supplied by a client
 * must never influence what this caller is authorized to see.
 *
 * `employeeBusinessUnits` (this session's own actively mapped BUs, plain
 * ids) is included alongside `companyId` (the single CURRENTLY ACTIVE one,
 * from X-Company-Id/auto-resolution) specifically so a multi-BU BU Admin's
 * business_unit_ids assignment isn't wrongly limited to just today's active
 * BU — see employeeService.resolveBusinessUnitIds()'s caller.
 *
 * @param {import('express').Request} req
 * @returns {{ userId: number, employeeId: number|null, companyId: number|null, hierarchyRank: number|null, roleNames: string[], employeeBusinessUnits: number[] }}
 */
function buildEmployeeAuthContext(req) {
  return {
    userId: req.userId,
    employeeId: req.employeeId,
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    roleNames: req.userRoles || [],
    employeeBusinessUnits: (req.employeeBusinessUnits || []).map((bu) => bu.id),
  };
}

/**
 * GET /api/v1/employees
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const getAll = async (req, res, next) => {
  try {
    const headerBusinessUnitId = parseInt(req.headers['x-company-id'], 10);
    // The explicit query filter wins. Otherwise make X-Company-Id behave as
    // the selected BU filter as well as the request-scope selector.
    const queryBusinessUnitId = parseInt(req.query.business_unit_id, 10);
    const hasQueryBusinessUnitId = Number.isInteger(queryBusinessUnitId) && queryBusinessUnitId > 0;
    const query = hasQueryBusinessUnitId || !Number.isInteger(headerBusinessUnitId) || headerBusinessUnitId <= 0
      ? req.query
      : { ...req.query, business_unit_id: headerBusinessUnitId };
    const { data, meta } = await employeeService.getAll(query, buildEmployeeAuthContext(req));
    return sendPaginated(res, data, meta, 'Employees fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    next(err);
  }
};

/**
 * GET /api/v1/employees/:id
 */
const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const employee = await employeeService.getByIdWithEmail(id, buildEmployeeAuthContext(req));
    return sendSuccess(res, employee, 'Employee fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
    }
    next(err);
  }
};

/**
 * GET /api/v1/employees/:id/mappings
 * Data source for the Action → Role & BU Mapping screen.
 */
const getMappings = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const mappings = await employeeService.getMappings(id, buildEmployeeAuthContext(req));
    return sendSuccess(res, mappings, 'Employee role/BU mappings fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
    }
    next(err);
  }
};

/**
 * GET /api/v1/employees/:id/business-units
 * Dedicated "Mapped BUs" data source — frontend sends the employee's id
 * here (e.g. right after login) rather than reading it off the login
 * response, which no longer carries Business Unit data.
 */
const getBusinessUnits = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const result = await employeeService.getBusinessUnits(id, buildEmployeeAuthContext(req));
    return sendSuccess(res, result, 'Employee business units fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
    }
    next(err);
  }
};

/**
 * POST /api/v1/employees
 *
 * Creates the Employee, its linked User (login) account, and the mandatory
 * Primary Manager mapping (plus optional Secondary) in one transaction —
 * see employeeService.create(). Response includes `temporaryPassword`
 * exactly once, ONLY when the caller omitted `password` (server-generated,
 * never retrievable again after this response).
 */
const create = async (req, res, next) => {
  try {
    const result = await employeeService.create(req.body, req.userId, getIpAddress(req), buildEmployeeAuthContext(req));
    return sendCreated(res, result, 'Employee created successfully.');
  } catch (err) {
    if (err.statusCode === 409 || err.statusCode === 400 || err.statusCode === 404) {
      return sendError(res, err.message, err.statusCode);
    }
    next(err);
  }
};

/**
 * PUT /api/v1/employees/:id
 */
const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const employee = await employeeService.update(id, req.body, req.userId, getIpAddress(req), buildEmployeeAuthContext(req));
    return sendSuccess(res, employee, 'Employee updated successfully.');
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 409 || err.statusCode === 400) {
      return sendError(res, err.message, err.statusCode);
    }
    next(err);
  }
};

/**
 * DELETE /api/v1/employees/:id
 */
const deleteEmployee = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    const employee = await employeeService.delete(id, req.userId, getIpAddress(req), buildEmployeeAuthContext(req));
    return sendSuccess(res, employee, 'Employee deactivated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
    }
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    next(err);
  }
};

/**
 * GET /api/v1/employees/active/list
 *
 * `?service_po_id=` (optional) switches this into the Service PO -> Map
 * Employees screen's data source — see employeeService.getActiveEmployees()'s
 * doc comment. Omitted entirely, behavior is unchanged from before.
 */
const getActiveEmployees = async (req, res, next) => {
  try {
    const parsedServicePOId = parseInt(req.query.service_po_id, 10);
    const servicePOId = Number.isInteger(parsedServicePOId) && parsedServicePOId > 0 ? parsedServicePOId : null;
    const parsedBusinessUnitId = parseInt(req.headers['x-company-id'], 10);
    const businessUnitId = Number.isInteger(parsedBusinessUnitId) && parsedBusinessUnitId > 0 ? parsedBusinessUnitId : null;

    const employees = await employeeService.getActiveEmployees(buildEmployeeAuthContext(req), servicePOId, businessUnitId);
    return sendSuccess(res, employees, 'Active employees fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    next(err);
  }
};

/**
 * POST /api/v1/employees/import
 * Upload an Excel/CSV file and bulk-import employees.
 * Valid rows are inserted; invalid rows are reported in error_rows.
 */
const importEmployees = async (req, res, next) => {
  try {
    const result = await employeeImportService.importEmployees(req.file.path, req.userId, req);
    const message = `Import complete. ${result.imported} employee(s) imported, ${result.skipped} skipped.`;
    return sendSuccess(res, result, message);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/employees/eligible-delivery-heads
 * Eligible candidates for Service PO Delivery Head selection — active,
 * non-deleted employees in the caller's own company.
 */
const getEligibleDeliveryHeads = async (req, res, next) => {
  try {
    const employees = await employeeService.getEligibleDeliveryHeads(buildEmployeeAuthContext(req));
    return sendSuccess(res, employees, 'Eligible Delivery Head employees fetched successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/employees/eligible-managers
 * Eligible candidates for Primary/Secondary Manager selection — active
 * employees in the caller's scope who hold a role capable of managing
 * Employees (same rule assertValidManager() enforces on save).
 */
const getEligibleManagers = async (req, res, next) => {
  try {
    const employees = await employeeService.getEligibleManagers(buildEmployeeAuthContext(req));
    return sendSuccess(res, employees, 'Eligible Manager employees fetched successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  getMappings,
  getBusinessUnits,
  create,
  update,
  delete: deleteEmployee,
  getActiveEmployees,
  getEligibleDeliveryHeads,
  getEligibleManagers,
  importEmployees,
};
