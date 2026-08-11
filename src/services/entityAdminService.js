'use strict';

const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Entity Admin Service — Admin's "View Entity Admins" / "Manage Entity
 * Admins" module (create + list/view/edit/status). Entity Admin users have
 * no Company/Entity to scope by (company_id is always NULL — see
 * resolveCompany.js), so scoping instead uses users.created_by: an Admin
 * only ever sees the Entity Admins THEY created. This is the same
 * created_by column already written by createEntityAdmin() below — no new
 * ownership table needed.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

async function resolveEntityAdminRoleId() {
  const role = await roleRepository.findByName('Entity Admin');
  if (!role) {
    fail('The "Entity Admin" role is not seeded.', 500);
  }
  return role.id;
}

/**
 * @param {object} data - { email, password }
 * @param {number} actorId - the Admin creating this user
 * @param {string} ipAddress
 * @returns {Promise<object>} the created user's public summary
 */
const createEntityAdmin = async (data, actorId, ipAddress = null) => {
  const { email, password } = data;

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) {
    fail(`A user with email "${email}" already exists.`, 409);
  }

  const entityAdminRoleId = await resolveEntityAdminRoleId();

  const user = await userRepository.create({
    email,
    password,
    role_id: entityAdminRoleId,
    company_id: null,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  const summary = { id: user.id, email: user.email, role_id: user.role_id, company_id: user.company_id };

  await createAuditLog(actorId, 'CREATE', 'users', user.id, null, summary, ipAddress);

  logger.info('Entity Admin created', { userId: user.id, actorId });

  return summary;
};

/**
 * @param {object} query - { page, limit, search, status, sort_by, sort_order }
 * @param {number} actorId - the calling Admin (req.userId) — every result
 *   is scoped to Entity Admins THIS Admin created.
 * @returns {Promise<{ data, meta }>}
 */
const getAll = async (query = {}, actorId) => {
  const { page, limit, offset } = getPaginationParams(query);
  const entityAdminRoleId = await resolveEntityAdminRoleId();

  const { rows, count } = await userRepository.findByRole(
    entityAdminRoleId,
    { search: query.search, status: query.status, createdBy: actorId },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const meta = getPaginationMeta(count, page, limit);
  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number} actorId - the calling Admin — an Entity Admin created by
 *   a DIFFERENT Admin 404s here, the same branch as a genuinely missing id
 *   (never leak cross-Admin existence).
 * @returns {Promise<User>}
 */
const getById = async (id, actorId) => {
  const user = await userRepository.findById(id);
  const entityAdminRoleId = await resolveEntityAdminRoleId();

  if (!user || user.role_id !== entityAdminRoleId || user.created_by !== actorId) {
    fail('Entity Admin not found.', 404);
  }

  return user;
};

/**
 * @param {number} id
 * @param {object} data
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<User>}
 */
const update = async (id, data, actorId, req) => {
  const existing = await getById(id, actorId);

  const oldValues = { email: existing.email, status: existing.status };
  const updated = await userRepository.update(id, { ...data, updated_by: actorId });

  await createAuditLog(actorId, 'UPDATE', 'users', id, oldValues, data, getIpAddress(req));

  logger.info('Entity Admin updated by Admin', { userId: id, actorId });

  return updated;
};

/**
 * @param {number} id
 * @param {'active'|'inactive'} status
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<User>}
 */
const setStatus = async (id, status, actorId, req) => {
  const existing = await getById(id, actorId);

  const updated = await userRepository.update(id, { status, updated_by: actorId });

  await createAuditLog(
    actorId,
    'UPDATE',
    'users',
    id,
    { status: existing.status },
    { status },
    getIpAddress(req)
  );

  logger.info('Entity Admin status changed by Admin', { userId: id, status, actorId });

  return updated;
};

module.exports = {
  createEntityAdmin,
  getAll,
  getById,
  update,
  setStatus,
};
