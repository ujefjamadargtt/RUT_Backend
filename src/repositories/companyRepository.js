'use strict';

const { Op } = require('sequelize');
const { Company } = require('../models');

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
 * Fetch all companies belonging to any of the given Entities, with
 * optional search/status filter — the Entity-Admin-scoped equivalent of
 * findAll() above (which was Platform-Admin-scoped, i.e. unscoped).
 *
 * @param {number[]} entityIds
 * @param {object} filters - { search, status }
 * @returns {Promise<Company[]>}
 */
const findAllForEntities = async (entityIds, filters = {}) => {
  if (!entityIds || entityIds.length === 0) return [];

  const { search, status } = filters;
  const where = { is_deleted: false, entity_id: { [Op.in]: entityIds } };

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

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  update,
  findIdsByEntityIds,
  findByIdForEntities,
  findAllForEntities,
};
