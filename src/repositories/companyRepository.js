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
 * @param {object} filters - { search, status, entity_id }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: Company[], count: number }>}
 */
const findAllForEntities = async (entityIds, filters = {}, pagination = {}, sort = {}) => {
  if (!entityIds || entityIds.length === 0) return { rows: [], count: 0 };

  const { search, status, entity_id } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'company_name', sortOrder = 'ASC' } = sort;

  const where = { is_deleted: false, entity_id: { [Op.in]: entityIds } };

  // Narrowing to a single Entity (e.g. the "Manage BUs" link from Entity
  // Master) must still respect the caller's own scope — an entity_id outside
  // entityIds resolves to no rows rather than silently widening back to it.
  if (entity_id) {
    const requestedEntityId = Number(entity_id);
    where.entity_id = entityIds.includes(requestedEntityId) ? requestedEntityId : -1;
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
    include: [{ model: Entity, as: 'entity', attributes: ['id', 'entity_name', 'entity_code'] }],
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
  return Company.findOne({ where: { id, entity_id: { [Op.in]: entityIds }, is_deleted: false } });
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
};
