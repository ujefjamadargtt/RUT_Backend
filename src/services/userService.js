'use strict';

const bcrypt = require('bcrypt');
const { sequelize } = require('../models');
const userRepository = require('../repositories/userRepository');
const employeeRepository = require('../repositories/employeeRepository');
const roleRepository = require('../repositories/roleRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 12;

/**
 * User Service
 * All business logic for user management.
 */

/**
 * Return a paginated, filtered list of users.
 * @param {object} query - Express req.query
 * @returns {Promise<{ data: User[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || '',
    status: query.status || 'all',
    role_id: query.role_id || null,
    companyId,
  };

  const sort = {
    sortBy: query.sort_by || 'created_at',
    sortOrder: query.sort_order || 'DESC',
  };

  const { rows, count } = await userRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * Return a single user by ID including employee and role data.
 * Throws 404 if not found.
 * @param {number} id
 * @returns {Promise<User>}
 */
const getById = async (id, companyId) => {
  const user = await userRepository.findById(id, companyId);
  if (!user) {
    const err = new Error(`User with ID ${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return user;
};

/**
 * Create a new portal user.
 * Validates: email uniqueness, role existence, employee existence (if provided).
 *
 * @param {object} data           - Validated user fields (email, password, role_id, employee_id, status)
 * @param {number} currentUserId  - ID of the creating user
 * @param {string} ipAddress      - Client IP
 * @returns {Promise<User>}
 */
const create = async (data, currentUserId, ipAddress = null, companyId) => {
  // Uniqueness check (email stays globally unique, not per-company)
  const existing = await userRepository.findByEmail(data.email);
  if (existing) {
    const err = new Error(`Email "${data.email}" is already registered.`);
    err.statusCode = 409;
    throw err;
  }

  // Resolve requested roles, preferring role_ids when supplied.
  const requestedRoleIds = Array.isArray(data.role_ids) && data.role_ids.length > 0
    ? data.role_ids
    : data.role_id
    ? [data.role_id]
    : [];

  if (requestedRoleIds.length === 0) {
    const err = new Error('At least one role must be provided.');
    err.statusCode = 400;
    throw err;
  }

  const roles = await Promise.all(
    requestedRoleIds.map(async (roleId) => {
      const role = await roleRepository.findById(roleId);
      if (!role) {
        const err = new Error(`Role with ID ${roleId} not found.`);
        err.statusCode = 404;
        throw err;
      }
      if (role.status !== 'active') {
        const err = new Error(`Role "${role.role_name}" is inactive and cannot be assigned.`);
        err.statusCode = 409;
        throw err;
      }
      return role;
    })
  );

  // Employee must exist, be active, AND belong to this company (if provided)
  // — findById is company-scoped, so an employee from another company
  // simply 404s, same as a genuinely missing id.
  if (data.employee_id) {
    const employee = await employeeRepository.findById(data.employee_id, companyId);
    if (!employee) {
      const err = new Error(`Employee with ID ${data.employee_id} not found.`);
      err.statusCode = 404;
      throw err;
    }
    if (employee.status !== 'active') {
      const err = new Error(`Employee "${employee.full_name}" is inactive.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Strip confirm_password — not a DB field
  const { confirm_password, role_id, role_ids, ...rest } = data;
  const primaryRoleId = requestedRoleIds[0] || null;

  let user;
  await sequelize.transaction(async (transaction) => {
    user = await userRepository.create({
      ...rest,
      role_id: primaryRoleId,
      company_id: companyId,
      created_by: currentUserId,
      updated_by: currentUserId,
    }, { transaction });

    if (requestedRoleIds.length > 0) {
      await user.setRoles(requestedRoleIds, { transaction });
    }
  });

  // Reload with associations for the response
  const userWithRelations = await userRepository.findById(user.id, companyId);

  await createAuditLog(
    currentUserId,
    'CREATE',
    'users',
    user.id,
    null,
    { id: user.id, email: user.email, role_id: user.role_id, status: user.status },
    ipAddress
  );

  logger.info('User created', { userId: user.id, email: user.email, createdBy: currentUserId });

  return userWithRelations;
};

/**
 * Update a user record.
 * Guards against email conflicts with other users.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} currentUserId
 * @param {string} ipAddress
 * @returns {Promise<User>}
 */
const update = async (id, data, currentUserId, ipAddress = null, companyId) => {
  const existing = await getById(id, companyId); // throws 404 if not found

  // Email uniqueness check (against other users)
  if (data.email && data.email !== existing.email) {
    const taken = await userRepository.findByEmail(data.email);
    if (taken && taken.id !== id) {
      const err = new Error(`Email "${data.email}" is already registered to another user.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Resolve requested roles, preferring role_ids when supplied.
  const requestedRoleIds = Array.isArray(data.role_ids) && data.role_ids.length > 0
    ? data.role_ids
    : data.role_id
    ? [data.role_id]
    : [];

  if (requestedRoleIds.length > 0) {
    await Promise.all(
      requestedRoleIds.map(async (roleId) => {
        const role = await roleRepository.findById(roleId);
        if (!role) {
          const err = new Error(`Role with ID ${roleId} not found.`);
          err.statusCode = 404;
          throw err;
        }
        if (role.status !== 'active') {
          const err = new Error(`Role "${role.role_name}" is inactive and cannot be assigned.`);
          err.statusCode = 409;
          throw err;
        }
      })
    );
  }

  // Validate new employee if changing — findById is company-scoped, so an
  // employee from another company simply 404s.
  if (data.employee_id !== undefined && data.employee_id !== existing.employee_id) {
    if (data.employee_id) {
      const employee = await employeeRepository.findById(data.employee_id, companyId);
      if (!employee) {
        const err = new Error(`Employee with ID ${data.employee_id} not found.`);
        err.statusCode = 404;
        throw err;
      }
    }
  }

  const oldValues = {
    id: existing.id,
    email: existing.email,
    role_id: existing.role_id,
    employee_id: existing.employee_id,
    status: existing.status,
  };

  const { role_ids, ...payloadWithoutRoleIds } = data;
  const updatePayload = { ...payloadWithoutRoleIds, updated_by: currentUserId };
  if (requestedRoleIds.length > 0) {
    updatePayload.role_id = requestedRoleIds[0];
  }

  let updated;
  await sequelize.transaction(async (transaction) => {
    updated = await userRepository.update(id, updatePayload, { transaction }, companyId);
    if (requestedRoleIds.length > 0) {
      await updated.setRoles(requestedRoleIds, { transaction });
    }
  });

  const updatedWithRelations = await userRepository.findById(id, companyId);

  await createAuditLog(
    currentUserId,
    'UPDATE',
    'users',
    id,
    oldValues,
    { id, email: updated.email, role_id: updated.role_id, status: updated.status },
    ipAddress
  );

  logger.info('User updated', { userId: id, updatedBy: currentUserId });

  return updatedWithRelations;
};

/**
 * Soft-delete a user (set status = inactive).
 * A user cannot delete their own account via this endpoint.
 *
 * @param {number} id
 * @param {number} currentUserId
 * @param {string} ipAddress
 * @returns {Promise<User>}
 */
const deleteUser = async (id, currentUserId, ipAddress = null, companyId) => {
  if (id === currentUserId) {
    const err = new Error('You cannot deactivate your own account.');
    err.statusCode = 403;
    throw err;
  }

  const existing = await getById(id, companyId); // throws 404 if not found
  const oldValues = { id: existing.id, email: existing.email, status: existing.status };

  const deleted = await userRepository.softDelete(id, currentUserId, companyId);

  await createAuditLog(
    currentUserId,
    'DELETE',
    'users',
    id,
    oldValues,
    { id, status: 'inactive' },
    ipAddress
  );

  logger.info('User soft-deleted', { userId: id, deletedBy: currentUserId });

  return deleted;
};

/**
 * Change the password for the authenticated user.
 * Verifies the old password before updating.
 *
 * @param {number} userId        - ID of the user changing their password
 * @param {string} oldPassword   - Current plain-text password
 * @param {string} newPassword   - New plain-text password
 * @param {string} ipAddress
 * @returns {Promise<void>}
 */
const changePassword = async (userId, oldPassword, newPassword, ipAddress = null, companyId) => {
  // Must load with password hash for comparison. companyId is optional here
  // (only enforced when the caller passes one) — a user changing their own
  // password already has req.userId trustworthy on its own; the check
  // matters for the HR/Management admin-override path in the controller.
  const { User } = require('../models');
  const where = { id: userId };
  if (companyId !== undefined) where.company_id = companyId;
  const user = await User.scope('withPassword').findOne({ where });

  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    throw err;
  }

  const isMatch = await bcrypt.compare(oldPassword, user.password);
  if (!isMatch) {
    const err = new Error('Current password is incorrect.');
    err.statusCode = 401;
    throw err;
  }

  if (oldPassword === newPassword) {
    const err = new Error('New password must be different from the current password.');
    err.statusCode = 400;
    throw err;
  }

  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  // Use raw update to bypass the model hook (we are already hashing here)
  await User.update(
    { password: hashed, updated_by: userId },
    { where, individualHooks: false }
  );

  await createAuditLog(
    userId,
    'CHANGE_PASSWORD',
    'users',
    userId,
    null,
    null,
    ipAddress
  );

  logger.info('Password changed', { userId });
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteUser,
  changePassword,
};
