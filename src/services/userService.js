'use strict';

const bcrypt = require('bcrypt');
const { sequelize } = require('../models');
const userRepository = require('../repositories/userRepository');
const employeeRepository = require('../repositories/employeeRepository');
const roleRepository = require('../repositories/roleRepository');
const userAdditionalRoleRepository = require('../repositories/userAdditionalRoleRepository');
const roleHierarchyService = require('./roleHierarchyService');
const { getCreatableRoleNames } = require('../config/roleHierarchy');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 12;

/**
 * User Service
 * All business logic for user management.
 */

/**
 * Enforce the ROLE_CREATION_MATRIX (src/config/roleHierarchy.js) — a HARD
 * business rule, not a generic permission: each tier may only create the
 * tier(s) directly below it (Platform Admin -> Admin only, never Entity
 * Admin/BU Admin directly; Service PO Admin -> Manager only; etc). A role
 * that isn't a matrix key (HR, Manager, Employee, or no role at all) has no
 * creation rights here — HR creates Employees through the dedicated
 * employeeService.create() flow instead, not this one.
 *
 * @param {string|null} actorRoleName - the calling user's single role name (req.userRoleName)
 * @param {{ role_name: string }[]} roles - the role(s) being assigned to the new/updated user
 */
function assertActorCanAssignRoles(actorRoleName, roles) {
  const creatableRoleNames = getCreatableRoleNames(actorRoleName);

  if (!creatableRoleNames) {
    const err = new Error(`Role "${actorRoleName || 'none'}" is not permitted to create or reassign user roles.`);
    err.statusCode = 403;
    throw err;
  }

  const disallowed = roles.find(
    (role) => !creatableRoleNames.some((r) => r.toLowerCase() === role.role_name.toLowerCase())
  );
  if (disallowed) {
    const err = new Error(
      `"${actorRoleName}" cannot assign role "${disallowed.role_name}". Allowed roles: ${creatableRoleNames.join(', ')}.`
    );
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Enforce that only the PRIMARY role (roles[0]) may be a senior/admin tier
 * (Platform Admin/Admin/Entity Admin/BU Admin). Every ADDITIONAL role
 * (roles[1:]) must be operational — reuses roleHierarchyService.isSeniorTier
 * (rank <= SENIOR_BYPASS_MAX_RANK) rather than a separate hardcoded name
 * list, so this stays correct automatically if that boundary ever changes.
 * See database/migrations/20260850_add_user_additional_roles.sql.
 *
 * @param {{ role_name: string, hierarchy_rank: number|null }[]} roles - in
 *   the same order as the requested role_ids; index 0 is the primary role.
 */
function assertAdditionalRolesAreOperational(roles) {
  const [, ...additional] = roles;
  const disallowed = additional.find((role) => roleHierarchyService.isSeniorTier(role));
  if (disallowed) {
    const err = new Error(
      `"${disallowed.role_name}" cannot be held as an additional role — only Project Admin, ` +
      'Service PO Admin, Manager, HR, or Employee may be assigned as additional roles.'
    );
    err.statusCode = 400;
    throw err;
  }
}

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
 * @param {number} companyId
 * @param {string|null} [actorRoleName] - req.userRoleName of the creating
 *   user — checked against ROLE_CREATION_MATRIX (src/config/roleHierarchy.js).
 *   Entity Admin's own dedicated companyService.createWithAdmin() flow is
 *   unaffected — it doesn't call through here.
 * @returns {Promise<User>}
 */
const create = async (data, currentUserId, ipAddress = null, companyId, actorRoleName = null) => {
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

  assertActorCanAssignRoles(actorRoleName, roles);
  assertAdditionalRolesAreOperational(roles);

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

  // requestedRoleIds[0] is the PRIMARY role -> users.role_id, the sole
  // source of truth for hierarchy rank / company scoping / the
  // role-creation matrix (unchanged). requestedRoleIds[1:] are ADDITIONAL
  // operational roles -> user_additional_roles, a purely additive
  // capability grant — see database/migrations/
  // 20260850_add_user_additional_roles.sql.
  let user;
  await sequelize.transaction(async (transaction) => {
    user = await userRepository.create({
      ...rest,
      role_id: primaryRoleId,
      // Explicit null, never undefined — Sequelize omits an undefined
      // attribute from the INSERT entirely, which lets a stray DB-level
      // column default silently apply instead (see database/migrations/
      // 20260847_drop_users_company_id_default.sql, where exactly this bit
      // an Admin actor — who legitimately has no company — creating a BU
      // Admin). Platform Admin/Admin callers pass no companyId at all.
      company_id: companyId ?? null,
      created_by: currentUserId,
      updated_by: currentUserId,
    }, { transaction });

    if (requestedRoleIds.length > 1) {
      await userAdditionalRoleRepository.replaceForUser(
        user.id,
        requestedRoleIds.slice(1),
        currentUserId,
        transaction
      );
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
 * Guards against email conflicts with other users. If the caller is
 * reassigning the user's role, the new role must be one the actor is
 * allowed to assign per ROLE_CREATION_MATRIX (src/config/roleHierarchy.js)
 * — same rule as create().
 *
 * @param {number} id
 * @param {object} data
 * @param {number} currentUserId
 * @param {string} ipAddress
 * @param {number} companyId
 * @param {string|null} [actorRoleName] - req.userRoleName of the updating user
 * @returns {Promise<User>}
 */
const update = async (id, data, currentUserId, ipAddress = null, companyId, actorRoleName = null) => {
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
    const requestedRoles = await Promise.all(
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

    assertActorCanAssignRoles(actorRoleName, requestedRoles);
    assertAdditionalRolesAreOperational(requestedRoles);
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

    // role_ids/role_id supplied at all -> caller is replacing the FULL role
    // set (primary + additional) together; omitting it leaves both
    // untouched, same as the primary role_id's existing behavior above.
    if (requestedRoleIds.length > 0) {
      await userAdditionalRoleRepository.replaceForUser(
        id,
        requestedRoleIds.slice(1),
        currentUserId,
        transaction
      );
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

/**
 * Admin-side password reset — sets a new password WITHOUT verifying the
 * old one, since the actor resetting it (HR, or a senior admin tier) has
 * no way to know it. Distinct from changePassword() above, which is the
 * self-service "I know my current password" flow. This is the
 * User-Master equivalent of the old (removed) PUT /employees/:id/reset-password
 * — every Employee now authenticates through a linked User, so resetting
 * their login credential is a User Master operation.
 *
 * Authorization (who may call this for someone ELSE's account) is
 * enforced at the controller/route level, not here — see
 * userController.resetPassword().
 *
 * @param {number} userId
 * @param {string} newPassword - plain-text, already Joi-validated for policy
 * @param {number} actorId
 * @param {string} ipAddress
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const resetPassword = async (userId, newPassword, actorId, ipAddress = null, companyId) => {
  const { User } = require('../models');
  const where = { id: userId };
  if (companyId !== undefined) where.company_id = companyId;
  const user = await User.findOne({ where });

  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    throw err;
  }

  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await User.update(
    { password: hashed, updated_by: actorId },
    { where, individualHooks: false }
  );

  await createAuditLog(actorId, 'RESET_PASSWORD', 'users', userId, null, null, ipAddress);

  logger.info('Password reset by admin', { userId, actorId });
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteUser,
  changePassword,
  resetPassword,
};
