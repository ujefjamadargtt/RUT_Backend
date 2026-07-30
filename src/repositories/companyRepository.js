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

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  update,
};
