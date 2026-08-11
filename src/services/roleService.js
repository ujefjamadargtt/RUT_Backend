'use strict';

const { sequelize } = require('../models');
const roleRepository = require('../repositories/roleRepository');
const rbacRepository = require('../repositories/rbacRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Role Service
 * All business logic for role management.
 */

/**
 * Return all roles with optional search and status filter.
 * @param {object} query - Express req.query (status, search, sort_by, sort_order)
 * @returns {Promise<Role[]>}
 */
const getAll = async (query = {}) => {
  const filters = {
    search: query.search || '',
    status: query.status || 'all',
  };

  const sort = {
    sortBy: query.sort_by || 'role_name',
    sortOrder: query.sort_order || 'ASC',
  };

  return roleRepository.findAll(filters, sort);
};

/**
 * Return a single role by ID.
 * Throws 404 if not found.
 * @param {number} id
 * @returns {Promise<Role>}
 */
const getById = async (id) => {
  const role = await roleRepository.findById(id);
  if (!role) {
    const err = new Error(`Role with ID ${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return role;
};

/**
 * Create a new role.
 * Validates uniqueness of role_name (case-insensitive).
 *
 * @param {object} data          - { role_name, status }
 * @param {number} userId        - ID of the creating user
 * @param {string} ipAddress     - Client IP
 * @returns {Promise<Role>}
 */
const create = async (data, userId, ipAddress = null) => {
  const existing = await roleRepository.findByName(data.role_name);
  if (existing) {
    const err = new Error(`Role name "${data.role_name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  const role = await roleRepository.create({
    ...data,
    created_by: userId,
    updated_by: userId,
  });

  await createAuditLog(
    userId,
    'CREATE',
    'roles',
    role.id,
    null,
    role.toJSON(),
    ipAddress
  );

  logger.info('Role created', { roleId: role.id, name: role.role_name, userId });

  return role;
};

/**
 * Update an existing role.
 * Guards against renaming to a name already taken by another role.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Role>}
 */
const update = async (id, data, userId, ipAddress = null) => {
  const existing = await getById(id); // throws 404

  if (data.role_name && data.role_name.toLowerCase() !== existing.role_name.toLowerCase()) {
    if (existing.is_system) {
      const err = new Error(`"${existing.role_name}" is a system role defined by the RBAC hierarchy and cannot be renamed.`);
      err.statusCode = 403;
      throw err;
    }

    const taken = await roleRepository.findByName(data.role_name);
    if (taken && taken.id !== id) {
      const err = new Error(`Role name "${data.role_name}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const oldValues = existing.toJSON();
  const updated = await roleRepository.update(id, { ...data, updated_by: userId });

  await createAuditLog(
    userId,
    'UPDATE',
    'roles',
    id,
    oldValues,
    updated.toJSON(),
    ipAddress
  );

  logger.info('Role updated', { roleId: id, userId });

  return updated;
};

/**
 * Permanently delete a role — hard delete, not the status/is_deleted
 * soft-delete used elsewhere in this service. Blocked entirely if the role
 * is assigned to any user (via either the legacy users.role_id column or
 * the user_roles junction table, active or inactive) — in that case neither
 * the role nor its role_form_mapping rows are touched. Otherwise, the
 * role's role_form_mapping rows and the role row itself are removed in a
 * single transaction: either both succeed, or neither does.
 *
 * @param {number} id
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<void>}
 */
const deleteRole = async (id, userId, ipAddress = null) => {
  const existing = await getById(id); // throws 404 'Role with ID {id} not found.'

  if (existing.is_system) {
    const err = new Error(`"${existing.role_name}" is a system role defined by the RBAC hierarchy and cannot be deleted.`);
    err.statusCode = 403;
    throw err;
  }

  const isAssigned = await roleRepository.hasAssignedUsers(id);
  if (isAssigned) {
    const err = new Error('Role is in use and cannot be deleted because it is assigned to one or more users.');
    err.statusCode = 409;
    throw err;
  }

  const oldValues = existing.toJSON();

  const t = await sequelize.transaction();
  try {
    await rbacRepository.deleteAllRoleFormMappingsForRole(id, t);
    await roleRepository.hardDelete(id, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(userId, 'DELETE', 'roles', id, oldValues, null, ipAddress);

  logger.info('Role deleted', { roleId: id, userId });
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteRole,
};
