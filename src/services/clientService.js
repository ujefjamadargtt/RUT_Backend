'use strict';

const clientRepository = require('../repositories/clientRepository');
const { generateClientCode } = require('../helpers/codeGenerator');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Client Service
 * All business logic for the Client module.
 * Repositories are the only layer that touches the database.
 */

/**
 * Retrieve a paginated list of clients with optional filters.
 *
 * @param {object} query  - Express req.query (page, limit, status, search, industry, sort_by, sort_order)
 * @returns {Promise<{ data: Client[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || null,
    status: query.status || 'active',
    industry: query.industry || null,
    companyId,
  };

  const sort = {
    sortBy: query.sort_by || 'client_name',
    sortOrder: query.sort_order || 'ASC',
  };

  const { rows, count } = await clientRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * Retrieve a single client by ID.
 * Throws a 404-carrying error if not found.
 *
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<Client>}
 */
const getById = async (id, companyId) => {
  const client = await clientRepository.findById(id, companyId);

  if (!client) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }

  return client;
};

/**
 * Create a new client.
 * Auto-generates a client_code using the CLT prefix if one is not supplied.
 * Checks uniqueness of client_name before inserting.
 *
 * @param {object} data        - Validated body (client_name, industry, status, [client_code])
 * @param {number} userId      - ID of the authenticated user creating the record
 * @param {object} req         - Express request (for IP extraction in audit log)
 * @returns {Promise<Client>}
 */
const create = async (data, userId, req) => {
  const companyId = req.companyId;

  // Generate a unique code — retry up to 5 times on collision (scoped to
  // this company, since uniqueness is now per-company, not global)
  let client_code = generateClientCode();
  let attempts = 0;
  while (await clientRepository.findByCode(client_code, companyId)) {
    if (attempts >= 5) {
      const err = new Error('Failed to generate a unique client code. Please try again.');
      err.statusCode = 500;
      throw err;
    }
    client_code = generateClientCode();
    attempts++;
  }

  const payload = {
    ...data,
    client_code,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const client = await clientRepository.create(payload);

  await createAuditLog(
    userId,
    'CREATE',
    'clients',
    client.id,
    null,
    { client_code: client.client_code, client_name: client.client_name },
    getIpAddress(req)
  );

  logger.info('Client created', { clientId: client.id, client_code: client.client_code, userId });

  return client;
};

/**
 * Update an existing client.
 * Prevents updating to an already-used client_code.
 *
 * @param {number} id
 * @param {object} data   - Validated partial body
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<Client>}
 */
const update = async (id, data, userId, req) => {
  const companyId = req.companyId;

  const existing = await clientRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }

  // If the caller wants to change the code, ensure it is not already taken
  // within this company (uniqueness is per-company, not global)
  if (data.client_code && data.client_code !== existing.client_code) {
    const conflict = await clientRepository.findByCode(data.client_code, companyId);
    if (conflict) {
      const err = new Error(`Client code "${data.client_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const oldValues = {
    client_code: existing.client_code,
    client_name: existing.client_name,
    industry: existing.industry,
    status: existing.status,
  };

  const payload = { ...data, updated_by: userId };
  const updated = await clientRepository.update(id, payload, companyId);

  await createAuditLog(
    userId,
    'UPDATE',
    'clients',
    id,
    oldValues,
    payload,
    getIpAddress(req)
  );

  logger.info('Client updated', { clientId: id, userId });

  return updated;
};

/**
 * Soft-delete a client (status -> inactive).
 * Refuses to delete if the client has active Service POs.
 *
 * @param {number} id
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const deleteClient = async (id, userId, req) => {
  const companyId = req.companyId;

  const existing = await clientRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }

  if (existing.status === 'inactive') {
    const err = new Error('Client is already inactive.');
    err.statusCode = 400;
    throw err;
  }

  // Business rule: cannot delete a client that still has active POs
  const activePOCount = await clientRepository.countActivePOsByClient(id, companyId);
  if (activePOCount > 0) {
    const err = new Error(
      `Cannot deactivate client "${existing.client_name}". ` +
      `${activePOCount} active Service PO(s) are linked to this client. ` +
      'Close or reassign them before deactivating the client.'
    );
    err.statusCode = 409;
    throw err;
  }

  await clientRepository.softDelete(id, userId, companyId);

  await createAuditLog(
    userId,
    'DELETE',
    'clients',
    id,
    { status: 'active' },
    { status: 'inactive' },
    getIpAddress(req)
  );

  logger.info('Client soft-deleted', { clientId: id, userId });
};

/**
 * Return a lightweight list of all active clients.
 * Primarily used for form dropdowns.
 *
 * @returns {Promise<Client[]>}
 */
const getActiveClients = async (companyId) => {
  return clientRepository.getActiveClients(companyId);
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  deleteClient,
  getActiveClients,
};
