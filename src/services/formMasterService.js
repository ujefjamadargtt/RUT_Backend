'use strict';

const { sequelize } = require('../models');
const formRepository = require('../repositories/formMasterRepository');
const categoryRepository = require('../repositories/categoryRepository');
const { createAuditLog } = require('../middlewares/auditLog');

/**
 * Form Master Service
 *
 * form_master holds both modules and forms in one table (no separate
 * module_master table): a module is a row with module_name = NULL and
 * form_name = the module's own name; a form is a row with module_name
 * pointing at its parent module's form_name. See database/migrations/
 * 20260856_add_form_master_seq_and_modules.sql for the schema change and
 * database/README.md for general migration conventions.
 *
 * seq orders modules among themselves, and independently orders each
 * module's own children — a form's seq only has meaning relative to
 * siblings in the same module. Callers never submit seq directly on
 * create/update (see formMasterValidation.js) — it's computed here, and can
 * only be changed via reorderModules()/reorderForms().
 */

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

/**
 * Fetch a single row (module or form) by id, or throw 404.
 * @param {number} id
 * @returns {Promise<FormMaster>}
 */
const getById = async (id) => {
  const form = await formRepository.findById(id);
  if (!form) {
    fail(`Form with ID ${id} not found.`, 404);
  }
  return form;
};

/**
 * Guard the (module_name, form_name) natural key for a CHILD form — modules
 * have their own separate uniqueness rule (findModuleByName), since a
 * module row's module_name is always NULL and can't be checked this way.
 * @param {object} data - { module_name, form_name }
 * @param {number} [excludeId]
 */
const assertUnique = async (data, excludeId) => {
  if (!data.module_name || !data.form_name) return;
  const existing = await formRepository.findByName(data.module_name, data.form_name);
  if (existing && existing.id !== excludeId) {
    fail('A form with this module name and form name already exists.', 409);
  }
};

/**
 * Load a category by id and confirm it belongs to the given module row —
 * the section 11/14 invariant (Form.module_id = Category.module_id when
 * category_id is present) that can't be a plain DB CHECK since it needs a
 * join. Returns the category row (never null) or throws.
 * @param {number} categoryId
 * @param {FormMaster} moduleRow - the resolved module row (module_name IS NULL)
 * @returns {Promise<Category>}
 */
const assertCategoryBelongsToModule = async (categoryId, moduleRow) => {
  const category = await categoryRepository.findById(categoryId);
  if (!category) {
    fail(`Category with ID ${categoryId} not found.`, 400);
  }
  if (category.module_id !== moduleRow.id) {
    fail(`Category '${category.name}' does not belong to module '${moduleRow.form_name}'.`, 400);
  }
  return category;
};

// ── Create ───────────────────────────────────────────────────────────────

/**
 * Create a new module row: module_name = NULL, form_name = the module's
 * name. Sequenced after every existing module.
 * @param {object} data - { form_name, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const createModule = async (data, userId, ipAddress) => {
  const existing = await formRepository.findModuleByName(data.form_name);
  if (existing) {
    fail('A module with this name already exists.', 409);
  }

  const maxSeq = await formRepository.getMaxModuleSeq();
  const created = await formRepository.create({
    module_name: null,
    form_name: data.form_name.trim(),
    status: data.status || 'active',
    seq: maxSeq + 1,
  });

  await createAuditLog(userId, 'CREATE', 'form_master', created.id, null, created.toJSON(), ipAddress);
  return created;
};

/**
 * Create a new form row under an existing module. Sequenced after every
 * existing form in that module — the module's own global position never
 * factors into a child's seq.
 * @param {object} data - { module_name, form_name, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const createForm = async (data, userId, ipAddress) => {
  const moduleRow = await formRepository.findModuleByName(data.module_name);
  if (!moduleRow) {
    fail(`Module '${data.module_name}' does not exist. Create the module first.`, 400);
  }

  await assertUnique(data);

  let categoryId = null;
  if (data.category_id !== undefined && data.category_id !== null) {
    const category = await assertCategoryBelongsToModule(data.category_id, moduleRow);
    categoryId = category.id;
  }

  const maxSeq = await formRepository.getMaxSeqInModule(data.module_name);
  const created = await formRepository.create({
    module_name: data.module_name.trim(),
    form_name: data.form_name.trim(),
    status: data.status || 'active',
    seq: maxSeq + 1,
    category_id: categoryId,
  });

  await createAuditLog(userId, 'CREATE', 'form_master', created.id, null, created.toJSON(), ipAddress);
  return created;
};

/**
 * POST /forms — dispatches to createModule() or createForm() based on
 * whether module_name is null (module) or a string (form). The frontend
 * never computes/submits seq either way.
 * @param {object} data - { form_name, module_name, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const create = async (data, userId, ipAddress) => {
  if (data.module_name === null || data.module_name === undefined) {
    return createModule(data, userId, ipAddress);
  }
  return createForm(data, userId, ipAddress);
};

// ── Update ───────────────────────────────────────────────────────────────

/**
 * Rename and/or (de)activate a module row. Renaming cascades to every
 * child's module_name in the same transaction, so no form is left pointing
 * at the old name. seq is preserved unless reorderModules() is called.
 * @param {FormMaster} existing
 * @param {object} data - { form_name?, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const updateModule = async (existing, data, userId, ipAddress) => {
  const payload = {};
  if (data.status !== undefined) payload.status = data.status;

  const newName = data.form_name !== undefined ? data.form_name.trim() : existing.form_name;
  const renaming = newName !== existing.form_name;

  if (renaming) {
    const conflict = await formRepository.findModuleByName(newName);
    if (conflict && conflict.id !== existing.id) {
      fail('A module with this name already exists.', 409);
    }
    payload.form_name = newName;
  }

  if (Object.keys(payload).length === 0) {
    return existing;
  }

  const before = existing.toJSON();
  let updated;
  if (renaming) {
    const t = await sequelize.transaction();
    try {
      updated = await formRepository.update(existing.id, payload, { transaction: t });
      await formRepository.updateModuleNameForChildren(existing.form_name, newName, t);
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  } else {
    updated = await formRepository.update(existing.id, payload);
  }

  await createAuditLog(userId, 'UPDATE', 'form_master', existing.id, before, updated.toJSON(), ipAddress);
  return updated;
};

/**
 * Rename, (de)activate, and/or move a CHILD form. Moving it to a different
 * module (module_name changes) assigns it the next seq within the
 * destination module — its old seq under the previous module is simply
 * abandoned, never reused. seq otherwise stays exactly as it was.
 * @param {FormMaster} existing
 * @param {object} data - { form_name?, module_name?, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const updateForm = async (existing, data, userId, ipAddress) => {
  const payload = {};
  if (data.form_name !== undefined) payload.form_name = data.form_name.trim();
  if (data.status !== undefined) payload.status = data.status;

  let moving = false;
  let targetModule = existing.module_name;
  if (data.module_name !== undefined) {
    targetModule = data.module_name.trim();
    if (targetModule !== existing.module_name) {
      const moduleRow = await formRepository.findModuleByName(targetModule);
      if (!moduleRow) {
        fail(`Module '${targetModule}' does not exist.`, 400);
      }
      payload.module_name = targetModule;
      moving = true;
    }
  }

  const checkFormName = payload.form_name !== undefined ? payload.form_name : existing.form_name;
  await assertUnique({ module_name: targetModule, form_name: checkFormName }, existing.id);

  if (moving) {
    const maxSeq = await formRepository.getMaxSeqInModule(targetModule);
    payload.seq = maxSeq + 1;
  }

  if (Object.keys(payload).length === 0) {
    return existing;
  }

  const before = existing.toJSON();
  const updated = await formRepository.update(existing.id, payload);
  await createAuditLog(userId, 'UPDATE', 'form_master', existing.id, before, updated.toJSON(), ipAddress);
  return updated;
};

/**
 * PUT /forms/:id — dispatches to updateModule() or updateForm() based on
 * the EXISTING row's type. A row can never flip from module to form or back
 * through this endpoint — that would silently re-parent/orphan children in
 * ways this feature doesn't define, so it's rejected outright.
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const update = async (id, data, userId, ipAddress) => {
  const existing = await getById(id);
  const isModuleRow = existing.module_name === null;

  if (data.module_name !== undefined) {
    const targetIsModule = data.module_name === null;
    if (targetIsModule !== isModuleRow) {
      fail('Cannot change a module into a form (or vice versa). Delete and recreate it instead.', 400);
    }
  }

  return isModuleRow
    ? updateModule(existing, data, userId, ipAddress)
    : updateForm(existing, data, userId, ipAddress);
};

// ── Move (Module <-> Category <-> Module/Category) ─────────────────────────

/**
 * PUT /forms/:id/move — the dedicated Move Form operation (distinct from
 * PUT /forms/:id, which only renames/(de)activates/moves-by-name). Handles
 * every case in one place: Module -> Category, Category -> Module,
 * Category A -> Category B, and moving to a different module entirely.
 * Only module_id/category_id are ever touched here — form_name/status are
 * untouched.
 *
 * Destination validation always runs to completion BEFORE the single write,
 * and the write itself is wrapped in a transaction — if anything fails, the
 * form's original module/category relationship is left completely
 * untouched (section 18's transactional requirement).
 *
 * If module_id changes and category_id is NOT explicitly provided, the
 * category is reset to null rather than silently carried over — a category
 * under the OLD module is never valid under the new one (section 11).
 *
 * @param {number} id
 * @param {object} data - { module_id?: number, category_id?: number|null }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const moveForm = async (id, data, userId, ipAddress) => {
  const existing = await getById(id);
  if (existing.module_name === null) {
    fail('Cannot move a module. Only forms can be moved.', 400);
  }

  const currentModuleRow = await formRepository.findModuleByName(existing.module_name);

  let destinationModuleRow = currentModuleRow;
  let moving = false;
  if (data.module_id !== undefined) {
    const targetModuleRow = await formRepository.findModuleById(data.module_id);
    if (!targetModuleRow) {
      fail(`Module with ID ${data.module_id} does not exist.`, 400);
    }
    if (targetModuleRow.id !== currentModuleRow.id) {
      destinationModuleRow = targetModuleRow;
      moving = true;
    }
  }

  let targetCategoryId;
  if (data.category_id !== undefined) {
    if (data.category_id === null) {
      targetCategoryId = null;
    } else {
      const category = await assertCategoryBelongsToModule(data.category_id, destinationModuleRow);
      targetCategoryId = category.id;
    }
  } else if (moving) {
    // The module changed but no explicit category was given — the old
    // category (if any) belongs to the OLD module, so it can't carry over.
    targetCategoryId = null;
  } else {
    targetCategoryId = existing.category_id;
  }

  await assertUnique(
    { module_name: destinationModuleRow.form_name, form_name: existing.form_name },
    existing.id
  );

  const payload = { category_id: targetCategoryId };
  if (moving) {
    payload.module_name = destinationModuleRow.form_name;
    const maxSeq = await formRepository.getMaxSeqInModule(destinationModuleRow.form_name);
    payload.seq = maxSeq + 1;
  }

  const before = existing.toJSON();
  const t = await sequelize.transaction();
  let updated;
  try {
    updated = await formRepository.update(existing.id, payload, { transaction: t });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(userId, 'UPDATE', 'form_master', existing.id, before, updated.toJSON(), ipAddress);
  return updated;
};

// ── Delete (soft) ────────────────────────────────────────────────────────

/**
 * DELETE /forms/:id — soft-deactivates a form OR a module (status =
 * 'inactive'), never hard-deletes, since role_form_mapping rows may
 * reference it. A module with any children (active or inactive) cannot be
 * deactivated — its forms must be reassigned or removed first.
 * @param {number} id
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster>}
 */
const deactivate = async (id, userId, ipAddress) => {
  const existing = await getById(id);

  if (existing.module_name === null) {
    const childCount = await formRepository.countFormsInModule(existing.form_name);
    if (childCount > 0) {
      fail(
        `Cannot delete module '${existing.form_name}' because it still has ${childCount} form(s) under it. Reassign or remove them first.`,
        400
      );
    }
  }

  return update(id, { status: 'inactive' }, userId, ipAddress);
};

// ── Reorder ──────────────────────────────────────────────────────────────

/**
 * PATCH /forms/modules/reorder — bulk-assign new seq values to module rows.
 * Only affects module rows (module_name IS NULL); never touches any child
 * form's seq.
 * @param {{id: number, seq: number}[]} items
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster[]>} every module, in its new order
 */
const reorderModules = async (items, userId, ipAddress) => {
  const ids = items.map((item) => item.id);
  const rows = await formRepository.findByIds(ids);
  if (rows.length !== ids.length) {
    fail('One or more module IDs were not found.', 404);
  }
  if (rows.some((row) => row.module_name !== null)) {
    fail('All items being reordered must be modules.', 400);
  }

  const before = rows.map((row) => ({ id: row.id, seq: row.seq }));

  const t = await sequelize.transaction();
  try {
    await formRepository.bulkUpdateSeq(items, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(userId, 'UPDATE', 'form_master', null, { modules: before }, { modules: items }, ipAddress);

  return formRepository.findModules('all');
};

/**
 * PATCH /forms/reorder — bulk-assign new seq values to the forms inside ONE
 * module. Every id given must already belong to that module — reordering
 * cannot be used to silently move a form into a different module (use PUT
 * /forms/:id for that).
 * @param {string} moduleName
 * @param {{id: number, seq: number}[]} items
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<FormMaster[]>} every form in the module, in its new order
 */
const reorderForms = async (moduleName, items, userId, ipAddress) => {
  const moduleRow = await formRepository.findModuleByName(moduleName);
  if (!moduleRow) {
    fail(`Module '${moduleName}' does not exist.`, 404);
  }

  const ids = items.map((item) => item.id);
  const rows = await formRepository.findByIds(ids);
  if (rows.length !== ids.length) {
    fail('One or more form IDs were not found.', 404);
  }
  if (rows.some((row) => row.module_name !== moduleName)) {
    fail('All forms being reordered must belong to the same module.', 400);
  }

  const before = rows.map((row) => ({ id: row.id, seq: row.seq }));

  const t = await sequelize.transaction();
  try {
    await formRepository.bulkUpdateSeq(items, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(
    userId,
    'UPDATE',
    'form_master',
    null,
    { module_name: moduleName, forms: before },
    { module_name: moduleName, forms: items },
    ipAddress
  );

  return formRepository.findFormsInModule(moduleName, 'all');
};

// ── Category CRUD ────────────────────────────────────────────────────────

/**
 * Fetch a single category by id, or throw 404.
 * @param {number} id
 * @returns {Promise<Category>}
 */
const getCategoryById = async (id) => {
  const category = await categoryRepository.findById(id);
  if (!category) {
    fail(`Category with ID ${id} not found.`, 404);
  }
  return category;
};

/**
 * GET /forms/categories
 * @param {object} query - { module_id?, status? }
 * @returns {Promise<Category[]>}
 */
const getCategories = (query) => categoryRepository.findAll(query);

/**
 * POST /forms/categories — a category always belongs to exactly one
 * module, addressed by its module row's own id (unlike forms, which
 * address their module by name in create/update).
 * @param {object} data - { module_id, name, description?, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Category>}
 */
const createCategory = async (data, userId, ipAddress) => {
  const moduleRow = await formRepository.findModuleById(data.module_id);
  if (!moduleRow) {
    fail(`Module with ID ${data.module_id} does not exist.`, 400);
  }

  const existing = await categoryRepository.findByName(data.module_id, data.name);
  if (existing) {
    fail('A category with this name already exists under this module.', 409);
  }

  const maxSeq = await categoryRepository.getMaxSeqInModule(data.module_id);
  const created = await categoryRepository.create({
    module_id: data.module_id,
    name: data.name.trim(),
    description: data.description ? data.description.trim() : null,
    status: data.status || 'active',
    seq: maxSeq + 1,
  });

  await createAuditLog(userId, 'CREATE', 'categories', created.id, null, created.toJSON(), ipAddress);
  return created;
};

/**
 * PUT /forms/categories/:id — rename/describe/(de)activate. module_id is
 * immutable here; a category is never moved to a different module (only
 * its forms move, via PUT /forms/:id/move).
 * @param {number} id
 * @param {object} data - { name?, description?, status? }
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Category>}
 */
const updateCategory = async (id, data, userId, ipAddress) => {
  const existing = await getCategoryById(id);

  const payload = {};
  if (data.name !== undefined) payload.name = data.name.trim();
  if (data.description !== undefined) payload.description = data.description ? data.description.trim() : null;
  if (data.status !== undefined) payload.status = data.status;

  if (payload.name !== undefined && payload.name !== existing.name) {
    const conflict = await categoryRepository.findByName(existing.module_id, payload.name);
    if (conflict && conflict.id !== existing.id) {
      fail('A category with this name already exists under this module.', 409);
    }
  }

  if (Object.keys(payload).length === 0) {
    return existing;
  }

  const before = existing.toJSON();
  const updated = await categoryRepository.update(id, payload);
  await createAuditLog(userId, 'UPDATE', 'categories', id, before, updated.toJSON(), ipAddress);
  return updated;
};

/**
 * DELETE /forms/categories/:id — soft-deactivates (status = 'inactive'),
 * never hard-deletes. A category with any forms assigned to it (active or
 * inactive) cannot be deactivated — forms must be moved out first (to the
 * module directly, or to another category, via PUT /forms/:id/move).
 * Mirrors the module-delete guard (deactivate() above) exactly.
 * @param {number} id
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Category>}
 */
const deactivateCategory = async (id, userId, ipAddress) => {
  const existing = await getCategoryById(id);

  const childCount = await categoryRepository.countFormsInCategory(id);
  if (childCount > 0) {
    fail(
      `Cannot delete category '${existing.name}' because it still has ${childCount} form(s) under it. Move them to the module or another category first.`,
      400
    );
  }

  return updateCategory(id, { status: 'inactive' }, userId, ipAddress);
};

/**
 * PATCH /forms/categories/reorder — bulk-assign new seq values to the
 * categories inside ONE module. Mirrors reorderModules/reorderForms.
 * @param {number} moduleId
 * @param {{id: number, seq: number}[]} items
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Category[]>} every category in the module, in its new order
 */
const reorderCategories = async (moduleId, items, userId, ipAddress) => {
  const moduleRow = await formRepository.findModuleById(moduleId);
  if (!moduleRow) {
    fail(`Module with ID ${moduleId} does not exist.`, 404);
  }

  const ids = items.map((item) => item.id);
  const rows = await categoryRepository.findByIds(ids);
  if (rows.length !== ids.length) {
    fail('One or more category IDs were not found.', 404);
  }
  if (rows.some((row) => row.module_id !== moduleId)) {
    fail('All categories being reordered must belong to the same module.', 400);
  }

  const before = rows.map((row) => ({ id: row.id, seq: row.seq }));

  const t = await sequelize.transaction();
  try {
    await categoryRepository.bulkUpdateSeq(items, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(
    userId,
    'UPDATE',
    'categories',
    null,
    { categories: before },
    { categories: items },
    ipAddress
  );

  return categoryRepository.findByModule(moduleId, 'all');
};

// ── Hierarchy (read) ─────────────────────────────────────────────────────

/**
 * GET /forms/hierarchy — the full Module -> Category -> Form tree, for the
 * Form Master listing/module-detail views (sections 12/13). Pure read
 * composition over existing module/category/form queries — no new schema.
 * @returns {Promise<object[]>} [{ ...module, categories: [{...category, forms}], forms: [uncategorized forms] }]
 */
const getHierarchy = async () => {
  const modules = await formRepository.findModules('all');

  return Promise.all(
    modules.map(async (moduleRow) => {
      const [categories, allForms] = await Promise.all([
        categoryRepository.findByModule(moduleRow.id, 'all'),
        formRepository.findFormsInModule(moduleRow.form_name, 'all'),
      ]);

      const categoriesWithForms = categories.map((category) => ({
        ...category.toJSON(),
        forms: allForms.filter((form) => form.category_id === category.id).map((form) => form.toJSON()),
      }));

      return {
        ...moduleRow.toJSON(),
        categories: categoriesWithForms,
        forms: allForms.filter((form) => form.category_id === null).map((form) => form.toJSON()),
      };
    })
  );
};

module.exports = {
  getAll: formRepository.findAll,
  getById,
  getModules: formRepository.findModules,
  create,
  update,
  moveForm,
  deactivate,
  reorderModules,
  reorderForms,
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deactivateCategory,
  reorderCategories,
  getHierarchy,
};
