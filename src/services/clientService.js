'use strict';

const clientRepository = require('../repositories/clientRepository');
const companyAccessControlService = require('./companyAccessControlService');
const { generateClientCode } = require('../helpers/codeGenerator');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Client Service
 * All business logic for the Client module.
 * Repositories are the only layer that touches the database.
 *
 * A BU-scoped actor (BU Admin, Manager, HR, Employee, ...) always has a
 * `req.companyId` and every read/write here stays scoped to it exactly as
 * before. Platform Admin/Admin/Entity Admin have no single company by
 * design (`req.companyId` is `undefined` — see resolveCompany.js) — they
 * are scoped instead to the Companies under their OWN owned Entities via
 * companyAccessControlService.resolveOwnedCompanyIds(), the SAME resolution
 * Employee Master uses (see employeeAccessControlService.js) — an
 * unrelated second Admin/Entity Admin must never see this Admin's Clients,
 * any more than they see this Admin's Employees.
 *
 * A Business Unit is OPTIONAL at create time for a company-less actor
 * (Admin/Entity Admin), same treatment employeeService.create() already
 * gives business_unit_ids — `clients.company_id` stays NULL until mapped
 * later via update(). A BU-scoped actor's own `req.companyId` still always
 * wins (see resolveOptionalCreateCompanyId()'s doc comment).
 *
 * Because of that, every READ/WRITE below uses resolveActorRecordAccessScope()
 * — not the plain resolveActorCompanyScope() — so a company-less actor's
 * scope also covers their OWN Clients left with no Business Unit
 * (`company_id IS NULL AND created_by = them`), not just their owned
 * Companies' Clients. Without this, an Admin who creates a Client without
 * picking a company could never see, edit, or deactivate it again — SQL
 * `IN (...)` never matches NULL, so it would silently vanish from their
 * own Client Master view the moment it was created.
 */

const { resolveActorRecordAccessScope, resolveOptionalCreateCompanyId } = companyAccessControlService;

/**
 * Retrieve a paginated list of clients with optional filters.
 *
 * @param {object} query  - Express req.query (page, limit, status, search, industry, sort_by, sort_order)
 * @param {object} authContext - { companyId, hierarchyRank, employeeId } — see controller
 * @returns {Promise<{ data: Client[], meta: object }>}
 */
const getAll = async (query = {}, authContext) => {
  const { page, limit, offset } = getPaginationParams(query);
  const companyId = await resolveActorRecordAccessScope(authContext);

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
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<Client>}
 */
const getById = async (id, authContext) => {
  const companyId = await resolveActorRecordAccessScope(authContext);
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
 * @param {object} data        - Validated body (client_name, industry, status, [client_code], [company_id])
 * @param {number} userId      - ID of the authenticated user creating the record
 * @param {object} req         - Express request (for IP extraction in audit log; also carries companyId/hierarchyRank/employeeId)
 * @returns {Promise<Client>}
 */
const create = async (data, userId, req) => {
  const { company_id: bodyCompanyId, ...clientFields } = data;
  const companyId = await resolveOptionalCreateCompanyId(
    { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId },
    bodyCompanyId
  );

  // Reject a duplicate client_name up front (case-insensitive, scoped to
  // this company) — client_code uniqueness alone doesn't stop the same
  // Client from being entered twice under two different codes.
  const duplicateName = await clientRepository.findByName(clientFields.client_name, companyId);
  if (duplicateName) {
    const err = new Error(`Client "${clientFields.client_name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

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
    ...clientFields,
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
 * @param {object} req    - carries companyId/hierarchyRank/employeeId
 * @returns {Promise<Client>}
 */
const update = async (id, data, userId, req) => {
  const companyId = await resolveActorRecordAccessScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

  const existing = await clientRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }

  // If the caller wants to change the code, ensure it is not already taken
  // within this company (uniqueness is per-company, not global)
  if (data.client_code && data.client_code !== existing.client_code) {
    const conflict = await clientRepository.findByCode(data.client_code, existing.company_id);
    if (conflict) {
      const err = new Error(`Client code "${data.client_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Same rule as create() — a renamed client can't collide with another
  // client's name in the same company.
  if (data.client_name && data.client_name.trim().toLowerCase() !== existing.client_name.toLowerCase()) {
    const nameConflict = await clientRepository.findByName(data.client_name, existing.company_id);
    if (nameConflict && nameConflict.id !== id) {
      const err = new Error(`Client "${data.client_name}" already exists.`);
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
  const updated = await clientRepository.update(id, payload, existing.company_id);

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
 * @param {object} req - carries companyId/hierarchyRank/employeeId
 * @returns {Promise<void>}
 */
const deleteClient = async (id, userId, req) => {
  const companyId = await resolveActorRecordAccessScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

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
  const activePOCount = await clientRepository.countActivePOsByClient(id, existing.company_id);
  if (activePOCount > 0) {
    const err = new Error(
      `Cannot deactivate client "${existing.client_name}". ` +
      `${activePOCount} active Service PO(s) are linked to this client. ` +
      'Close or reassign them before deactivating the client.'
    );
    err.statusCode = 409;
    throw err;
  }

  await clientRepository.softDelete(id, userId, existing.company_id);

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
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<Client[]>}
 */
const getActiveClients = async (authContext) => {
  const companyId = await resolveActorRecordAccessScope(authContext);
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
