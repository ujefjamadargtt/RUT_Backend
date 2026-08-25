'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as formMasterService.test.js / categoryService.test.js.
const formRepository = require('../src/repositories/formMasterRepository');
const categoryRepository = require('../src/repositories/categoryRepository');
const { sequelize } = require('../src/models');
const formMasterService = require('../src/services/formMasterService');

const ORIGINAL = {
  form_findById: formRepository.findById,
  form_findByName: formRepository.findByName,
  form_findModuleByName: formRepository.findModuleByName,
  form_findModuleById: formRepository.findModuleById,
  form_getMaxSeqInModule: formRepository.getMaxSeqInModule,
  form_create: formRepository.create,
  form_update: formRepository.update,
  cat_findById: categoryRepository.findById,
  transaction: sequelize.transaction,
};

function restore() {
  formRepository.findById = ORIGINAL.form_findById;
  formRepository.findByName = ORIGINAL.form_findByName;
  formRepository.findModuleByName = ORIGINAL.form_findModuleByName;
  formRepository.findModuleById = ORIGINAL.form_findModuleById;
  formRepository.getMaxSeqInModule = ORIGINAL.form_getMaxSeqInModule;
  formRepository.create = ORIGINAL.form_create;
  formRepository.update = ORIGINAL.form_update;
  categoryRepository.findById = ORIGINAL.cat_findById;
  sequelize.transaction = ORIGINAL.transaction;
}

function stubTransaction() {
  const calls = { committed: false, rolledBack: false };
  sequelize.transaction = async () => ({
    commit: async () => { calls.committed = true; },
    rollback: async () => { calls.rolledBack = true; },
  });
  return calls;
}

function fakeRow(overrides) {
  const row = { id: 1, module_name: null, form_name: 'Reports', status: 'active', seq: 1, category_id: null, ...overrides };
  row.toJSON = () => ({ ...row });
  return row;
}

function fakeCategory(overrides) {
  const row = { id: 1, module_id: 1, name: 'Financial Reports', status: 'active', seq: 1, ...overrides };
  row.toJSON = () => ({ ...row });
  return row;
}

// ── createForm with category_id ─────────────────────────────────────────

test('createForm accepts a category_id belonging to the same module', async () => {
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  categoryRepository.findById = async () => fakeCategory({ id: 5, module_id: 1 });
  formRepository.getMaxSeqInModule = async () => 0;
  let created = null;
  formRepository.create = async (data) => {
    created = fakeRow(data);
    return created;
  };

  const result = await formMasterService.create(
    { form_name: 'Sales Report', module_name: 'Reports', category_id: 5 },
    1,
    '127.0.0.1'
  );

  assert.equal(result.category_id, 5);
  restore();
});

test('createForm rejects a category_id that belongs to a DIFFERENT module', async () => {
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  categoryRepository.findById = async () => fakeCategory({ id: 5, module_id: 2 }); // wrong module

  await assert.rejects(
    () => formMasterService.create({ form_name: 'Sales Report', module_name: 'Reports', category_id: 5 }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('createForm rejects a non-existent category_id', async () => {
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  categoryRepository.findById = async () => null;

  await assert.rejects(
    () => formMasterService.create({ form_name: 'Sales Report', module_name: 'Reports', category_id: 999 }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

// ── moveForm ─────────────────────────────────────────────────────────────

test('moveForm rejects trying to move a module row', async () => {
  formRepository.findById = async () => fakeRow({ id: 1, module_name: null, form_name: 'Reports' });

  await assert.rejects(
    () => formMasterService.moveForm(1, { category_id: null }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('moveForm: Module -> Category assigns the category within the same module', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Sales Report', category_id: null, seq: 1 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  categoryRepository.findById = async () => fakeCategory({ id: 5, module_id: 1 });
  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };
  stubTransaction();

  const result = await formMasterService.moveForm(10, { category_id: 5 }, 1, '127.0.0.1');

  assert.equal(updatedPayload.category_id, 5);
  assert.equal('module_name' in updatedPayload, false);
  assert.equal(result.category_id, 5);
  restore();
});

test('moveForm: Category -> Module clears the category (category_id: null)', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Sales Report', category_id: 5, seq: 1 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };
  stubTransaction();

  const result = await formMasterService.moveForm(10, { category_id: null }, 1, '127.0.0.1');

  assert.equal(updatedPayload.category_id, null);
  assert.equal(result.category_id, null);
  restore();
});

test('moveForm: Category A -> Category B within the same module', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Sales Report', category_id: 5, seq: 1 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  categoryRepository.findById = async () => fakeCategory({ id: 8, module_id: 1, name: 'Operational Reports' });
  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };
  stubTransaction();

  const result = await formMasterService.moveForm(10, { category_id: 8 }, 1, '127.0.0.1');

  assert.equal(updatedPayload.category_id, 8);
  assert.equal(result.category_id, 8);
  restore();
});

test('moveForm: moving to a different module WITHOUT an explicit category resets category to null', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Sales Report', category_id: 5, seq: 3 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async () => fakeRow({ id: 1, module_name: null, form_name: 'Reports' });
  formRepository.findModuleById = async (id) => fakeRow({ id, module_name: null, form_name: 'Administration' });
  formRepository.findByName = async () => null;
  formRepository.getMaxSeqInModule = async (moduleName) => {
    assert.equal(moduleName, 'Administration');
    return 0;
  };
  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };
  stubTransaction();

  const result = await formMasterService.moveForm(10, { module_id: 2 }, 1, '127.0.0.1');

  assert.equal(updatedPayload.module_name, 'Administration');
  assert.equal(updatedPayload.category_id, null);
  assert.equal(updatedPayload.seq, 1);
  assert.equal(result.module_name, 'Administration');
  restore();
});

test('moveForm rejects a destination category that belongs to a different module than the destination module', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Sales Report', category_id: 5, seq: 3 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async () => fakeRow({ id: 1, module_name: null, form_name: 'Reports' });
  formRepository.findModuleById = async (id) => fakeRow({ id, module_name: null, form_name: 'Administration' });
  categoryRepository.findById = async () => fakeCategory({ id: 5, module_id: 1 }); // belongs to the OLD module

  await assert.rejects(
    () => formMasterService.moveForm(10, { module_id: 2, category_id: 5 }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('moveForm rolls back and leaves the form unchanged when the write fails', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Sales Report', category_id: null, seq: 1 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByName = async () => null;
  categoryRepository.findById = async () => fakeCategory({ id: 5, module_id: 1 });
  formRepository.update = async () => {
    throw new Error('DB write failed');
  };
  const txnCalls = stubTransaction();

  await assert.rejects(
    () => formMasterService.moveForm(10, { category_id: 5 }, 1, '127.0.0.1'),
    /DB write failed/
  );
  assert.equal(txnCalls.rolledBack, true);
  assert.equal(txnCalls.committed, false);
  restore();
});
