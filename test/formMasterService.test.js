'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — formMasterService.js holds a live reference to this SAME
// module-cached object (it does `const formRepository = require(...)` then
// calls `formRepository.someFn(...)`, never destructures at import time),
// so mutating a property here is visible to the service's own calls. No
// mocking library needed, consistent with this repo's plain node:test setup.
const formRepository = require('../src/repositories/formMasterRepository');
const { sequelize } = require('../src/models');
const formMasterService = require('../src/services/formMasterService');

const ORIGINAL = {
  findById: formRepository.findById,
  findByIds: formRepository.findByIds,
  findByName: formRepository.findByName,
  findModuleByName: formRepository.findModuleByName,
  findModules: formRepository.findModules,
  findFormsInModule: formRepository.findFormsInModule,
  countFormsInModule: formRepository.countFormsInModule,
  getMaxModuleSeq: formRepository.getMaxModuleSeq,
  getMaxSeqInModule: formRepository.getMaxSeqInModule,
  create: formRepository.create,
  update: formRepository.update,
  updateModuleNameForChildren: formRepository.updateModuleNameForChildren,
  bulkUpdateSeq: formRepository.bulkUpdateSeq,
  transaction: sequelize.transaction,
};

function restore() {
  formRepository.findById = ORIGINAL.findById;
  formRepository.findByIds = ORIGINAL.findByIds;
  formRepository.findByName = ORIGINAL.findByName;
  formRepository.findModuleByName = ORIGINAL.findModuleByName;
  formRepository.findModules = ORIGINAL.findModules;
  formRepository.findFormsInModule = ORIGINAL.findFormsInModule;
  formRepository.countFormsInModule = ORIGINAL.countFormsInModule;
  formRepository.getMaxModuleSeq = ORIGINAL.getMaxModuleSeq;
  formRepository.getMaxSeqInModule = ORIGINAL.getMaxSeqInModule;
  formRepository.create = ORIGINAL.create;
  formRepository.update = ORIGINAL.update;
  formRepository.updateModuleNameForChildren = ORIGINAL.updateModuleNameForChildren;
  formRepository.bulkUpdateSeq = ORIGINAL.bulkUpdateSeq;
  sequelize.transaction = ORIGINAL.transaction;
}

// A fake transaction that just records commit/rollback calls — used for
// every test that exercises a code path wrapped in sequelize.transaction().
function stubTransaction() {
  const calls = { committed: false, rolledBack: false };
  sequelize.transaction = async () => ({
    commit: async () => { calls.committed = true; },
    rollback: async () => { calls.rolledBack = true; },
  });
  return calls;
}

function fakeRow(overrides) {
  const row = { id: 1, module_name: null, form_name: 'Reports', status: 'active', seq: 1, ...overrides };
  row.toJSON = () => ({ ...row });
  return row;
}

test('1. createModule assigns the next module seq and rejects a duplicate name', async () => {
  formRepository.findModuleByName = async () => null;
  formRepository.getMaxModuleSeq = async () => 2;
  let created = null;
  formRepository.create = async (data) => {
    created = fakeRow(data);
    return created;
  };

  const result = await formMasterService.create({ form_name: 'People', module_name: null, status: 'active' }, 1, '127.0.0.1');

  assert.equal(result.seq, 3);
  assert.equal(result.module_name, null);
  assert.equal(result.form_name, 'People');
  restore();
});

test('2. createModule rejects a duplicate module name', async () => {
  formRepository.findModuleByName = async () => fakeRow({ id: 9, form_name: 'Reports' });

  await assert.rejects(
    () => formMasterService.create({ form_name: 'Reports', module_name: null }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
  restore();
});

test('3. createForm assigns the next seq WITHIN its module, independent of other modules', async () => {
  formRepository.findModuleByName = async (name) => fakeRow({ id: 2, form_name: name });
  formRepository.findByName = async () => null;
  formRepository.getMaxSeqInModule = async (moduleName) => {
    assert.equal(moduleName, 'Reports');
    return 2; // Reports already has 2 forms
  };
  let created = null;
  formRepository.create = async (data) => {
    created = fakeRow(data);
    return created;
  };

  const result = await formMasterService.create(
    { form_name: 'PO Report', module_name: 'Reports', status: 'active' },
    1,
    '127.0.0.1'
  );

  assert.equal(result.seq, 3);
  assert.equal(result.module_name, 'Reports');
  restore();
});

test('4. createForm rejects when the referenced module does not exist', async () => {
  formRepository.findModuleByName = async () => null;

  await assert.rejects(
    () => formMasterService.create({ form_name: 'Orphan Report', module_name: 'Ghost' }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('5. update() rejects turning a module into a form', async () => {
  formRepository.findById = async () => fakeRow({ id: 1, module_name: null, form_name: 'Reports' });

  await assert.rejects(
    () => formMasterService.update(1, { module_name: 'Administration' }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('6. update() rejects turning a form into a module', async () => {
  formRepository.findById = async () => fakeRow({ id: 5, module_name: 'Reports', form_name: 'PO Report' });

  await assert.rejects(
    () => formMasterService.update(5, { module_name: null }, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('7. Renaming a module cascades module_name to every one of its children, transactionally', async () => {
  const existing = fakeRow({ id: 1, module_name: null, form_name: 'Reports' });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async () => null; // no conflict with the new name

  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };

  let cascadeArgs = null;
  formRepository.updateModuleNameForChildren = async (oldName, newName) => {
    cascadeArgs = { oldName, newName };
    return 2;
  };

  const txnCalls = stubTransaction();

  const result = await formMasterService.update(1, { form_name: 'Reporting' }, 1, '127.0.0.1');

  assert.equal(updatedPayload.form_name, 'Reporting');
  assert.deepEqual(cascadeArgs, { oldName: 'Reports', newName: 'Reporting' });
  assert.equal(txnCalls.committed, true);
  assert.equal(result.form_name, 'Reporting');
  restore();
});

test('8. Moving a form to a different module assigns the next seq in the DESTINATION module', async () => {
  const existing = fakeRow({ id: 10, module_name: 'Reports', form_name: 'Report B', seq: 2 });
  formRepository.findById = async () => existing;
  formRepository.findModuleByName = async (name) => fakeRow({ id: 3, form_name: name });
  formRepository.findByName = async () => null;
  formRepository.getMaxSeqInModule = async (moduleName) => {
    assert.equal(moduleName, 'Administration');
    return 0; // Administration has no forms yet
  };

  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };

  const result = await formMasterService.update(10, { module_name: 'Administration' }, 1, '127.0.0.1');

  assert.equal(updatedPayload.module_name, 'Administration');
  assert.equal(updatedPayload.seq, 1);
  assert.equal(result.seq, 1);
  restore();
});

test('9. Renaming a form WITHOUT moving it leaves seq untouched', async () => {
  const existing = fakeRow({ id: 11, module_name: 'Reports', form_name: 'Report A', seq: 1 });
  formRepository.findById = async () => existing;
  formRepository.findByName = async () => null;

  let updatedPayload = null;
  formRepository.update = async (id, payload) => {
    updatedPayload = payload;
    return fakeRow({ ...existing, ...payload });
  };

  await formMasterService.update(11, { form_name: 'Report A Renamed' }, 1, '127.0.0.1');

  assert.equal('seq' in updatedPayload, false);
  restore();
});

test('10. deactivate() blocks deleting a module that still has forms', async () => {
  formRepository.findById = async () => fakeRow({ id: 1, module_name: null, form_name: 'Reports' });
  formRepository.countFormsInModule = async () => 3;

  await assert.rejects(
    () => formMasterService.deactivate(1, 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /still has 3 form\(s\)/);
      return true;
    }
  );
  restore();
});

test('11. deactivate() allows deleting a module with zero forms', async () => {
  const existing = fakeRow({ id: 1, module_name: null, form_name: 'Reports', status: 'active' });
  formRepository.findById = async () => existing;
  formRepository.countFormsInModule = async () => 0;
  formRepository.findModuleByName = async () => null;
  formRepository.update = async (id, payload) => fakeRow({ ...existing, ...payload });

  const result = await formMasterService.deactivate(1, 1, '127.0.0.1');

  assert.equal(result.status, 'inactive');
  restore();
});

test('12. deactivate() never blocks deactivating a plain form', async () => {
  const existing = fakeRow({ id: 12, module_name: 'Reports', form_name: 'PO Report', status: 'active' });
  formRepository.findById = async () => existing;
  formRepository.findByName = async () => null;
  formRepository.update = async (id, payload) => fakeRow({ ...existing, ...payload });

  const result = await formMasterService.deactivate(12, 1, '127.0.0.1');

  assert.equal(result.status, 'inactive');
  restore();
});

test('13. reorderModules rejects when one of the ids is not a module row', async () => {
  formRepository.findByIds = async () => [
    fakeRow({ id: 1, module_name: null, form_name: 'Reports' }),
    fakeRow({ id: 12, module_name: 'Reports', form_name: 'PO Report' }), // a CHILD form, not a module
  ];

  await assert.rejects(
    () => formMasterService.reorderModules([{ id: 1, seq: 1 }, { id: 12, seq: 2 }], 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  restore();
});

test('14. reorderModules rejects when an id does not exist', async () => {
  formRepository.findByIds = async () => [fakeRow({ id: 1, module_name: null, form_name: 'Reports' })];

  await assert.rejects(
    () => formMasterService.reorderModules([{ id: 1, seq: 1 }, { id: 999, seq: 2 }], 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

test('15. reorderModules commits a bulk seq update for valid modules', async () => {
  formRepository.findByIds = async () => [
    fakeRow({ id: 1, module_name: null, form_name: 'Reports', seq: 1 }),
    fakeRow({ id: 2, module_name: null, form_name: 'Administration', seq: 2 }),
  ];
  let bulkItems = null;
  formRepository.bulkUpdateSeq = async (items) => { bulkItems = items; };
  formRepository.findModules = async () => [
    fakeRow({ id: 2, module_name: null, form_name: 'Administration', seq: 1 }),
    fakeRow({ id: 1, module_name: null, form_name: 'Reports', seq: 2 }),
  ];
  const txnCalls = stubTransaction();

  const items = [{ id: 1, seq: 2 }, { id: 2, seq: 1 }];
  const result = await formMasterService.reorderModules(items, 1, '127.0.0.1');

  assert.deepEqual(bulkItems, items);
  assert.equal(txnCalls.committed, true);
  assert.equal(result[0].form_name, 'Administration');
  restore();
});

test('16. reorderForms rejects a form that belongs to a DIFFERENT module', async () => {
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByIds = async () => [
    fakeRow({ id: 9, module_name: 'Reports', form_name: 'Report A' }),
    fakeRow({ id: 20, module_name: 'Administration', form_name: 'Roles' }), // wrong module
  ];

  await assert.rejects(
    () => formMasterService.reorderForms('Reports', [{ id: 9, seq: 1 }, { id: 20, seq: 2 }], 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /same module/);
      return true;
    }
  );
  restore();
});

test('17. reorderForms 404s when the module itself does not exist', async () => {
  formRepository.findModuleByName = async () => null;

  await assert.rejects(
    () => formMasterService.reorderForms('Ghost', [{ id: 9, seq: 1 }], 1, '127.0.0.1'),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

test('18. reorderForms commits a bulk seq update scoped to one module', async () => {
  formRepository.findModuleByName = async (name) => fakeRow({ id: 1, module_name: null, form_name: name });
  formRepository.findByIds = async () => [
    fakeRow({ id: 9, module_name: 'Reports', form_name: 'Report A', seq: 1 }),
    fakeRow({ id: 10, module_name: 'Reports', form_name: 'Report B', seq: 2 }),
  ];
  let bulkItems = null;
  formRepository.bulkUpdateSeq = async (items) => { bulkItems = items; };
  formRepository.findFormsInModule = async () => [
    fakeRow({ id: 10, module_name: 'Reports', form_name: 'Report B', seq: 1 }),
    fakeRow({ id: 9, module_name: 'Reports', form_name: 'Report A', seq: 2 }),
  ];
  const txnCalls = stubTransaction();

  const items = [{ id: 10, seq: 1 }, { id: 9, seq: 2 }];
  const result = await formMasterService.reorderForms('Reports', items, 1, '127.0.0.1');

  assert.deepEqual(bulkItems, items);
  assert.equal(txnCalls.committed, true);
  assert.equal(result[0].form_name, 'Report B');
  restore();
});
