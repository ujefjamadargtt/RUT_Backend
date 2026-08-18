'use strict';

const { sequelize } = require('../models');
const formRepository = require('../repositories/formMasterRepository');
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

  const maxSeq = await formRepository.getMaxSeqInModule(data.module_name);
  const created = await formRepository.create({
    module_name: data.module_name.trim(),
    form_name: data.form_name.trim(),
    status: data.status || 'active',
    seq: maxSeq + 1,
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

module.exports = {
  getAll: formRepository.findAll,
  getById,
  getModules: formRepository.findModules,
  create,
  update,
  deactivate,
  reorderModules,
  reorderForms,
};
