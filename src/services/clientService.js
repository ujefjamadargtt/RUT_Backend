'use strict';

const clientRepository = require('../repositories/clientRepository');
const companyAccessControlService = require('./companyAccessControlService');
const { generateClientCode } = require('../helpers/codeGenerator');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { parseIdList } = require('../utils/idListParser');
const logger = require('../utils/logger');

/**
 * Client Service
 * All business logic for the Client module.
 * Repositories are the only layer that touches the database.
 *
 * A BU-scoped actor (BU Admin, Manager, HR, Employee, ...) always has a
 * `req.companyId` set by resolveCompany.js and every read/write here stays
 * scoped to it exactly as before.
 *
 * Platform Admin/Admin/Entity Admin have no single company by design
 * (`req.companyId` is `undefined` — see resolveCompany.js). On CREATE,
 * BU assignment is OPTIONAL — if the body carries a `company_id` it is
 * validated to be one of the actor's own owned Companies; if omitted the
 * client is created with company_id = NULL (BU-less). The X-Company-Id
 * header is deliberately NOT used as a fallback on create (it reflects
 * the Global BU selector state, not an explicit assignment intent).
 *
 * Every READ uses resolveActorRecordAccessScope() — not plain
 * resolveActorCompanyScope() — so a company-less actor's scope also covers
 * their OWN Clients left with no Business Unit (`company_id IS NULL AND
 * created_by = them`).
 */

const { resolveActorRecordAccessScope, resolveOptionalCreateCompanyId, resolveActorFullReach, intersectCompanyIdsWithEntity, intersectIdsWithBuHierarchy, expandBusinessUnitIdsToFamily, resolveCreateCompanyIdForActor } = companyAccessControlService;

/**
 * Retrieve a paginated list of clients with optional filters.
 *
 * @param {object} query  - Express req.query (page, limit, status, search, industry, sort_by, sort_order)
 * @param {object} authContext - { companyId, hierarchyRank, employeeId } — see controller
 * @returns {Promise<{ data: Client[], meta: object }>}
 */
const getAll = async (query = {}, authContext) => {
  const { page, limit, offset } = getPaginationParams(query);
  let companyId = await resolveActorRecordAccessScope(authContext);

  // BU Hierarchy / Sub-BU support — a BU-scoped actor's own single active
  // BU is expanded to its whole Parent + Sub-BU family (see
  // expandBusinessUnitIdsToFamily()'s doc comment), so the Client dropdown
  // used by Project/Service PO creation — and this same Client Master list —
  // surfaces a shared Client that still lives at the Parent level (e.g.
  // created before Sub-BUs existed) even while working under one specific
  // Sub-BU. Matches what creating a record under that Sub-BU already allows
  // (resolveCreateCompanyIdForActor's own identical family expansion) — a
  // dropdown that couldn't show an option the backend would otherwise
  // accept would be worse than not offering the option at all. A no-op for
  // a company-less actor (companyId is an object/array there, not a plain
  // number) and for a childless, parent-less BU (expands to itself only).
  if (typeof companyId === 'number') {
    companyId = await expandBusinessUnitIdsToFamily([companyId]);
  }

  // Optional entityIds/businessUnitIds multi-select narrowing. Handles BOTH
  // shapes resolveActorRecordAccessScope() can return: a plain array (most
  // actors), or — for a company-less actor with no ?company_id selected —
  // the { ownedCompanyIds, createdBy } object shape that also surfaces
  // their own BU-less records. An explicit entityIds/businessUnitIds
  // narrowing is treated the same as the existing explicit ?company_id
  // (selectedCompanyId) narrowing already is: the caller wants ONLY these
  // specific BUs' records now, so BU-less own-records are no longer
  // surfaced (collapses to a plain array, same as selectedCompanyId does).
  const entityIds = parseIdList(query.entityIds);
  const businessUnitIds = parseIdList(query.businessUnitIds);
  if (entityIds || businessUnitIds) {
    let scopeArray = Array.isArray(companyId) ? companyId : companyId.ownedCompanyIds;
    scopeArray = await intersectCompanyIdsWithEntity(scopeArray, entityIds);
    scopeArray = await intersectIdsWithBuHierarchy(scopeArray, businessUnitIds);
    companyId = scopeArray;
  }

  const filters = {
    search: query.search || null,
    status: query.status || 'active',
    industry: query.industry || null,
    companyId,
  };

  // camelCase sortBy/sortOrder (what the Client Master frontend sends) win
  // over snake_case sort_by/sort_order — the latter always carry a Joi
  // default (client_name/ASC), so they can't be the one to check first.
  // Unsupported values fall back to the default inside clientRepository.
  // findAll()'s whitelist, never into SQL.
  const sort = {
    sortBy: query.sortBy || query.sort_by || 'client_name',
    sortOrder: query.sortOrder || query.sort_order || 'ASC',
  };

  const { rows, count } = await clientRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * The scope update()/deleteClient() look an existing Client up by: the
 * caller's FULL reach (every BU they manage, ignoring the currently-active
 * X-Company-Id — see update()'s doc comment), wrapped by
 * resolveActorRecordAccessScope() so a company-less actor (Admin/Entity
 * Admin) also reaches a Client THEY created with no Business Unit yet
 * (company_id NULL) — the same rule getById() already applies. The plain
 * full-reach array alone becomes `company_id IN (...)`, which never matches
 * NULL, so such a Client could be created and opened but never saved or
 * deleted ("Client not found."). A BU-scoped actor is unaffected (plain array).
 *
 * @param {object} req
 * @returns {Promise<number[]|{ ownedCompanyIds: number[], createdBy: number|null }>}
 */
async function resolveClientWriteScope(req) {
  const fullReach = await resolveActorFullReach({
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
    employeeBusinessUnits: req.employeeBusinessUnits,
  });
  return resolveActorRecordAccessScope({
    companyId: fullReach,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });
}

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
 * Business Unit resolution:
 *   - BU-scoped actor (BU Admin and below, req.companyId set):
 *     If the body carries a `company_id` that belongs to this actor's mapped
 *     BUs, that BU is used — a multi-BU BU Admin picking a specific BU from
 *     the form gets the client created there, not in the header's active BU.
 *     If the body `company_id` is absent or matches the active BU, req.companyId
 *     wins. A body BU the actor is not mapped to → 403.
 *   - Company-less actor (Admin/Entity Admin, req.companyId undefined):
 *     BU assignment is OPTIONAL. If the body carries a `company_id` it is
 *     validated to be one of the actor's own owned Companies; if omitted
 *     the client is created with company_id = NULL (BU-less). The
 *     X-Company-Id header is deliberately NOT used as a fallback here.
 *
 * @param {object} data        - Validated body (client_name, industry, status, [client_code], [company_id])
 * @param {number} userId      - ID of the authenticated user creating the record
 * @param {object} req         - Express request (for IP extraction in audit log; also carries companyId/hierarchyRank/employeeId)
 * @returns {Promise<Client>}
 */
const create = async (data, userId, req) => {
  const { company_id: bodyCompanyId, ...clientFields } = data;

  // Unified BU resolution (resolveCreateCompanyIdForActor) — was previously
  // a hand-copied inline duplicate of this exact logic that never received
  // the BU Hierarchy / Sub-BU family-expansion fix applied to the shared
  // function (a BU Admin mapped to only one Sub-BU could create a Client
  // there, but not under a sibling Sub-BU their BU Admin role also covers).
  // required: false — a company-less actor (Admin/Entity Admin) may still
  // create a Client with no Business Unit assigned yet (company_id = NULL).
  const companyId = await resolveCreateCompanyIdForActor(req, bodyCompanyId ?? null, {
    required: false,
    resourceLabel: 'a Client',
  });

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
 * Looks the Client up via resolveActorFullReach() (NOT
 * resolveActorRecordAccessScope(req.companyId)) — same fix already shipped
 * for getClientById(): req.companyId is only the caller's single CURRENTLY
 * ACTIVE Business Unit (X-Company-Id), but GET /clients (which this Update
 * form's list is populated from) already spans every Business Unit the
 * caller manages. Scoping the existence check to just the active BU meant
 * opening any Client from a DIFFERENT BU than whichever one happened to be
 * currently selected 404'd on Save — "Client not found" — even for a
 * no-op rename, before any field-level logic ever ran. A company-less actor
 * (Admin/Entity Admin/Platform Admin) is unaffected either way.
 *
 * Business Unit REASSIGNMENT: an optional `company_id` in the body moves the
 * Client to a different Business Unit — same authorization rule create()
 * uses (never re-validated against req.companyId, the currently-active BU,
 * since a multi-BU actor must be able to move a Client between ANY of their
 * own mapped/owned BUs, not just the one currently selected):
 *   - BU-scoped actor (req.companyId set): the target company_id must be one
 *     of req.employeeBusinessUnits, else 403.
 *   - Company-less actor (Admin/Entity Admin): the target company_id must be
 *     one of their own owned Companies (resolveOwnedCompanyIds), else 403.
 * Omitted (or equal to the Client's current company_id) -> no BU change.
 * client_code/client_name uniqueness is checked against the DESTINATION
 * company (the new BU when one is being assigned), since uniqueness is
 * per-company.
 *
 * @param {number} id
 * @param {object} data   - Validated partial body (may include company_id)
 * @param {number} userId
 * @param {object} req    - carries companyId/hierarchyRank/employeeId/employeeBusinessUnits
 * @returns {Promise<Client>}
 */
const update = async (id, data, userId, req) => {
  const companyId = await resolveClientWriteScope(req);

  const existing = await clientRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }

  const { company_id: bodyCompanyId, ...clientFields } = data;

  let targetCompanyId = existing.company_id;
  if (bodyCompanyId != null && bodyCompanyId !== existing.company_id) {
    if (req.companyId != null) {
      // BU Hierarchy / Sub-BU support — expanded to the actor's whole
      // Parent + Sub-BU family (see expandBusinessUnitIdsToFamily()'s doc
      // comment), same as resolveCreateCompanyIdForActor()/create() above:
      // a BU Admin mapped to only one Sub-BU may still reassign a Client to
      // any of its siblings, not just their own literal mapping.
      const rawMappedIds = (req.employeeBusinessUnits || []).map((bu) => bu.id);
      const mappedBuIds = await expandBusinessUnitIdsToFamily(rawMappedIds);
      if (!mappedBuIds.includes(bodyCompanyId)) {
        const err = new Error(`Business Unit #${bodyCompanyId} is not one of your mapped Business Units.`);
        err.statusCode = 403;
        throw err;
      }
    } else {
      const ownedCompanyIds = (await companyAccessControlService.resolveOwnedCompanyIds(req.hierarchyRank, req.employeeId)) || [];
      if (!ownedCompanyIds.includes(bodyCompanyId)) {
        const err = new Error(`Business Unit #${bodyCompanyId} is not one of your own Business Units.`);
        err.statusCode = 403;
        throw err;
      }
    }
    targetCompanyId = bodyCompanyId;
  }

  // If the caller wants to change the code, ensure it is not already taken
  // within the DESTINATION company (uniqueness is per-company, not global)
  if (data.client_code && data.client_code !== existing.client_code) {
    const conflict = await clientRepository.findByCode(data.client_code, targetCompanyId);
    if (conflict) {
      const err = new Error(`Client code "${data.client_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Same rule as create() — a renamed (or BU-moved) client can't collide
  // with another client's name in the same DESTINATION company.
  if (data.client_name && data.client_name.trim().toLowerCase() !== existing.client_name.toLowerCase()) {
    const nameConflict = await clientRepository.findByName(data.client_name, targetCompanyId);
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
    company_id: existing.company_id,
  };

  const payload = { ...clientFields, company_id: targetCompanyId, updated_by: userId };
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
 * Looks the Client up via resolveActorFullReach() — same reasoning as
 * update()'s own doc comment above.
 *
 * @param {number} id
 * @param {number} userId
 * @param {object} req - carries hierarchyRank/employeeId/employeeBusinessUnits
 * @returns {Promise<void>}
 */
const deleteClient = async (id, userId, req) => {
  const companyId = await resolveClientWriteScope(req);

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
