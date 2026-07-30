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

  const where = { company_id: companyId };

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
    where: { id, company_id: companyId },
    attributes: ['id', 'client_code', 'client_name', 'industry', 'status', 'created_at', 'updated_at', 'created_by', 'updated_by'],
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
    where: { client_code: code, company_id: companyId },
    attributes: ['id', 'client_code', 'client_name', 'industry', 'status'],
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
    where: { id, company_id: companyId },
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
    { where: { id, company_id: companyId } }
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
    where: { status: 'active', company_id: companyId },
    attributes: ['id', 'client_code', 'client_name', 'industry'],
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
      company_id: companyId,
    },
  });
};

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  update,
  softDelete,
  getActiveClients,
  countActivePOsByClient,
};
