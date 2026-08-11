'use strict';

const userRepository = require('../repositories/userRepository');
const companyRepository = require('../repositories/companyRepository');
const roleRepository = require('../repositories/roleRepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Entity BU Admin Service — "BU Admin Master", the second of Entity
 * Admin's two allowed modules. Lists/views/edits/activates/deactivates BU
 * Admin Users across every Company under the calling Entity Admin's OWNED
 * Entities (req.entityIds — see requireEntityAdmin.js). Entity Admin
 * cannot create Managers, Employees, Head Managers, or BU HR Heads here —
 * this module only ever touches Users whose role is exactly 'BU Admin'.
 */

async function resolveBuAdminRoleId() {
  const role = await roleRepository.findByName('BU Admin');
  if (!role) {
    const err = new Error('The "BU Admin" role is not seeded.');
    err.statusCode = 500;
    throw err;
  }
  return role.id;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

/**
 * @param {number[]} entityIds
 * @param {object} query - { page, limit, search, status, sort_by, sort_order }
 * @returns {Promise<{ data, meta }>}
 */
const getAll = async (entityIds, query = {}) => {
  const { page, limit, offset } = getPaginationParams(query);
  const [buAdminRoleId, companyIds] = await Promise.all([
    resolveBuAdminRoleId(),
    companyRepository.findIdsByEntityIds(entityIds),
  ]);

  const { rows, count } = await userRepository.findByCompanyIdsAndRole(
    companyIds,
    buAdminRoleId,
    { search: query.search, status: query.status },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const meta = getPaginationMeta(count, page, limit);
  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number[]} entityIds
 * @returns {Promise<User>}
 */
const getById = async (id, entityIds) => {
  const companyIds = await companyRepository.findIdsByEntityIds(entityIds);
  if (companyIds.length === 0) throw notFoundError('BU Admin not found.');

  const user = await userRepository.findById(id);
  if (!user || !companyIds.includes(user.company_id)) {
    throw notFoundError('BU Admin not found.');
  }

  const buAdminRoleId = await resolveBuAdminRoleId();
  if (user.role_id !== buAdminRoleId) {
    throw notFoundError('BU Admin not found.');
  }

  return user;
};

/**
 * Edit a BU Admin's basic fields (email/status) — reuses getById's
 * ownership + role check before writing.
 *
 * @param {number} id
 * @param {object} data
 * @param {number[]} entityIds
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<User>}
 */
const update = async (id, data, entityIds, actorId, req) => {
  const existing = await getById(id, entityIds);

  const oldValues = { email: existing.email, status: existing.status };
  const updated = await userRepository.update(id, { ...data, updated_by: actorId });

  await createAuditLog(actorId, 'UPDATE', 'users', id, oldValues, data, getIpAddress(req));

  logger.info('BU Admin updated by Entity Admin', { userId: id, actorId });

  return updated;
};

/**
 * Activate or deactivate a BU Admin.
 *
 * @param {number} id
 * @param {'active'|'inactive'} status
 * @param {number[]} entityIds
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<User>}
 */
const setStatus = async (id, status, entityIds, actorId, req) => {
  const existing = await getById(id, entityIds);

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

  logger.info('BU Admin status changed by Entity Admin', { userId: id, status, actorId });

  return updated;
};

module.exports = {
  getAll,
  getById,
  update,
  setStatus,
};
