'use strict';

const { Op } = require('sequelize');
const { Company, Entity } = require('../models');

/**
 * Company Repository
 * Raw database access only — no business logic.
 */

/**
 * Fetch all companies with optional search/status filter.
 * @param {object} filters - { search, status }
 * @returns {Promise<Company[]>}
 */
const findAll = async (filters = {}) => {
  const { search, status } = filters;
  const where = { is_deleted: false };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where[Op.or] = [
      { company_name: { [Op.iLike]: `%${search.trim()}%` } },
      { company_code: { [Op.iLike]: `%${search.trim()}%` } },
    ];
  }

  return Company.findAll({ where, order: [['company_name', 'ASC']] });
};

/**
 * Find a single company by primary key.
 * @param {number} id
 * @returns {Promise<Company|null>}
 */
const findById = async (id) => {
  return Company.findOne({ where: { id, is_deleted: false } });
};

/**
 * Find a company by its code (case-insensitive).
 * @param {string} code
 * @returns {Promise<Company|null>}
 */
const findByCode = async (code) => {
  return Company.findOne({ where: { company_code: { [Op.iLike]: code.trim() }, is_deleted: false } });
};

/**
 * Insert a new company.
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<Company>}
 */
const create = async (data, options = {}) => {
  return Company.create(data, options);
};

/**
 * Update an existing company by primary key.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<Company|null>}
 */
const update = async (id, data) => {
  const company = await Company.findByPk(id);
  if (!company) return null;
  return company.update(data);
};

/**
 * Fetch a paginated, filtered, sorted page of companies belonging to any of
 * the given Entities — the Entity-Admin-scoped equivalent of findAll() above
 * (which was Platform-Admin-scoped, i.e. unscoped). Mirrors
 * entityRepository.findAll()'s pagination/sort contract, plus an Entity join
 * so the BU Master list can show each Company's Entity name.
 *
 * @param {number[]} entityIds - the caller's own owned Entities (scope)
 * @param {object} filters - { search, status, entity_id, entity_ids, business_unit_ids }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: Company[], count: number }>}
 */
const findAllForEntities = async (entityIds, filters = {}, pagination = {}, sort = {}) => {
  if (!entityIds || entityIds.length === 0) return { rows: [], count: 0 };

  const { search, status, entity_id, entity_ids, business_unit_ids } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'company_name', sortOrder = 'ASC' } = sort;

  const where = { is_deleted: false, entity_id: { [Op.in]: entityIds } };

  // Narrowing to one or more specific Entities (e.g. the "Manage BUs" link
  // from Entity Master, or the new entityIds multi-select filter) must still
  // respect the caller's own scope — an id outside entityIds is dropped
  // rather than silently widening back to it; if EVERY requested id is
  // outside scope this resolves to no rows (the -1 sentinel), never an
  // error. entity_ids (plural, multi-select) wins over the legacy singular
  // entity_id when both are given.
  const requestedEntityIds = entity_ids && entity_ids.length > 0
    ? entity_ids
    : (entity_id ? [Number(entity_id)] : null);
  if (requestedEntityIds) {
    const scoped = requestedEntityIds.filter((id) => entityIds.includes(id));
    where.entity_id = { [Op.in]: scoped.length > 0 ? scoped : [-1] };
  }

  // businessUnitIds multi-select — /companies IS the BU list itself, so this
  // narrows directly by the Company's own id (still within the entity_id
  // scope already applied above, via Op.and-equivalent separate where keys).
  if (business_unit_ids && business_unit_ids.length > 0) {
    where.id = { [Op.in]: business_unit_ids };
  }

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where[Op.or] = [
      { company_name: { [Op.iLike]: `%${search.trim()}%` } },
      { company_code: { [Op.iLike]: `%${search.trim()}%` } },
    ];
  }

  const allowedSortColumns = ['company_name', 'company_code', 'status', 'created_at'];
  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'company_name';
  const safeSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase())
    ? sortOrder.toUpperCase()
    : 'ASC';

  return Company.findAndCountAll({
    where,
    limit,
    offset,
    order: [[safeSortBy, safeSortOrder]],
    include: [
      { model: Entity, as: 'entity', attributes: ['id', 'entity_name', 'entity_code'] },
      // BU Hierarchy — the nested `parent` relation is what lets the BU
      // Master UI/hierarchical selectors render "Technology -> Development"
      // from this same paginated, filtered list, with no separate tree
      // endpoint. A Parent BU's own `parent` is simply null.
      { model: Company, as: 'parent', attributes: ['id', 'company_name', 'company_code'] },
    ],
  });
};

/**
 * Every non-deleted Company whose parent_business_unit_id is one of the
 * given ids — one indexed query, depth-1 only (Sub-BUs never have children
 * of their own, so this never needs to recurse). The shared building block
 * for BU-hierarchy-aware filtering — see
 * companyAccessControlService.expandBusinessUnitIdsWithDescendants(), which
 * every report/list BU filter chokepoint funnels through.
 *
 * @param {number[]} parentIds
 * @returns {Promise<number[]>}
 */
const findChildIds = async (parentIds) => {
  if (!parentIds || parentIds.length === 0) return [];
  const children = await Company.findAll({
    where: { parent_business_unit_id: { [Op.in]: parentIds }, is_deleted: false },
    attributes: ['id'],
  });
  return children.map((c) => c.id);
};

/**
 * Whether the given Company currently has any (non-deleted) Sub-BU —
 * companyService.js's "can't turn an existing parent into a child" /
 * "can't nest a 3rd level" guard.
 *
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const hasChildren = async (companyId) => {
  const count = await Company.count({ where: { parent_business_unit_id: companyId, is_deleted: false } });
  return count > 0;
};

/**
 * Batched version of hasChildren() — of the given ids, which ones currently
 * have at least one (non-deleted) Sub-BU. One query, not N. Backs the
 * "Employee mapping must target the specific Sub-BU, not a Parent BU that
 * has Sub-BUs" rule — see employeeService.resolveBusinessUnitIds().
 *
 * @param {number[]} ids
 * @returns {Promise<number[]>} the subset of `ids` that have children
 */
const findIdsWithChildren = async (ids) => {
  if (!ids || ids.length === 0) return [];
  const children = await Company.findAll({
    where: { parent_business_unit_id: { [Op.in]: ids }, is_deleted: false },
    attributes: ['parent_business_unit_id'],
  });
  return [...new Set(children.map((c) => c.parent_business_unit_id))];
};

/**
 * Every non-deleted Company that is one of the given "root" ids (a
 * top-level Parent BU), OR a direct child of one of them — the full
 * Parent + Sub-BU "family" for each root, one query, depth-1 only. Backs
 * "a BU Admin with a foothold anywhere in a family (mapped to the Parent,
 * or to just one of its Sub-BUs) sees the WHOLE family" — see
 * companyService.getAllForEmployee()'s doc comment.
 *
 * @param {number[]} rootIds
 * @returns {Promise<Company[]>}
 */
const findFamilyMembers = async (rootIds) => {
  if (!rootIds || rootIds.length === 0) return [];
  return Company.findAll({
    where: {
      is_deleted: false,
      [Op.or]: [
        { id: { [Op.in]: rootIds } },
        { parent_business_unit_id: { [Op.in]: rootIds } },
      ],
    },
    include: [{ model: Company, as: 'parent', attributes: ['id', 'company_name', 'company_code'] }],
  });
};

/**
 * Return the IDs of every non-deleted Company belonging to any of the
 * given Entities — the resolution step Entity Admin's BU Admin Master
 * module needs before it can query Users by company_id.
 *
 * @param {number[]} entityIds
 * @returns {Promise<number[]>}
 */
const findIdsByEntityIds = async (entityIds) => {
  if (!entityIds || entityIds.length === 0) return [];

  const companies = await Company.findAll({
    where: { entity_id: { [Op.in]: entityIds }, is_deleted: false },
    attributes: ['id'],
  });
  return companies.map((c) => c.id);
};

/**
 * Find a single company by primary key, scoped to a set of allowed Entity
 * IDs — used by Entity Admin's Company/BU-Admin endpoints so a company
 * belonging to another Entity Admin's Entity 404s instead of leaking.
 *
 * @param {number} id
 * @param {number[]} entityIds
 * @returns {Promise<Company|null>}
 */
const findByIdForEntities = async (id, entityIds) => {
  if (!entityIds || entityIds.length === 0) return null;
  return Company.findOne({
    where: { id, entity_id: { [Op.in]: entityIds }, is_deleted: false },
    include: [{ model: Company, as: 'parent', attributes: ['id', 'company_name', 'company_code'] }],
  });
};

/**
 * Fetch the given Companies (by id) with their Entity attached — the source
 * for the Service PO "Map Employees" screen's Entity → BU filter dropdowns
 * (employeeServicePOMappingService.getEmployeeMappingFilterOptions()), which
 * needs an arbitrary, already-resolved BU id list (not one Entity Admin's/
 * Admin's owned Entities — see findAllForEntities() above, which the caller
 * lacks the standing to use here) turned into `{ id, company_name, entity_id,
 * entity_name }` rows.
 *
 * @param {number[]} companyIds
 * @returns {Promise<Company[]>}
 */
const findByIdsWithEntity = async (companyIds) => {
  if (!companyIds || companyIds.length === 0) return [];
  return Company.findAll({
    where: { id: { [Op.in]: companyIds }, is_deleted: false, status: 'active' },
    include: [{ model: Entity, as: 'entity', attributes: ['id', 'entity_name'] }],
    order: [['company_name', 'ASC']],
  });
};

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  update,
  findIdsByEntityIds,
  findByIdForEntities,
  findAllForEntities,
  findByIdsWithEntity,
  findChildIds,
  hasChildren,
  findIdsWithChildren,
  findFamilyMembers,
};
