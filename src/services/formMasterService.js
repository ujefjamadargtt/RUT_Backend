'use strict';

const formRepository = require('../repositories/formMasterRepository');
const { createAuditLog } = require('../middlewares/auditLog');

const getById = async (id) => {
  const form = await formRepository.findById(id);
  if (!form) {
    const err = new Error(`Form with ID ${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return form;
};

const assertUnique = async (data, excludeId) => {
  if (!data.module_name || !data.form_name) return;
  const existing = await formRepository.findByName(data.module_name, data.form_name);
  if (existing && existing.id !== excludeId) {
    const err = new Error('A form with this module name and form name already exists.');
    err.statusCode = 409;
    throw err;
  }
};

const create = async (data, userId, ipAddress) => {
  await assertUnique(data);
  const form = await formRepository.create(data);
  await createAuditLog(userId, 'CREATE', 'form_master', form.id, null, form.toJSON(), ipAddress);
  return form;
};

const update = async (id, data, userId, ipAddress) => {
  const existing = await getById(id);
  const merged = { ...existing.toJSON(), ...data };
  await assertUnique(merged, id);
  const updated = await formRepository.update(id, data);
  await createAuditLog(userId, 'UPDATE', 'form_master', id, existing.toJSON(), updated.toJSON(), ipAddress);
  return updated;
};

const deactivate = async (id, userId, ipAddress) => update(id, { status: 'inactive' }, userId, ipAddress);

module.exports = { getAll: formRepository.findAll, getById, create, update, deactivate };
