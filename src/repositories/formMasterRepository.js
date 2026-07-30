'use strict';

const { Op } = require('sequelize');
const { FormMaster } = require('../models');

/**
 * Form Master Repository
 * Raw database access only — no business logic.
 */

/**
 * Fetch all forms with optional search and status filter.
 *
 * @param {object} [query] - { status, search }
 * @returns {Promise<FormMaster[]>}
 */
const findAll = async (query = {}) => {
  const where = {};

  if (query.status && query.status !== 'all') {
    where.status = query.status;
  }

  if (query.search && query.search.trim()) {
    const search = query.search.trim();
    where[Op.or] = [
      { module_name: { [Op.iLike]: `%${search}%` } },
      { form_name: { [Op.iLike]: `%${search}%` } },
    ];
  }

  return FormMaster.findAll({
    where,
    order: [
      ['module_name', 'ASC'],
      ['form_name', 'ASC'],
    ],
  });
};

/**
 * Find a single form by primary key.
 * @param {number} id
 * @returns {Promise<FormMaster|null>}
 */
const findById = async (id) => {
  return FormMaster.findByPk(id);
};

/**
 * Find a form by its (module_name, form_name) pair — the natural key every
 * screen is registered under.
 * @param {string} moduleName
 * @param {string} formName
 * @returns {Promise<FormMaster|null>}
 */
const findByName = async (moduleName, formName) => {
  return FormMaster.findOne({
    where: { module_name: moduleName.trim(), form_name: formName.trim() },
  });
};

/**
 * Insert a new form.
 * @param {object} data
 * @returns {Promise<FormMaster>}
 */
const create = async (data) => {
  return FormMaster.create(data);
};

/**
 * Update an existing form by primary key.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<FormMaster|null>}
 */
const update = async (id, data) => {
  const form = await findById(id);
  if (!form) return null;
  return form.update(data);
};

module.exports = {
  findAll,
  findById,
  findByName,
  create,
  update,
};
