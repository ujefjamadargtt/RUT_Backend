'use strict';

const { Op } = require('sequelize');
const { Category, FormMaster } = require('../models');

/**
 * Category Repository
 * Raw database access only — no business logic. Mirrors
 * formMasterRepository.js's style. A category always belongs to exactly
 * one module (module_id -> form_master.id, the module row's own id — see
 * database/migrations/20260881_add_form_master_categories.sql) and is
 * never moved between modules.
 */

/**
 * List categories, optionally scoped to one module and/or status.
 * @param {object} [query] - { module_id, status }
 * @returns {Promise<Category[]>}
 */
const findAll = async (query = {}) => {
  const where = {};

  if (query.module_id) {
    where.module_id = query.module_id;
  }

  if (query.status && query.status !== 'all') {
    where.status = query.status;
  }

  return Category.findAll({ where, order: [['module_id', 'ASC'], ['seq', 'ASC']] });
};

/**
 * @param {number} id
 * @returns {Promise<Category|null>}
 */
const findById = async (id) => {
  return Category.findByPk(id);
};

/**
 * @param {number[]} ids
 * @returns {Promise<Category[]>}
 */
const findByIds = async (ids) => {
  if (ids.length === 0) return [];
  return Category.findAll({ where: { id: { [Op.in]: ids } } });
};

/**
 * Find a category by its (module_id, name) natural key.
 * @param {number} moduleId
 * @param {string} name
 * @returns {Promise<Category|null>}
 */
const findByName = async (moduleId, name) => {
  return Category.findOne({ where: { module_id: moduleId, name: name.trim() } });
};

/**
 * Every category belonging to one module, ordered by seq.
 * @param {number} moduleId
 * @param {string} [status] - 'active' | 'inactive' | 'all'
 * @returns {Promise<Category[]>}
 */
const findByModule = async (moduleId, status) => {
  const where = { module_id: moduleId };
  if (status && status !== 'all') {
    where.status = status;
  }
  return Category.findAll({ where, order: [['seq', 'ASC']] });
};

/**
 * Count every form assigned to one category, regardless of status — used
 * by the category-delete guard (a category with any children, even
 * inactive ones, cannot be deactivated), mirroring
 * formMasterRepository.countFormsInModule.
 * @param {number} categoryId
 * @returns {Promise<number>}
 */
const countFormsInCategory = async (categoryId) => {
  return FormMaster.count({ where: { category_id: categoryId } });
};

/**
 * Highest seq currently assigned to a category within one module, or 0 if
 * the module has no categories yet.
 * @param {number} moduleId
 * @returns {Promise<number>}
 */
const getMaxSeqInModule = async (moduleId) => {
  const max = await Category.max('seq', { where: { module_id: moduleId } });
  return max || 0;
};

/**
 * @param {object} data
 * @returns {Promise<Category>}
 */
const create = async (data) => {
  return Category.create(data);
};

/**
 * @param {number} id
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<Category|null>}
 */
const update = async (id, data, options = {}) => {
  const category = await findById(id);
  if (!category) return null;
  return category.update(data, options);
};

/**
 * Apply a batch of seq updates (reorder categories within one module).
 * Callers are responsible for validating that every id belongs to the same
 * module before calling this — mirrors formMasterRepository.bulkUpdateSeq.
 * @param {{id: number, seq: number}[]} items
 * @param {object} transaction
 * @returns {Promise<void>}
 */
const bulkUpdateSeq = async (items, transaction) => {
  for (const item of items) {
    await Category.update({ seq: item.seq }, { where: { id: item.id }, transaction });
  }
};

module.exports = {
  findAll,
  findById,
  findByIds,
  findByName,
  findByModule,
  countFormsInCategory,
  getMaxSeqInModule,
  create,
  update,
  bulkUpdateSeq,
};
