'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/servicePOService.deliveryHeadOptional.test.js.
const servicePORepository = require('../src/repositories/servicePORepository');
const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const aiInsightService = require('../src/services/aiInsight.service');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const { sequelize } = require('../src/models');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  findByCode: servicePORepository.findByCode,
  findByName: servicePORepository.findByName,
  create: servicePORepository.create,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  projectFindByIdUnscoped: projectRepository.findByIdUnscoped,
  runJob: aiInsightService.runJob,
  autoMapExisting: employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO,
  transaction: sequelize.transaction,
};

function restore() {
  servicePORepository.findByCode = ORIGINAL.findByCode;
  servicePORepository.findByName = ORIGINAL.findByName;
  servicePORepository.create = ORIGINAL.create;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  projectRepository.findByIdUnscoped = ORIGINAL.projectFindByIdUnscoped;
  aiInsightService.runJob = ORIGINAL.runJob;
  employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = ORIGINAL.autoMapExisting;
  sequelize.transaction = ORIGINAL.transaction;
}

function stubUnderivableBU() {
  const { Company } = require('../src/models');
  const entityRepository = require('../src/repositories/entityRepository');
  const originalCompanyFindAll = Company.findAll;
  const originalFindIdsOwnedByAdmin = entityRepository.findIdsOwnedByAdmin;
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: null });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: null });
  entityRepository.findIdsOwnedByAdmin = async () => [1];
  Company.findAll = async () => [{ id: 10 }, { id: 11 }];
  return () => {
    Company.findAll = originalCompanyFindAll;
    entityRepository.findIdsOwnedByAdmin = originalFindIdsOwnedByAdmin;
  };
}

function companyLessReq() {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 1, headers: {}, ip: '127.0.0.1' };
}

function basePayload(overrides = {}) {
  return {
    service_po_code: 'PO-CENT-NOBU-1',
    service_po_name: 'Centralised No-BU PO',
    client_id: 10,
    project_id: 20,
    service_type_id: 1,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    ...overrides,
  };
}

test('create(): a centralised PO (is_centralised: true) may omit company_id entirely and persists company_id: null', async () => {
  // A BU-less centralised PO's Client/Project must themselves be BU-less
  // too (belongsToCompanyOrUnassigned degenerates to that when companyId
  // is null) — unchanged existing behavior, just exercised here.
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: null });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: null });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  // Real pass-through transaction (not stopped early) — execution must
  // actually reach the auto-map call, same pattern as
  // employeeService.autoMapCentralisedCall.test.js's stubCommonCreatePath().
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = async () => {};

  let capturedPayload;
  servicePORepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };

  const po = await servicePOService.create(
    basePayload({ is_centralised: true }),
    1,
    companyLessReq()
  );

  assert.equal(capturedPayload.company_id, null);
  assert.equal(po.company_id, null);

  restore();
});

test('create(): is_centralised: true -> calls autoMapExistingEmployeesToCentralisedServicePO once with the new PO id, its resolved company_id, and the creating actor, inside the same transaction', async () => {
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: null });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: null });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  servicePORepository.create = async (payload) => ({ id: 42, ...payload });

  const calls = [];
  employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = async (servicePOId, companyId, userId, transaction) => {
    calls.push({ servicePOId, companyId, userId, transaction });
  };

  await servicePOService.create(basePayload({ is_centralised: true }), 1, companyLessReq());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].servicePOId, 42);
  assert.equal(calls[0].companyId, null);
  assert.equal(calls[0].userId, 1);
  assert.ok(calls[0].transaction.__fakeTransaction);

  restore();
});

test('create(): a NON-centralised PO never calls autoMapExistingEmployeesToCentralisedServicePO', async () => {
  const req = { companyId: 10, hierarchyRank: 4, employeeId: 99, headers: {}, ip: '127.0.0.1' };
  clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 10 });
  projectRepository.findByIdUnscoped = async () => ({ id: 20, status: 'active', client_id: 10, company_id: 10 });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  servicePORepository.create = async (payload) => ({ id: 43, ...payload });
  employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = async () => {
    throw new Error('must not be reached — is_centralised is false');
  };

  await servicePOService.create(basePayload({ is_centralised: false }), 99, req);

  restore();
});

test('create(): a NON-centralised "My Clients" PO from a company-less actor (BU-less Client/Project, no company_id) is saved BU-less and never auto-maps', async () => {
  // Nothing to derive a BU from: BU-less Client/Project, an Admin owning
  // SEVERAL BUs. The PO must stay BU-less — never a guessed/active BU.
  const restoreOwnership = stubUnderivableBU();
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = async () => assert.fail('a normal PO never auto-maps');
  let capturedPayload;
  servicePORepository.create = async (payload) => { capturedPayload = payload; return { id: 2, ...payload }; };

  await servicePOService.create(basePayload({ is_centralised: false }), 1, companyLessReq());
  assert.equal(capturedPayload.company_id, null);

  restoreOwnership();
  restore();
});

test('create(): is_centralised omitted (Joi default false) behaves the same as explicit false — BU-less "My Clients" PO saved with company_id NULL', async () => {
  const restoreOwnership = stubUnderivableBU();
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  let capturedPayload;
  servicePORepository.create = async (payload) => { capturedPayload = payload; return { id: 3, ...payload }; };

  await servicePOService.create(basePayload({ service_po_code: 'PO-CENT-NOBU-3' }), 1, companyLessReq());
  assert.equal(capturedPayload.company_id, null);

  restoreOwnership();
  restore();
});
