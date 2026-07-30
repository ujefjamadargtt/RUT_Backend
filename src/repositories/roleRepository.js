'use strict';

const { Op } = require('sequelize');
const { Role, User, UserRole } = require('../models');

/**
 * Role Repository
 * Raw database access only — no business logic.
 */

// Platform-level roles from the multi-tenancy retrofit — never shown in the
// regular Role Management list (see findAll below).
const EXCLUDED_ROLE_NAMES = ['Platform Admin', 'Company Admin'];

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

  // Platform Admin (platform-only, provisions companies) and Company Admin
  // (auto-created alongside its company, never manually assignable) are
  // never returned here — this list feeds role dropdowns/management screens
  // for the 5 regular business roles only.
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
  return User.count({
    distinct: true,
    where: {
      status: 'active',
      [Op.or]: [
        { role_id: roleId },
        { '$userRoles.role_id$': roleId },
      ],
    },
    include: [
      {
        model: UserRole,
        as: 'userRoles',
        attributes: [],
        required: false,
      },
    ],
  });
};

/**
 * Check whether a role currently has ANY user assigned to it — via either
 * the legacy direct users.role_id column or the user_roles junction table —
 * regardless of the user's active/inactive status. Used as the hard-delete
 * guard in roleService.delete(): a role with even one inactive user still
 * pointing at it must not be deleted, since removing the row would either
 * orphan that reference or violate the user_roles FK.
 * @param {number} roleId
 * @returns {Promise<boolean>}
 */
const hasAssignedUsers = async (roleId) => {
  const directCount = await User.count({ where: { role_id: roleId } });
  if (directCount > 0) return true;

  const mappingCount = await UserRole.count({ where: { role_id: roleId } });
  return mappingCount > 0;
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
