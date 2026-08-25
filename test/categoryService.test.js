'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as formMasterService.test.js: mutate the
// module-cached repository objects that formMasterService.js holds a live
// reference to, no mocking library needed.
const categoryRepository = require('../src/repositories/categoryRepository');
const formRepository = require('../src/repositories/formMasterRepository');
const { sequelize } = require('../src/models');
const formMasterService = require('../src/services/formMasterService');

const ORIGINAL = {
  cat_findAll: categoryRepository.findAll,
  cat_findById: categoryRepository.findById,
  cat_findByIds: categoryRepository.findByIds,
  cat_findByName: categoryRepository.findByName,
  cat_findByModule: categoryRepository.findByModule,
  cat_countFormsInCategory: categoryRepository.countFormsInCategory,
  cat_getMaxSeqInModule: categoryRepository.getMaxSeqInModule,
  cat_create: categoryRepository.create,
  cat_update: categoryRepository.update,
  cat_bulkUpdateSeq: categoryRepository.bulkUpdateSeq,
  form_findModuleById: formRepository.findModuleById,
  transaction: sequelize.transaction,
};

function restore() {
  categoryRepository.findAll = ORIGINAL.cat_findAll;
  categoryRepository.findById = ORIGINAL.cat_findById;
  categoryRepository.findByIds = ORIGINAL.cat_findByIds;
  categoryRepository.findByName = ORIGINAL.cat_findByName;
  categoryRepository.findByModule = ORIGINAL.cat_findByModule;
  categoryRepository.countFormsInCategory = ORIGINAL.cat_countFormsInCategory;
  categoryRepository.getMaxSeqInModule = ORIGINAL.cat_getMaxSeqInModule;
  categoryRepository.create = ORIGINAL.cat_create;
  categoryRepository.update = ORIGINAL.cat_update;
  categoryRepository.bulkUpdateSeq = ORIGINAL.cat_bulkUpdateSeq;
  formRepository.findModuleById = ORIGINAL.form_findModuleById;
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

function fakeModuleRow(overrides) {
  const row = { id: 1, module_name: null, form_name: 'Reports', status: 'active', seq: 1, ...overrides };
  row.toJSON = () => ({ ...row });
  return row;
}

function fakeCategory(overrides) {
  const row = { id: 1, module_id: 1, name: 'Financial Reports', description: null, status: 'active', seq: 1, ...overrides };
  row.toJSON = () => ({ ...row });
  return row;
}

test('createCategory assigns the next seq within its module and rejects a duplicate name', async () => {
  formRepository.findModuleById = async (id) => fakeModuleRow({ id });
  categoryRepository.findByName = async () => null;
  categoryRepository.getMaxSeqInModule = async (moduleId) => {
    assert.equal(moduleId, 1);
    return 2;
  };
  let created = null;
  categoryRepository.create = async (data) => {
    created = fakeCategory(data);
    return created;
  };

  const result = await formMasterService.createCategory(
    { module_id: 1, name: 'Operational Reports', status: 'active' },
    1,
    '127.0.0.1'
  );

  assert.equal(result.seq, 3);
  assert.equal(result.module_id, 1);
  restore();
});

test('createCategory rejects when the referenced module does not exist', async () => {
  formRepository.findModuleById = async () => null;

  await assert.rejects(
    () => formMasterService.createCategory({ module_id: 99, name: 'Ghost' }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('createCategory rejects a duplicate name under the same module', async () => {
  formRepository.findModuleById = async (id) => fakeModuleRow({ id });
  categoryRepository.findByName = async () => fakeCategory({ id: 5 });

  await assert.rejects(
    () => formMasterService.createCategory({ module_id: 1, name: 'Financial Reports' }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
  restore();
});

test('updateCategory rejects renaming into a conflicting name under the same module', async () => {
  const existing = fakeCategory({ id: 1, module_id: 1, name: 'Financial Reports' });
  categoryRepository.findById = async () => existing;
  categoryRepository.findByName = async () => fakeCategory({ id: 2, name: 'Operational Reports' });

  await assert.rejects(
    () => formMasterService.updateCategory(1, { name: 'Operational Reports' }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
  restore();
});

test('deactivateCategory blocks deleting a category that still has forms', async () => {
  categoryRepository.findById = async () => fakeCategory({ id: 1 });
  categoryRepository.countFormsInCategory = async () => 2;

  await assert.rejects(
    () => formMasterService.deactivateCategory(1, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /still has 2 form\(s\)/);
      return true;
    }
  );
  restore();
});

test('deactivateCategory allows deleting a category with zero forms', async () => {
  const existing = fakeCategory({ id: 1, status: 'active' });
  categoryRepository.findById = async () => existing;
  categoryRepository.countFormsInCategory = async () => 0;
  categoryRepository.findByName = async () => null;
  categoryRepository.update = async (id, payload) => fakeCategory({ ...existing, ...payload });

  const result = await formMasterService.deactivateCategory(1, 1, '127.0.0.1');

  assert.equal(result.status, 'inactive');
  restore();
});

test('reorderCategories rejects a category that belongs to a DIFFERENT module', async () => {
  formRepository.findModuleById = async (id) => fakeModuleRow({ id });
  categoryRepository.findByIds = async () => [
    fakeCategory({ id: 1, module_id: 1 }),
    fakeCategory({ id: 2, module_id: 2 }), // wrong module
  ];

  await assert.rejects(
    () => formMasterService.reorderCategories(1, [{ id: 1, seq: 1 }, { id: 2, seq: 2 }], 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /same module/);
      return true;
    }
  );
  restore();
});

test('reorderCategories 404s when the module itself does not exist', async () => {
  formRepository.findModuleById = async () => null;

  await assert.rejects(
    () => formMasterService.reorderCategories(99, [{ id: 1, seq: 1 }], 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

test('reorderCategories commits a bulk seq update scoped to one module', async () => {
  formRepository.findModuleById = async (id) => fakeModuleRow({ id });
  categoryRepository.findByIds = async () => [
    fakeCategory({ id: 1, module_id: 1, seq: 1 }),
    fakeCategory({ id: 2, module_id: 1, seq: 2 }),
  ];
  let bulkItems = null;
  categoryRepository.bulkUpdateSeq = async (items) => { bulkItems = items; };
  categoryRepository.findByModule = async () => [
    fakeCategory({ id: 2, module_id: 1, seq: 1 }),
    fakeCategory({ id: 1, module_id: 1, seq: 2 }),
  ];
  const txnCalls = stubTransaction();

  const items = [{ id: 2, seq: 1 }, { id: 1, seq: 2 }];
  const result = await formMasterService.reorderCategories(1, items, 1, '127.0.0.1');

  assert.deepEqual(bulkItems, items);
  assert.equal(txnCalls.committed, true);
  assert.equal(result[0].id, 2);
  restore();
});
