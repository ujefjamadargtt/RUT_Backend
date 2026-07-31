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
 * GET /api/v1/employees
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const getAll = async (req, res, next) => {
  try {
    const { data, meta } = await employeeService.getAll(req.query, req.companyId);
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
    const employee = await employeeService.getById(id, req.companyId);
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
 */
const create = async (req, res, next) => {
  try {
    const employee = await employeeService.create(req.body, req.userId, getIpAddress(req), req.companyId);
    return sendCreated(res, employee, 'Employee created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
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
 * PUT /api/v1/employees/:id/reset-password
 */
const resetPassword = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid employee ID.', 400);
    }
    await employeeService.resetPassword(id, req.body.password, req.userId, getIpAddress(req), req.companyId);
    return sendSuccess(res, null, 'Employee password reset successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Employee');
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

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteEmployee,
  getActiveEmployees,
  importEmployees,
  resetPassword,
};
