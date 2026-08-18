'use strict';

const { Op } = require('sequelize');
const { Employee, ServicePOResource, ServicePO, User } = require('../models');

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
  const { search, status, designation, companyId, accessWhere } = filters;
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

  // accessWhere (employeeAccessControlService.resolveEmployeeAccessWhere) is
  // the authoritative object-level scope when supplied — it already decides
  // company_id (or an explicit id-in-scope list) per the caller's role, so
  // it takes precedence over the raw companyId fallback other, non-scoped
  // callers of this same filters shape still rely on.
  const where = accessWhere
    ? { is_deleted: false, ...accessWhere }
    : { is_deleted: false, company_id: companyId };

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
    ];
  }

  return Employee.findAndCountAll({
    where,
    include: [
      {
        model: User,
        as: 'users',
        attributes: ['email'],
        required: false,
      },
    ],
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
 * Find a single employee by primary key, including their linked User's
 * email — a separate function from findById() (which has 9 other call
 * sites across validation/service code that don't need this extra join)
 * so that GET/PUT /employees/:id can flatten `email` onto the response the
 * same way GET /employees already does, without adding an unnecessary
 * include everywhere else findById() is used.
 *
 * `accessWhere` (employeeAccessControlService.resolveEmployeeAccessWhere)
 * is merged directly into the WHERE clause of THIS SAME query, not checked
 * afterward — an Employee outside the caller's authorized scope and an
 * Employee that plain doesn't exist both simply fail to match a row here,
 * so GET /employees/:id returns the identical 404 either way and never
 * discloses which case it was. When omitted, falls back to a bare
 * companyId filter for callers that don't need per-object scoping.
 *
 * @param {number} id
 * @param {number} companyId
 * @param {object} [accessWhere] - caller's authorized-scope WHERE fragment
 * @returns {Promise<Employee|null>}
 */
const findByIdWithEmail = async (id, companyId, accessWhere = null) => {
  // Op.and, not object spread: accessWhere may itself carry an `id` key
  // (the Manager/Service PO Admin/Employee scope is an id-in-list filter) —
  // spreading it after `{ id }` would silently overwrite the requested id
  // with the scope's list instead of ANDing the two together.
  return Employee.findOne({
    where: accessWhere
      ? { [Op.and]: [{ id, is_deleted: false }, accessWhere] }
      : { id, is_deleted: false, company_id: companyId },
    include: [
      {
        model: User,
        as: 'users',
        attributes: ['email'],
        required: false,
      },
    ],
  });
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

/**
 * Insert a new employee record.
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<Employee>}
 */
const create = async (data, options = {}) => {
  return Employee.create(data, options);
};

/**
 * Update an existing employee by primary key.
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<Employee>}
 */
const update = async (id, data, companyId, options = {}) => {
  const employee = await Employee.findOne({ where: { id, company_id: companyId }, transaction: options.transaction });
  if (!employee) return null;
  return employee.update(data, options);
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
 * Return every active, non-deleted Employee in one Company — the eligible
 * candidate list for Service PO Delivery Head selection. Employee no
 * longer carries its own email (see database/migrations/
 * 20260842_employees_drop_login_columns.sql) — it's sourced here from the
 * Employee's linked User account (at most one, per the one-User-per-
 * Employee unique index) instead.
 *
 * @param {number} companyId
 * @returns {Promise<Employee[]>}
 */
const getEligibleDeliveryHeads = async (companyId) => {
  return Employee.findAll({
    where: { status: 'active', is_deleted: false, company_id: companyId },
    include: [
      {
        model: User,
        as: 'users',
        attributes: ['email'],
        required: false,
      },
    ],
    attributes: ['id', 'employee_code', 'full_name', 'status', 'company_id'],
    order: [['full_name', 'ASC']],
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
 * than silently reused.
 * @param {number} companyId
 * @returns {Promise<{ employee_code: string }[]>}
 */
const findAllForImport = async (companyId) => {
  return Employee.findAll({
    where: { company_id: companyId },
    attributes: ['employee_code'],
    raw: true,
  });
};

module.exports = {
  findAll,
  findById,
  findByIdWithEmail,
  findByCode,
  create,
  update,
  softDelete,
  getActiveEmployees,
  getEligibleDeliveryHeads,
  findByIds,
  findActiveAllocations,
  findAllForImport,
};
