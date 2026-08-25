'use strict';

const { Op } = require('sequelize');
const { FormMaster } = require('../models');

/**
 * Form Master Repository
 * Raw database access only — no business logic.
 *
 * form_master holds both modules and forms in one table: a module is a row
 * with module_name = NULL and form_name = the module's own name; a form is
 * a row with module_name pointing at its parent module's form_name. See
 * database/migrations/20260856_add_form_master_seq_and_modules.sql.
 */

/**
 * Fetch all forms with optional search and status filter.
 *
 * @param {object} [query] - { status, search, module_name }
 * @returns {Promise<FormMaster[]>}
 */
const findAll = async (query = {}) => {
  const where = {};

  if (query.status && query.status !== 'all') {
    where.status = query.status;
  }

  if (query.module_name) {
    where.module_name = query.module_name.trim();
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
      ['seq', 'ASC'],
    ],
  });
};

/**
 * Find a single form/module by primary key.
 * @param {number} id
 * @returns {Promise<FormMaster|null>}
 */
const findById = async (id) => {
  return FormMaster.findByPk(id);
};

/**
 * Find every row whose primary key is in the given list.
 * @param {number[]} ids
 * @returns {Promise<FormMaster[]>}
 */
const findByIds = async (ids) => {
  if (ids.length === 0) return [];
  return FormMaster.findAll({ where: { id: { [Op.in]: ids } } });
};

/**
 * Find a child form by its (module_name, form_name) pair — the natural key
 * every screen is registered under.
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
 * Find a module row (module_name IS NULL) by its own name (form_name).
 * @param {string} name
 * @returns {Promise<FormMaster|null>}
 */
const findModuleByName = async (name) => {
  return FormMaster.findOne({ where: { module_name: null, form_name: name.trim() } });
};

/**
 * List every module row, ordered by module seq.
 * @param {string} [status] - 'active' | 'inactive' | 'all'
 * @returns {Promise<FormMaster[]>}
 */
const findModules = async (status) => {
  const where = { module_name: null };
  if (status && status !== 'all') {
    where.status = status;
  }
  return FormMaster.findAll({ where, order: [['seq', 'ASC']] });
};

/**
 * List every form registered under one module, ordered by its
 * within-module seq.
 * @param {string} moduleName
 * @param {string} [status] - 'active' | 'inactive' | 'all'
 * @returns {Promise<FormMaster[]>}
 */
const findFormsInModule = async (moduleName, status) => {
  const where = { module_name: moduleName };
  if (status && status !== 'all') {
    where.status = status;
  }
  return FormMaster.findAll({ where, order: [['seq', 'ASC']] });
};

/**
 * Find a module row (module_name IS NULL) by its own id — used wherever a
 * caller already has a numeric module id (categories, the move endpoint)
 * rather than the module's name.
 * @param {number} id
 * @returns {Promise<FormMaster|null>}
 */
const findModuleById = async (id) => {
  return FormMaster.findOne({ where: { id, module_name: null } });
};

/**
 * List every form registered under one category, ordered by its
 * within-module seq (categories don't have their own ordering scope for
 * forms — see categoryRepository.js's doc comment).
 * @param {number} categoryId
 * @param {string} [status] - 'active' | 'inactive' | 'all'
 * @returns {Promise<FormMaster[]>}
 */
const findFormsInCategory = async (categoryId, status) => {
  const where = { category_id: categoryId };
  if (status && status !== 'all') {
    where.status = status;
  }
  return FormMaster.findAll({ where, order: [['seq', 'ASC']] });
};

/**
 * Count every form registered under one module, regardless of status —
 * used by the module-delete guard (a module with any children, even
 * inactive ones, cannot be deleted).
 * @param {string} moduleName
 * @returns {Promise<number>}
 */
const countFormsInModule = async (moduleName) => {
  return FormMaster.count({ where: { module_name: moduleName } });
};

/**
 * Highest seq currently assigned to any module row, or 0 if none exist yet.
 * @returns {Promise<number>}
 */
const getMaxModuleSeq = async () => {
  const max = await FormMaster.max('seq', { where: { module_name: null } });
  return max || 0;
};

/**
 * Highest seq currently assigned to a form within one module, or 0 if the
 * module has no forms yet.
 * @param {string} moduleName
 * @returns {Promise<number>}
 */
const getMaxSeqInModule = async (moduleName) => {
  const max = await FormMaster.max('seq', { where: { module_name: moduleName } });
  return max || 0;
};

/**
 * Insert a new form or module row.
 * @param {object} data
 * @returns {Promise<FormMaster>}
 */
const create = async (data) => {
  return FormMaster.create(data);
};

/**
 * Update an existing form/module by primary key.
 * @param {number} id
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<FormMaster|null>}
 */
const update = async (id, data, options = {}) => {
  const form = await findById(id);
  if (!form) return null;
  return form.update(data, options);
};

/**
 * Re-point every child form of one module onto a new module name — used
 * when a module is renamed, so its children stay attached to it instead of
 * being orphaned under the old name.
 * @param {string} oldName
 * @param {string} newName
 * @param {object} transaction
 * @returns {Promise<number>} number of rows updated
 */
const updateModuleNameForChildren = async (oldName, newName, transaction) => {
  const [affectedCount] = await FormMaster.update(
    { module_name: newName },
    { where: { module_name: oldName }, transaction }
  );
  return affectedCount;
};

/**
 * Apply a batch of seq updates (reorder). Every item is updated
 * independently by id — callers are responsible for validating that every
 * id belongs to the scope being reordered (all modules, or all forms in the
 * same module) before calling this.
 * @param {{id: number, seq: number}[]} items
 * @param {object} transaction
 * @returns {Promise<void>}
 */
const bulkUpdateSeq = async (items, transaction) => {
  for (const item of items) {
    await FormMaster.update({ seq: item.seq }, { where: { id: item.id }, transaction });
  }
};

module.exports = {
  findAll,
  findById,
  findByIds,
  findByName,
  findModuleByName,
  findModuleById,
  findModules,
  findFormsInModule,
  findFormsInCategory,
  countFormsInModule,
  getMaxModuleSeq,
  getMaxSeqInModule,
  create,
  update,
  updateModuleNameForChildren,
  bulkUpdateSeq,
};
