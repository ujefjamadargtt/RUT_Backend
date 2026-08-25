'use strict';

const { Op } = require('sequelize');
const { Role } = require('../models');
const employeeRoleRepository = require('./employeeRoleRepository');

/**
 * Role Repository
 * Raw database access only — no business logic.
 */

// Platform Admin (platform-only, provisions companies) is never shown in the
// regular Role Management / Role-Form-Mapping list (see findAll below).
// "BU Admin" (renamed from "Company Admin" — see
// database/migrations/20260807_rename_company_admin_to_bu_admin.sql) is
// deliberately NOT excluded: it must appear in this list so it can be
// selected on the Role-Form mapping screen like any other business role.
const EXCLUDED_ROLE_NAMES = ['Platform Admin'];

/**
 * Fetch all roles with optional search and status filter.
 *
 * @param {object} filters - { search, status }
 * @param {object} sort    - { sortBy, sortOrder }
 * @returns {Promise<Role[]>}
 */
const findAll = async (filters = {}, sort = {}) => {
  const { search, status } = filters;
  const { sortBy: requestedSortBy = 'role_name', sortOrder = 'ASC' } = sort;
  // Defense-in-depth allowlist matching roleValidation.js's sort_by enum —
  // the route already validates this, but the repository shouldn't trust
  // an unvalidated caller to interpolate a column name into ORDER BY.
  const allowedSortColumns = ['role_name', 'created_at'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'role_name';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'ASC';

  // Platform Admin (platform-only, provisions companies) is never returned
  // here — this list feeds role dropdowns/management screens, including the
  // Role-Form mapping screen's role picker, which BU Admin must appear in.
  const where = {
    is_deleted: false,
    role_name: { [Op.notIn]: EXCLUDED_ROLE_NAMES },
  };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where.role_name[Op.iLike] = `%${search.trim()}%`;
  }

  return Role.findAll({
    where,
    order: [[sortBy, safeSortOrder]],
  });
};

/**
 * Find a single role by primary key.
 * @param {number} id
 * @returns {Promise<Role|null>}
 */
const findById = async (id) => {
  return Role.findOne({ where: { id, is_deleted: false } });
};

/**
 * Find a role by its name (case-insensitive).
 * @param {string} name
 * @returns {Promise<Role|null>}
 */
const findByName = async (name) => {
  return Role.findOne({
    where: { role_name: { [Op.iLike]: name.trim() }, is_deleted: false },
  });
};

/**
 * Insert a new role.
 * @param {object} data
 * @returns {Promise<Role>}
 */
const create = async (data) => {
  return Role.create(data);
};

/**
 * Update an existing role by primary key.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<Role|null>}
 */
const update = async (id, data) => {
  const role = await Role.findByPk(id);
  if (!role) return null;
  return role.update(data);
};

/**
 * Count the number of employees actively holding a given role (both
 * roles.status and employee_roles.status must be 'active').
 * Used before deletion to guard against orphaned employees.
 * @param {number} roleId
 * @returns {Promise<number>}
 */
const countUsersByRole = async (roleId) => {
  const { EmployeeRole } = require('../models');
  return EmployeeRole.count({ where: { role_id: roleId, status: 'active' } });
};

/**
 * Check whether a role currently has ANY employee assigned to it
 * (employee_roles — the sole source of an employee's roles now, no
 * primary/additional split — see database/migrations/
 * 20260865_create_employee_roles.sql), regardless of grant status.
 * Used as the hard-delete guard in roleService.delete(): a role with even
 * one inactive grant still pointing at it must not be deleted.
 * employee_roles.role_id has ON DELETE CASCADE, so without this check,
 * deleting a role would silently drop that grant with no guard and no
 * audit trail.
 * @param {number} roleId
 * @returns {Promise<boolean>}
 */
const hasAssignedUsers = async (roleId) => {
  const count = await employeeRoleRepository.countByRoleId(roleId);
  return count > 0;
};

/**
 * Permanently delete a role row (hard delete). Only ever called from
 * roleService.delete(), after hasAssignedUsers() has confirmed the role is
 * unused, and always inside the same transaction that clears its
 * role_form_mapping rows first.
 * @param {number} id
 * @param {object} transaction
 * @returns {Promise<number>} number of rows deleted (0 or 1)
 */
const hardDelete = async (id, transaction) => {
  return Role.destroy({ where: { id }, transaction });
};

module.exports = {
  findAll,
  findById,
  findByName,
  create,
  update,
  countUsersByRole,
  hasAssignedUsers,
  hardDelete,
};
