'use strict';

const companyRepository = require('../repositories/companyRepository');
const employeeBusinessUnitRepository = require('../repositories/employeeBusinessUnitRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationMeta } = require('../utils/pagination');
const { parseIdList } = require('../utils/idListParser');
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
    // Accepted in either casing — this endpoint's own established
    // convention is snake_case (entity_id, sort_by, ...), but entityIds/
    // businessUnitIds (camelCase) is the convention every Report endpoint
    // uses; snake_case wins when both are somehow given.
    entity_ids: parseIdList(query.entity_ids ?? query.entityIds) || null,
    business_unit_ids: parseIdList(query.business_unit_ids ?? query.businessUnitIds) || null,
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
 * BU Hierarchy / Sub-BU support: a BU Admin with a foothold ANYWHERE in a
 * Parent + Sub-BU family — mapped to the Parent directly, or to just one of
 * its Sub-BUs (e.g. only "DAS" under "DATA + AI") — sees the WHOLE family
 * here (the Parent + every one of its Sub-BUs), not only the specific
 * node(s) they're individually mapped to. Without this, a BU Admin mapped
 * to a single Sub-BU could never even see its sibling Sub-BUs to pick from
 * in a "Business Unit / Sub Business Unit" cascading dropdown (e.g. Add
 * Client), even though they're clearly working within that same family.
 *
 * @param {object} query - { search?, status? }
 * @param {number} employeeId
 * @returns {Promise<Company[]>}
 */
const getAllForEmployee = async (query = {}, employeeId) => {
  const mappedBusinessUnits = await employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId(employeeId);

  const rootIds = new Set();
  mappedBusinessUnits.forEach((bu) => {
    rootIds.add(bu.parent_business_unit_id != null ? bu.parent_business_unit_id : bu.id);
  });
  const familyMembers = await companyRepository.findFamilyMembers([...rootIds]);

  const businessUnitsById = new Map(mappedBusinessUnits.map((bu) => [bu.id, bu]));
  familyMembers.forEach((bu) => {
    if (!businessUnitsById.has(bu.id)) businessUnitsById.set(bu.id, bu);
  });
  const businessUnits = [...businessUnitsById.values()];

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
 * BU Hierarchy / Sub-BU support — validate a `parent_business_unit_id`
 * before it's written, on both create and update. Depth is capped at 2
 * levels (Parent BU -> Sub-BU): the parent itself must not already be a
 * Sub-BU, and (on update) the Company being assigned a parent must not
 * already have Sub-BUs of its own — either combination would nest a 3rd
 * level.
 *
 * @param {number} parentBusinessUnitId
 * @param {number[]} entityIds - caller's own owned Entities (parent must be one of these)
 * @param {number|null} [selfId] - the Company being created/updated (null on create)
 * @returns {Promise<import('../models').Company>} the validated parent row
 */
const validateParentBusinessUnit = async (parentBusinessUnitId, entityIds, selfId = null) => {
  if (selfId != null && parentBusinessUnitId === selfId) {
    fail('A Business Unit cannot be its own parent.', 422);
  }

  const parent = await companyRepository.findByIdForEntities(parentBusinessUnitId, entityIds);
  if (!parent) {
    fail(`Parent Business Unit #${parentBusinessUnitId} not found.`, 404);
  }

  // "A deleted/inactive parent should not allow creation of new active
  // children" — findByIdForEntities already excludes is_deleted rows, so
  // only the active/inactive status check is needed here.
  if (parent.status !== 'active') {
    fail('Cannot assign a Sub-BU to an inactive parent Business Unit.', 422);
  }

  if (parent.parent_business_unit_id != null) {
    fail('A Sub-BU cannot itself be a parent — only 2 levels of hierarchy (Business Unit -> Sub-BU) are supported.', 422);
  }

  if (selfId != null) {
    const selfHasChildren = await companyRepository.hasChildren(selfId);
    if (selfHasChildren) {
      fail('This Business Unit already has its own Sub-BUs and cannot be made a Sub-BU of another Business Unit.', 422);
    }
  }

  return parent;
};

/**
 * Auto-generate a unique company_code for a Sub-BU — "no need of BU code" at
 * Sub-BU creation time, same reasoning as entity_id being derived instead of
 * asked for. Built from company_name (uppercase alphanumeric, truncated to
 * the column's 20-char limit), with a numeric suffix appended if that base
 * collides with an existing code.
 *
 * @param {string} companyName
 * @returns {Promise<string>}
 */
const generateSubBuCode = async (companyName) => {
  const base = String(companyName || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'SUBBU';

  let candidate = base;
  let suffix = 1;
  while (await companyRepository.findByCode(candidate)) {
    const suffixStr = String(suffix);
    candidate = `${base.slice(0, 20 - suffixStr.length)}${suffixStr}`;
    suffix += 1;
  }
  return candidate;
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
 * BU Hierarchy / Sub-BU support: when `parent_business_unit_id` is given,
 * this Company is created as a Sub-BU and inherits from its parent instead
 * of asking for these separately:
 *   - entity_id — ALWAYS the parent's (never a client-supplied one, so a
 *     Sub-BU can never end up under a different Entity than its parent);
 *     optional in the request body.
 *   - saturday_off_rule ("off day") — the parent's Week Off Policy, ignoring
 *     any value in the request body ("off day, it takes its parent" — a
 *     Sub-BU doesn't get its own policy at create time).
 *   - company_code — auto-generated (generateSubBuCode()) when not supplied;
 *     "no need of BU code" for a Sub-BU. Still optional-not-required.
 * Without `parent_business_unit_id`, behavior is unchanged — a top-level
 * Parent BU requires its own explicit `entity_id` and `company_code`, and
 * `saturday_off_rule` defaults/behaves exactly as before.
 *
 * @param {object} data - { entity_id, company_code, company_name, is_original_data_visible?, saturday_off_rule?, parent_business_unit_id? }
 * @param {number} actorId - the Entity Admin creating this company
 * @param {string} ipAddress
 * @param {number[]} entityIds - the calling Entity Admin's own owned Entities (req.entityIds)
 * @returns {Promise<Company>}
 */
const create = async (data, actorId, ipAddress = null, entityIds = []) => {
  const { entity_id, company_code, company_name, is_original_data_visible, saturday_off_rule, parent_business_unit_id } = data;

  let effectiveEntityId = entity_id;
  let effectiveSaturdayOffRule = saturday_off_rule;
  let effectiveCompanyCode = company_code;

  if (parent_business_unit_id != null) {
    const parent = await validateParentBusinessUnit(parent_business_unit_id, entityIds, null);
    effectiveEntityId = parent.entity_id;
    effectiveSaturdayOffRule = parent.saturday_off_rule;
    if (!effectiveCompanyCode) {
      effectiveCompanyCode = await generateSubBuCode(company_name);
    }
  } else {
    // "Entity Admin cannot access Entities belonging to another Entity
    // Admin" — enforced here before anything else runs.
    if (!entityIds.includes(entity_id)) {
      fail(`Entity #${entity_id} is not one of your own entities.`, 403);
    }
  }

  const existingCompany = await companyRepository.findByCode(effectiveCompanyCode);
  if (existingCompany) {
    fail(`Company code "${effectiveCompanyCode}" already exists.`, 409);
  }

  const company = await companyRepository.create({
    entity_id: effectiveEntityId,
    company_code: effectiveCompanyCode,
    company_name,
    is_original_data_visible,
    saturday_off_rule: effectiveSaturdayOffRule,
    parent_business_unit_id: parent_business_unit_id ?? null,
    created_by: actorId,
    updated_by: actorId,
  });

  await createAuditLog(actorId, 'CREATE', 'companies', company.id, null, company.toJSON(), ipAddress);

  logger.info('Company created', { companyId: company.id, createdBy: actorId, parentBusinessUnitId: parent_business_unit_id ?? null });

  return company;
};

const update = async (id, data, actorId, ipAddress = null, entityIds = []) => {
  const existing = await getById(id, entityIds);
  const oldValues = existing.toJSON();

  // BU Hierarchy — re-validate whenever parent_business_unit_id is being
  // changed (including explicitly detaching it back to a top-level Parent
  // BU via `null`, which needs no extra checks: a promoted BU starts with
  // zero Sub-BUs of its own by construction).
  if (Object.prototype.hasOwnProperty.call(data, 'parent_business_unit_id') && data.parent_business_unit_id != null) {
    await validateParentBusinessUnit(data.parent_business_unit_id, entityIds, id);
  }

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
