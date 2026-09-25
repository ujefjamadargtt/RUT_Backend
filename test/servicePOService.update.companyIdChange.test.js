'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: PUT /service-pos/:id silently ignored a changed company_id —
// updateServicePOSchema had no company_id key, so validateRequest's
// stripUnknown dropped it before it ever reached servicePOService.update().
// Same monkey-patch style as test/servicePOService.centralisedPO.test.js.
const servicePORepository = require('../src/repositories/servicePORepository');
const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const { sequelize } = require('../src/models');
const servicePOService = require('../src/services/servicePOService');
const { updateServicePOSchema } = require('../src/validations/servicePOValidation');

const ORIGINAL = {
  findById: servicePORepository.findById,
  findByCode: servicePORepository.findByCode,
  findByName: servicePORepository.findByName,
  update: servicePORepository.update,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  projectFindByIdUnscoped: projectRepository.findByIdUnscoped,
  moveServicePOToCompany: employeeServicePOMappingRepository.moveServicePOToCompany,
  transaction: sequelize.transaction,
};

function restore() {
  servicePORepository.findById = ORIGINAL.findById;
  servicePORepository.findByCode = ORIGINAL.findByCode;
  servicePORepository.findByName = ORIGINAL.findByName;
  servicePORepository.update = ORIGINAL.update;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  projectRepository.findByIdUnscoped = ORIGINAL.projectFindByIdUnscoped;
  employeeServicePOMappingRepository.moveServicePOToCompany = ORIGINAL.moveServicePOToCompany;
  sequelize.transaction = ORIGINAL.transaction;
}

// Multi-BU BU Admin mapped to BUs 42 and 43, active header BU 42.
function fakeReq() {
  return {
    companyId: 42,
    hierarchyRank: 4,
    employeeBusinessUnits: [{ id: 42 }, { id: 43 }],
    headers: {},
    ip: '127.0.0.1',
  };
}

const EXISTING = {
  id: 152,
  company_id: 42,
  status: 'in-progress',
  service_po_code: 'PO-152',
  service_po_name: 'PO One Five Two',
  client_id: 10,
  project_id: 20,
  delivery_head_employee_id: null,
};

function stubHappyPath() {
  servicePORepository.findById = async () => ({ ...EXISTING });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: null });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: null });
  sequelize.transaction = async (fn) => fn({ fake: true });
}

test('updateServicePOSchema keeps company_id (no longer stripped)', () => {
  const { value, error } = updateServicePOSchema.validate(
    { company_id: 43, status: 'in-progress' },
    { stripUnknown: true }
  );
  assert.equal(error, undefined);
  assert.equal(value.company_id, 43);
});

test('update(): a changed company_id is persisted, scoped by the OLD BU, and mappings move with it', async () => {
  stubHappyPath();

  let captured;
  servicePORepository.update = async (id, payload, companyId, options) => {
    captured = { id, payload, companyId, options };
    return { ...EXISTING, ...payload };
  };
  let moved;
  employeeServicePOMappingRepository.moveServicePOToCompany = async (...args) => {
    moved = args;
    return 3;
  };

  try {
    const updated = await servicePOService.update(152, { company_id: 43, status: 'in-progress' }, 1, fakeReq());

    assert.equal(updated.company_id, 43);
    assert.equal(captured.payload.company_id, 43);
    assert.equal(captured.companyId, 42); // WHERE still matches the row's current BU
    assert.deepEqual(captured.options, { transaction: { fake: true } });
    assert.deepEqual(moved.slice(0, 4), [152, 42, 43, 1]);
  } finally {
    restore();
  }
});

test('update(): moving to a BU the actor is not mapped to is 403', async () => {
  stubHappyPath();
  servicePORepository.update = async () => assert.fail('must not persist');

  try {
    await assert.rejects(
      servicePOService.update(152, { company_id: 99 }, 1, fakeReq()),
      (err) => err.statusCode === 403
    );
  } finally {
    restore();
  }
});

test('update(): moving BU re-checks code uniqueness in the TARGET BU', async () => {
  stubHappyPath();
  let codeLookupCompany;
  servicePORepository.findByCode = async (code, companyId) => {
    codeLookupCompany = companyId;
    return { id: 777 };
  };
  servicePORepository.update = async () => assert.fail('must not persist');

  try {
    await assert.rejects(
      servicePOService.update(152, { company_id: 43 }, 1, fakeReq()),
      (err) => err.statusCode === 409
    );
    assert.equal(codeLookupCompany, 43);
  } finally {
    restore();
  }
});

test('update(): moving BU rejects a client that belongs to a different BU', async () => {
  stubHappyPath();
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 42 });
  servicePORepository.update = async () => assert.fail('must not persist');

  try {
    // 42 and 43 are unrelated BUs here, so client (BU 42) no longer fits BU 43.
    await assert.rejects(
      servicePOService.update(152, { company_id: 43 }, 1, fakeReq()),
      (err) => err.statusCode === 404 || err.statusCode === 400
    );
  } finally {
    restore();
  }
});

test('update(): same company_id as current is a no-op for BU (no transaction, no mapping move)', async () => {
  stubHappyPath();
  sequelize.transaction = async () => assert.fail('no transaction expected');
  employeeServicePOMappingRepository.moveServicePOToCompany = async () => assert.fail('no move expected');
  servicePORepository.update = async (id, payload) => ({ ...EXISTING, ...payload });

  try {
    const updated = await servicePOService.update(152, { company_id: 42, status: 'on-hold' }, 1, fakeReq());
    assert.equal(updated.company_id, 42);
    assert.equal(updated.status, 'on-hold');
  } finally {
    restore();
  }
});
