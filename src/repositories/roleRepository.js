'use strict';

const { Op } = require('sequelize');
const { Role, User } = require('../models');
const userAdditionalRoleRepository = require('./userAdditionalRoleRepository');

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
 * Count the number of active users assigned to a given role.
 * Used before deletion to guard against orphaned users.
 * @param {number} roleId
 * @returns {Promise<number>}
 */
const countUsersByRole = async (roleId) => {
  return User.count({ where: { status: 'active', role_id: roleId } });
};

/**
 * Check whether a role currently has ANY user assigned to it — either as
 * their PRIMARY role (users.role_id, the sole source of truth for
 * hierarchy/scoping — see database/migrations/20260840_collapse_user_roles.sql)
 * or as an ADDITIONAL operational role (user_additional_roles — see
 * database/migrations/20260850_add_user_additional_roles.sql) —
 * regardless of the user's active/inactive status. Used as the hard-delete
 * guard in roleService.delete(): a role with even one inactive user still
 * pointing at it (either way) must not be deleted. user_additional_roles.role_id
 * has ON DELETE CASCADE, so without this check, deleting a role only ever
 * held as someone's additional role would silently drop that grant with no
 * guard and no audit trail.
 * @param {number} roleId
 * @returns {Promise<boolean>}
 */
const hasAssignedUsers = async (roleId) => {
  const [directCount, additionalCount] = await Promise.all([
    User.count({ where: { role_id: roleId } }),
    userAdditionalRoleRepository.countByRoleId(roleId),
  ]);
  return directCount > 0 || additionalCount > 0;
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
