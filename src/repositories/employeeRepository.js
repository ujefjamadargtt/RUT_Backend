'use strict';

const { Op } = require('sequelize');
const { Employee, ServicePOResource, ServicePO } = require('../models');

/**
 * Employee Repository
 * Raw database access — no business logic.
 */

/**
 * Fetch a paginated, filtered, sorted list of employees.
 *
 * @param {object} filters    - { search, status, designation }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort       - { sortBy, sortOrder }
 * @returns {Promise<{ rows: Employee[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, designation, companyId } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  // Defense-in-depth allowlist matching employeeValidation.js's sort_by enum
  // — the route already validates this, but the repository shouldn't trust
  // an unvalidated caller to interpolate a column name into ORDER BY.
  const allowedSortColumns = ['full_name', 'employee_code', 'date_of_joining', 'created_at', 'designation'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  const where = { is_deleted: false, company_id: companyId };

  // Status filter — omit clause entirely when 'all' is requested
  if (status && status !== 'all') {
    where.status = status;
  }

  // Designation filter
  if (designation) {
    where.designation = { [Op.iLike]: `%${designation}%` };
  }

  // Full-text search across full_name, employee_code, designation
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    where[Op.or] = [
      { full_name: { [Op.iLike]: term } },
      { employee_code: { [Op.iLike]: term } },
      { designation: { [Op.iLike]: term } },
      { email_id: { [Op.iLike]: term } },
    ];
  }

  return Employee.findAndCountAll({
    where,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Find a single employee by primary key.
 * @param {number} id
 * @returns {Promise<Employee|null>}
 */
const findById = async (id, companyId) => {
  return Employee.findOne({ where: { id, is_deleted: false, company_id: companyId } });
};

/**
 * Find a single employee by employee_code, scoped to one company
 * (uniqueness is per-company — see uq_employees_company_code), regardless
 * of status or soft-delete state, so a code held by an inactive or deleted
 * employee in this company can never be reassigned.
 * @param {string} code
 * @param {number} companyId
 * @returns {Promise<Employee|null>}
 */
const findByCode = async (code, companyId) => {
  return Employee.findOne({ where: { employee_code: code, company_id: companyId } });
};

const findByEmail = async (email) => {
  return Employee.findOne({ where: { email_id: email.toLowerCase(), is_deleted: false } });
};

/**
 * Insert a new employee record.
 * @param {object} data
 * @returns {Promise<Employee>}
 */
const create = async (data) => {
  return Employee.create(data);
};

/**
 * Update an existing employee by primary key.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<Employee>}
 */
const update = async (id, data, companyId) => {
  const employee = await Employee.findOne({ where: { id, company_id: companyId } });
  if (!employee) return null;
  return employee.update(data);
};

/**
 * Soft-delete an employee by setting status to 'inactive'.
 * @param {number} id
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<Employee|null>}
 */
const softDelete = async (id, updatedBy, companyId) => {
  const employee = await Employee.findOne({ where: { id, is_deleted: false, company_id: companyId } });
  if (!employee) return null;
  return employee.update({ status: 'inactive', is_deleted: true, updated_by: updatedBy });
};

/**
 * Return all employees with status = 'active', ordered by full_name.
 * @param {number} companyId
 * @returns {Promise<Employee[]>}
 */
const getActiveEmployees = async (companyId) => {
  return Employee.findAll({
    where: { status: 'active', is_deleted: false, company_id: companyId },
    order: [['full_name', 'ASC']],
    attributes: [
      'id',
      'employee_code',
      'full_name',
      'designation',
      'total_experience',
      'company_experience',
      'status',
    ],
  });
};

/**
 * Return employees whose IDs are in the provided array.
 * Used for resource allocation checks.
 * @param {number[]} ids
 * @returns {Promise<Employee[]>}
 */
const findByIds = async (ids, companyId) => {
  if (!ids || ids.length === 0) return [];
  return Employee.findAll({
    where: { id: { [Op.in]: ids }, is_deleted: false, company_id: companyId },
    order: [['full_name', 'ASC']],
  });
};

/**
 * Check if an employee is allocated to any active Service PO.
 * Returns an array of active PO records that reference this employee.
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<ServicePOResource[]>}
 */
const findActiveAllocations = async (employeeId, companyId) => {
  return ServicePOResource.findAll({
    where: { employee_id: employeeId, company_id: companyId },
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        where: { status: 'active', company_id: companyId },
        attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
        required: true,
      },
    ],
  });
};

/**
 * Lightweight fetch of employees in one company (including inactive/
 * soft-deleted) for bulk import code-uniqueness validation, so a code held
 * by a deleted employee in this company is still flagged as taken rather
 * than silently reused. Email uniqueness is checked separately and stays
 * global — see findAllEmailsGlobal().
 * @param {number} companyId
 * @returns {Promise<{ employee_code: string, email_id: string|null }[]>}
 */
const findAllForImport = async (companyId) => {
  return Employee.findAll({
    where: { company_id: companyId },
    attributes: ['employee_code', 'email_id'],
    raw: true,
  });
};

/**
 * Fetch every non-null employee email across ALL companies — email_id
 * uniqueness is intentionally global, not per-company (tied to a person's
 * identity, unlike employee_code).
 * @returns {Promise<{ email_id: string }[]>}
 */
const findAllEmailsGlobal = async () => {
  return Employee.findAll({
    where: { email_id: { [Op.ne]: null } },
    attributes: ['email_id'],
    raw: true,
  });
};

module.exports = {
  findAll,
  findById,
  findByCode,
  findByEmail,
  create,
  update,
  softDelete,
  getActiveEmployees,
  findByIds,
  findActiveAllocations,
  findAllForImport,
  findAllEmailsGlobal,
};
