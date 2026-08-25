'use strict';

const { Op } = require('sequelize');
const { Client, ServicePO } = require('../models');
const logger = require('../utils/logger');

/**
 * Client Repository
 * All direct database interaction for the clients table lives here.
 * No business logic — that belongs in clientService.js.
 */

/**
 * Builds a `company_id` WHERE fragment. Accepts:
 *   - a single number: the caller's own `req.companyId` (BU-scoped actor) —
 *     `{ company_id: companyId }`, unchanged from before.
 *   - an array: a company-less actor's (Admin/Entity Admin) RESOLVED list of
 *     owned Company ids (see companyAccessControlService.resolveOwnedCompanyIds)
 *     — `{ company_id: { [Op.in]: companyId } }`. An empty array correctly
 *     matches NOTHING (not "unrestricted") — this is what stops one Admin's
 *     Clients from leaking into an unrelated Admin's view.
 *   - `null`: a company-less actor's Client created with no Business Unit
 *     (see clientService.js's resolveOptionalCreateCompanyId() usage) —
 *     `{ company_id: null }`, matching only OTHER BU-less Clients (e.g. for
 *     the create-time duplicate-name/code check), never "everything."
 *   - `{ ownedCompanyIds, createdBy }`: from
 *     companyAccessControlService.resolveActorRecordAccessScope() — a
 *     company-less actor's owned-Company Clients UNIONED with their OWN
 *     Clients that have no Business Unit at all (`company_id IS NULL AND
 *     created_by = createdBy`), since plain `IN (...)` never matches NULL
 *     and would otherwise hide an Admin's own just-created BU-less Client
 *     from themselves forever.
 * Never call this with a bare `undefined` — that's a real caller-scope bug,
 * distinct from an intentional `null`.
 *
 * @param {number|number[]|null|{ownedCompanyIds: number[], createdBy: number|null}} companyId
 * @returns {object}
 */
function companyScope(companyId) {
  if (Array.isArray(companyId)) {
    return { company_id: { [Op.in]: companyId } };
  }
  if (companyId && typeof companyId === 'object') {
    const { ownedCompanyIds, createdBy } = companyId;
    return {
      [Op.or]: [
        { company_id: { [Op.in]: ownedCompanyIds } },
        { company_id: null, created_by: createdBy },
      ],
    };
  }
  return { company_id: companyId };
}

/**
 * Retrieve a paginated, filtered, sorted list of clients.
 *
 * @param {object} filters       - { search, status, industry }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: Client[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, industry, companyId } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'client_name', sortOrder = 'ASC' } = sort;

  const where = { ...companyScope(companyId) };

  // Status filter — omit clause when 'all' is requested
  if (status && status !== 'all') {
    where.status = status;
  }

  // Full-text search on client_name and client_code
  if (search && search.trim()) {
    where[Op.or] = [
      { client_name: { [Op.iLike]: `%${search.trim()}%` } },
      { client_code: { [Op.iLike]: `%${search.trim()}%` } },
    ];
  }

  // Exact-match industry filter
  if (industry && industry.trim()) {
    where.industry = { [Op.iLike]: `%${industry.trim()}%` };
  }

  const allowedSortColumns = ['client_name', 'client_code', 'industry', 'created_at', 'status'];
  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'client_name';
  const safeSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase())
    ? sortOrder.toUpperCase()
    : 'ASC';

  return Client.findAndCountAll({
    where,
    limit,
    offset,
    order: [[safeSortBy, safeSortOrder]],
    attributes: ['id', 'client_code', 'client_name', 'industry', 'status', 'created_at', 'updated_at', 'created_by'],
  });
};

/**
 * Find a single client by primary key.
 *
 * @param {number} id
 * @returns {Promise<Client|null>}
 */
const findById = async (id, companyId) => {
  return Client.findOne({
    where: { id, ...companyScope(companyId) },
    attributes: ['id', 'client_code', 'client_name', 'industry', 'status', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Find a single client by primary key with NO company filter — the caller
 * MUST independently verify the returned row is actually within its own
 * authorized reach before using it (same "fetch unscoped, then check"
 * pattern as servicePOService.js's assertValidDeliveryHead()). Exists for
 * projectService.create()'s company-less-Project case: a company-less
 * actor's Client can either belong to one of their owned Companies OR have
 * no Business Unit at all (`company_id: null`) — companyScope()'s array
 * form alone can't express "IN (...) OR IS NULL" (SQL `IN` never matches
 * NULL), so the ordinary scoped findById() would wrongly 404 a BU-less
 * Client that's genuinely this actor's own.
 *
 * @param {number} id
 * @returns {Promise<Client|null>}
 */
const findByIdUnscoped = async (id) => {
  return Client.findOne({
    where: { id },
    attributes: ['id', 'client_code', 'client_name', 'industry', 'status', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Find a client by its client_code, scoped to one company (uniqueness is
 * per-company — see the uq_clients_company_code composite constraint).
 *
 * @param {string} code
 * @param {number} companyId
 * @returns {Promise<Client|null>}
 */
const findByCode = async (code, companyId) => {
  return Client.findOne({
    where: { client_code: code, ...companyScope(companyId) },
    attributes: ['id', 'client_code', 'client_name', 'industry', 'status'],
  });
};

/**
 * Find a client by its name (case-insensitive, trimmed), scoped to one
 * company — uniqueness of the human-readable name, alongside the
 * machine-facing code uniqueness findByCode() already enforces.
 *
 * @param {string} name
 * @param {number} companyId
 * @returns {Promise<Client|null>}
 */
const findByName = async (name, companyId) => {
  return Client.findOne({
    where: { client_name: { [Op.iLike]: name.trim() }, ...companyScope(companyId) },
    attributes: ['id', 'client_code', 'client_name'],
  });
};

/**
 * Insert a new client record.
 *
 * @param {object} data - Fields to insert.
 * @returns {Promise<Client>}
 */
const create = async (data) => {
  return Client.create(data);
};

/**
 * Update an existing client by primary key.
 * Returns the updated record after applying changes.
 *
 * @param {number} id
 * @param {object} data - Fields to update.
 * @returns {Promise<Client>}
 */
const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await Client.update(data, {
    where: { id, ...companyScope(companyId) },
    returning: true,
  });

  if (affectedRows === 0) {
    return null;
  }

  return updated;
};

/**
 * Soft-delete a client by setting status to 'inactive'.
 *
 * @param {number} id
 * @param {number} updatedBy - User performing the delete.
 * @param {number} companyId
 * @returns {Promise<boolean>} true if a row was affected.
 */
const softDelete = async (id, updatedBy, companyId) => {
  const [affectedRows] = await Client.update(
    { status: 'inactive', updated_by: updatedBy },
    { where: { id, ...companyScope(companyId) } }
  );
  return affectedRows > 0;
};

/**
 * Return all clients with status = 'active', ordered by name.
 * Used for dropdown lists, so we return only essential fields.
 *
 * @param {number} companyId
 * @returns {Promise<Client[]>}
 */
const getActiveClients = async (companyId) => {
  return Client.findAll({
    where: { status: 'active', ...companyScope(companyId) },
    attributes: ['id', 'client_code', 'client_name', 'industry', 'company_id'],
    order: [['client_name', 'ASC']],
  });
};

/**
 * Count active Service POs that are linked to a given client.
 * Used before deletion to prevent orphaning.
 *
 * @param {number} clientId
 * @param {number} companyId
 * @returns {Promise<number>}
 */
const countActivePOsByClient = async (clientId, companyId) => {
  return ServicePO.count({
    where: {
      client_id: clientId,
      status: 'active',
      ...companyScope(companyId),
    },
  });
};

module.exports = {
  findAll,
  findById,
  findByIdUnscoped,
  findByCode,
  findByName,
  create,
  update,
  softDelete,
  getActiveClients,
  countActivePOsByClient,
};
