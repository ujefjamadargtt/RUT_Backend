'use strict';

const companyRepository = require('../repositories/companyRepository');
const employeeBusinessUnitRepository = require('../repositories/employeeBusinessUnitRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Company Service
 * Entity Admin-scoped provisioning (repurposed from Platform-Admin-scoped
 * when Entity Admin was introduced): create/list/update companies, and the
 * transactional "company + its first BU Admin" creation flow, always
 * scoped to the calling Entity Admin's own owned Entities (entityIds). A
 * company is never created without an owner — if admin creation fails, the
 * company insert rolls back too.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

/**
 * @param {object} query - Express req.query (page, limit, status, search, entity_id, sort_by, sort_order)
 * @param {number[]} entityIds - the calling Entity Admin's own owned Entities (req.entityIds)
 * @returns {Promise<{ data: Company[], meta: object }>}
 */
const getAll = async (query = {}, entityIds) => {
  const page = query.page || 1;
  const limit = query.limit || 10;
  const offset = (page - 1) * limit;

  const filters = {
    search: query.search || null,
    status: query.status || 'active',
    entity_id: query.entity_id || null,
  };

  const sort = {
    sortBy: query.sort_by || 'company_name',
    sortOrder: query.sort_order || 'ASC',
  };

  const { rows, count } = await companyRepository.findAllForEntities(entityIds, filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * Same "load BUs" contract as getAll() above, but for a BU Admin (or any
 * other BU-scoped caller) hitting GET /companies for the Service PO
 * creation BU dropdown — they have no `entityIds` (that's an Entity Admin/
 * Admin-only concept), so this returns only the caller's OWN actively
 * mapped Business Units instead, reusing the same
 * employeeBusinessUnitRepository lookup employeeService.getBusinessUnits()
 * already uses. Filtered/sorted to match getAll()'s search/status/name-order
 * contract so the frontend's existing dropdown rendering needs no changes.
 *
 * @param {object} query - { search?, status? }
 * @param {number} employeeId
 * @returns {Promise<Company[]>}
 */
const getAllForEmployee = async (query = {}, employeeId) => {
  const businessUnits = await employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId(employeeId);

  let filtered = businessUnits;
  if (query.status && query.status !== 'all') {
    filtered = filtered.filter((bu) => bu.status === query.status);
  }
  if (query.search && query.search.trim()) {
    const term = query.search.trim().toLowerCase();
    filtered = filtered.filter(
      (bu) => bu.company_name.toLowerCase().includes(term) || bu.company_code.toLowerCase().includes(term)
    );
  }

  return [...filtered].sort((a, b) => a.company_name.localeCompare(b.company_name));
};

const getById = async (id, entityIds) => {
  const company = await companyRepository.findByIdForEntities(id, entityIds);
  if (!company) fail(`Company with ID ${id} not found.`, 404);
  return company;
};

/**
 * Create a company under one of the calling Entity Admin's own owned
 * Entities. Decoupled from admin-minting (Employee-as-Identity redesign) —
 * a company is created bare; assigning someone the "BU Admin" role for it
 * is now an ordinary employeeService.create()/update() call with the BU
 * Admin role id in `role_ids` and this company's id in `business_unit_ids`,
 * not a dedicated endpoint.
 *
 * Does NOT seed any Service Category/Type rows for the new company — Type
 * and Category are now global masters (company_id IS NULL rows in
 * service_categories/service_types, seeded once by database/migrations/
 * 20260890_seed_global_service_types_categories.sql), shared by every
 * Business Unit instead of being duplicated per-BU.
 *
 * @param {object} data - { entity_id, company_code, company_name, is_original_data_visible? }
 * @param {number} actorId - the Entity Admin creating this company
 * @param {string} ipAddress
 * @param {number[]} entityIds - the calling Entity Admin's own owned Entities (req.entityIds)
 * @returns {Promise<Company>}
 */
const create = async (data, actorId, ipAddress = null, entityIds = []) => {
  const { entity_id, company_code, company_name, is_original_data_visible } = data;

  // "Entity Admin cannot access Entities belonging to another Entity
  // Admin" — enforced here before anything else runs.
  if (!entityIds.includes(entity_id)) {
    fail(`Entity #${entity_id} is not one of your own entities.`, 403);
  }

  const existingCompany = await companyRepository.findByCode(company_code);
  if (existingCompany) {
    fail(`Company code "${company_code}" already exists.`, 409);
  }

  const company = await companyRepository.create({
    entity_id,
    company_code,
    company_name,
    is_original_data_visible,
    created_by: actorId,
    updated_by: actorId,
  });

  await createAuditLog(actorId, 'CREATE', 'companies', company.id, null, company.toJSON(), ipAddress);

  logger.info('Company created', { companyId: company.id, createdBy: actorId });

  return company;
};

const update = async (id, data, actorId, ipAddress = null, entityIds = []) => {
  const existing = await getById(id, entityIds);
  const oldValues = existing.toJSON();

  const updated = await companyRepository.update(id, data);

  await createAuditLog(actorId, 'UPDATE', 'companies', id, oldValues, updated.toJSON(), ipAddress);

  return updated;
};

module.exports = {
  getAll,
  getAllForEmployee,
  getById,
  create,
  update,
};
