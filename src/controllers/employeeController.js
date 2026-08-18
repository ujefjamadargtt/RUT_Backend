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
 * @param {import('express').Request} req
 * @returns {{ userId: number, employeeId: number|null, companyId: number|null, hierarchyRank: number|null, roleNames: string[] }}
 */
function buildEmployeeAuthContext(req) {
  return {
    userId: req.userId,
    employeeId: req.employeeId,
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    roleNames: req.userRoles || [],
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
    const { data, meta } = await employeeService.getAll(req.query, buildEmployeeAuthContext(req));
    return sendPaginated(res, data, meta, 'Employees fetched successfully.');
  } catch (err) {
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
    const result = await employeeService.create(req.body, req.userId, getIpAddress(req), req.companyId);
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
    const employee = await employeeService.update(id, req.body, req.userId, getIpAddress(req), req.companyId);
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
    const employee = await employeeService.delete(id, req.userId, getIpAddress(req), req.companyId);
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
 */
const getActiveEmployees = async (req, res, next) => {
  try {
    const employees = await employeeService.getActiveEmployees(req.companyId);
    return sendSuccess(res, employees, 'Active employees fetched successfully.');
  } catch (err) {
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
    const result = await employeeImportService.importEmployees(req.file.path, req.userId, req.companyId);
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
    const employees = await employeeService.getEligibleDeliveryHeads(req.companyId);
    return sendSuccess(res, employees, 'Eligible Delivery Head employees fetched successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteEmployee,
  getActiveEmployees,
  getEligibleDeliveryHeads,
  importEmployees,
};
