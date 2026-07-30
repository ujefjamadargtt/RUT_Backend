'use strict';

const employeeRepository = require('../repositories/employeeRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Employee Service
 * All business logic lives here; the repository handles only raw DB access.
 */

/**
 * Return a paginated, filtered, sorted employee list.
 *
 * @param {object} query - Express req.query (page, limit, search, status, designation, sort_by, sort_order)
 * @returns {Promise<{ data: Employee[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || '',
    status: query.status || 'active',
    designation: query.designation || '',
    companyId,
  };

  const sort = {
    sortBy: query.sort_by || 'created_at',
    sortOrder: query.sort_order || 'DESC',
  };

  const { rows, count } = await employeeRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * Return a single employee by ID.
 * Throws a 404-carrying error if not found.
 *
 * @param {number} id
 * @returns {Promise<Employee>}
 */
const getById = async (id, companyId) => {
  const employee = await employeeRepository.findById(id, companyId);
  if (!employee) {
    const err = new Error(`Employee with ID ${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return employee;
};

/**
 * Create a new employee.
 * Auto-generates employee_code if not provided.
 * Validates uniqueness of the code.
 *
 * @param {object} data       - Validated employee fields
 * @param {number} userId     - ID of the creating user (for audit)
 * @param {string} ipAddress  - Client IP
 * @returns {Promise<Employee>}
 */
const create = async (data, userId, ipAddress = null, companyId) => {
  // If a code is explicitly provided, ensure it is not already taken within
  // this company (uniqueness is per-company), regardless of
  // active/inactive/deleted status.
  if (data.employee_code) {
    const existing = await employeeRepository.findByCode(data.employee_code, companyId);
    if (existing) {
      const err = new Error(`Employee code "${data.employee_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Email uniqueness stays global (tied to the person's identity), not per-company.
  if (data.email_id) {
    const existing = await employeeRepository.findByEmail(data.email_id);
    if (existing) {
      const err = new Error(`Email "${data.email_id}" is already registered to another employee.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const payload = {
    ...data,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const employee = await employeeRepository.create(payload);

  await createAuditLog(
    userId,
    'CREATE',
    'employees',
    employee.id,
    null,
    employee.toJSON(),
    ipAddress
  );

  logger.info('Employee created', { employeeId: employee.id, code: employee.employee_code, userId });

  return employee;
};

/**
 * Update an existing employee.
 * Guards against duplicate employee_code changes.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Employee>}
 */
const update = async (id, data, userId, ipAddress = null, companyId) => {
  const existing = await getById(id, companyId); // throws 404 if not found

  // If the caller is changing the employee_code, ensure it is not taken by
  // any other employee in this company, regardless of active/inactive/
  // deleted status.
  if (data.employee_code && data.employee_code !== existing.employee_code) {
    const taken = await employeeRepository.findByCode(data.employee_code, companyId);
    if (taken && taken.id !== id) {
      const err = new Error(`Employee code "${data.employee_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Email uniqueness stays global, not per-company.
  if (data.email_id && data.email_id !== existing.email_id) {
    const taken = await employeeRepository.findByEmail(data.email_id);
    if (taken && taken.id !== id) {
      const err = new Error(`Email "${data.email_id}" is already registered to another employee.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const oldValues = existing.toJSON();

  const updated = await employeeRepository.update(id, {
    ...data,
    updated_by: userId,
  }, companyId);

  await createAuditLog(
    userId,
    'UPDATE',
    'employees',
    id,
    oldValues,
    updated.toJSON(),
    ipAddress
  );

  logger.info('Employee updated', { employeeId: id, userId });

  return updated;
};

/**
 * Soft-delete an employee.
 * Blocks deletion if the employee is allocated to any active Service PO.
 *
 * @param {number} id
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Employee>}
 */
const deleteEmployee = async (id, userId, ipAddress = null, companyId) => {
  const employee = await getById(id, companyId); // throws 404 if not found

  // Guard: do not deactivate an employee tied to an active PO
  const activeAllocations = await employeeRepository.findActiveAllocations(id, companyId);
  if (activeAllocations.length > 0) {
    const poNames = activeAllocations
      .map((r) => r.servicePO?.service_po_code || `PO#${r.service_po_id}`)
      .join(', ');
    const err = new Error(
      `Cannot deactivate employee. They are currently allocated to active Service PO(s): ${poNames}.`
    );
    err.statusCode = 409;
    throw err;
  }

  const oldValues = employee.toJSON();
  const deleted = await employeeRepository.softDelete(id, userId, companyId);

  await createAuditLog(
    userId,
    'DELETE',
    'employees',
    id,
    oldValues,
    deleted.toJSON(),
    ipAddress
  );

  logger.info('Employee soft-deleted', { employeeId: id, userId });

  return deleted;
};

/**
 * Return all active employees (lightweight list for dropdowns, allocation pickers).
 * @returns {Promise<Employee[]>}
 */
const getActiveEmployees = async (companyId) => {
  return employeeRepository.getActiveEmployees(companyId);
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteEmployee,
  getActiveEmployees,
};
