'use strict';

const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Admin Service — Platform Admin's user-creation and "View Admins" module
 * (per the RBAC spec: "Platform Admin should NOT directly create Entity
 * Admin or BU Admin"). Creates a bare User with role 'Admin' — no Company,
 * no Entity: company_id is NULL (Admin is platform-wide, like Platform
 * Admin — see resolveCompany.js). The new Admin then creates Entity
 * Admins/BU Admins itself via entityAdmin.routes.js / entityBuAdmin.routes.js
 * (requireEntityAdminOrAdmin.js).
 *
 * getAll/getById are scoped to the Admins THIS Platform Admin created
 * (users.created_by) — same isolation principle as entityAdminService.js's
 * "View Entity Admins" module, so one Platform Admin account can never see
 * Admins created by a different Platform Admin account.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

async function resolveAdminRoleId() {
  const role = await roleRepository.findByName('Admin');
  if (!role) {
    fail('The "Admin" role is not seeded.', 500);
  }
  return role.id;
}

/**
 * @param {object} data - { email, password }
 * @param {number} actorId - the Platform Admin creating this user
 * @param {string} ipAddress
 * @returns {Promise<object>} the created user's public summary
 */
const createAdmin = async (data, actorId, ipAddress = null) => {
  const { email, password } = data;

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) {
    fail(`A user with email "${email}" already exists.`, 409);
  }

  const adminRole = await roleRepository.findByName('Admin');
  if (!adminRole) {
    fail('The "Admin" role is not seeded.', 500);
  }

  const user = await userRepository.create({
    email,
    password,
    role_id: adminRole.id,
    company_id: null,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  const summary = { id: user.id, email: user.email, role_id: user.role_id, company_id: user.company_id };

  await createAuditLog(actorId, 'CREATE', 'users', user.id, null, summary, ipAddress);

  logger.info('Admin created', { userId: user.id, actorId });

  return summary;
};

/**
 * @param {object} query - { page, limit, search, status, sort_by, sort_order }
 * @param {number} actorId - the calling Platform Admin (req.userId) — every
 *   result is scoped to Admins THIS Platform Admin created.
 * @returns {Promise<{ data, meta }>}
 */
const getAll = async (query = {}, actorId) => {
  const { page, limit, offset } = getPaginationParams(query);
  const adminRoleId = await resolveAdminRoleId();

  const { rows, count } = await userRepository.findByRole(
    adminRoleId,
    { search: query.search, status: query.status, createdBy: actorId },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const meta = getPaginationMeta(count, page, limit);
  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number} actorId - the calling Platform Admin — an Admin created
 *   by a DIFFERENT Platform Admin 404s here, the same branch as a
 *   genuinely missing id (never leak cross-Platform-Admin existence).
 * @returns {Promise<User>}
 */
const getById = async (id, actorId) => {
  const user = await userRepository.findById(id);
  const adminRoleId = await resolveAdminRoleId();

  if (!user || user.role_id !== adminRoleId || user.created_by !== actorId) {
    fail('Admin not found.', 404);
  }

  return user;
};

module.exports = {
  createAdmin,
  getAll,
  getById,
};
