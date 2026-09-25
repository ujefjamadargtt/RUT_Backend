'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/servicePOService.centralisedPO.test.js.
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  getActiveCentralisedPOIds: servicePORepository.getActiveCentralisedPOIds,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
  resolveCompanyIdsOwnedByCreator: companyAccessControlService.resolveCompanyIdsOwnedByCreator,
  resolveCentralisedServicePOTenant: companyAccessControlService.resolveCentralisedServicePOTenant,
};

function restore() {
  servicePORepository.getActiveCentralisedPOIds = ORIGINAL.getActiveCentralisedPOIds;
  employeeServicePOMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = ORIGINAL.resolveCompanyIdsOwnedByCreator;
  companyAccessControlService.resolveCentralisedServicePOTenant = ORIGINAL.resolveCentralisedServicePOTenant;
}

// A Centralised Service PO is for every Employee of its OWN Admin tenant,
// never another Admin's — autoMapCentralisedServicePOs() resolves that
// tenant (companyAccessControlService.resolveCentralisedServicePOTenant())
// and servicePORepository.getActiveCentralisedPOIds() only returns its POs.

const TENANT_A = { companyIds: [10, 11], ownerIds: [1, 5] };

test('autoMapCentralisedServicePOs(): the new Employee\'s BU seeds the tenant, and every Centralised PO of THAT tenant is mapped (per-company keeps its company_id, BU-less maps as null)', async () => {
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async () => {
    throw new Error('must not be reached — the Employee has a Business Unit');
  };
  companyAccessControlService.resolveCentralisedServicePOTenant = async (companyIds, actorId) => {
    assert.deepEqual(companyIds, [10]);
    assert.equal(actorId, 1);
    return TENANT_A;
  };
  servicePORepository.getActiveCentralisedPOIds = async (tenant) => {
    assert.deepEqual(tenant, TENANT_A);
    return [
      { id: 501, company_id: 10, created_by: 5 },
      { id: 999, company_id: null, created_by: 5 },
    ];
  };

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, 10, 1, undefined);

  assert.equal(capturedRecords.length, 2);
  assert.equal(capturedRecords.find((r) => r.service_po_id === 501).company_id, 10);
  assert.equal(capturedRecords.find((r) => r.service_po_id === 999).company_id, null);
  assert.ok(capturedRecords.every((r) => r.employee_id === 77));

  restore();
});

test('autoMapCentralisedServicePOs(): a company-less Employee (no BU) seeds the tenant from the CREATING Admin\'s own Companies', async () => {
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async (creatorId) => {
    assert.equal(creatorId, 1);
    return [10, 11];
  };
  companyAccessControlService.resolveCentralisedServicePOTenant = async (companyIds, actorId) => {
    assert.deepEqual(companyIds, [10, 11]);
    assert.equal(actorId, 1);
    return TENANT_A;
  };
  servicePORepository.getActiveCentralisedPOIds = async () => [{ id: 999, company_id: null, created_by: 1 }];

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, null, 1, undefined);

  assert.deepEqual(capturedRecords.map((r) => r.service_po_id), [999]);
  restore();
});

test('autoMapCentralisedServicePOs(): no Centralised PO in this tenant -> no insert attempted', async () => {
  companyAccessControlService.resolveCentralisedServicePOTenant = async () => TENANT_A;
  servicePORepository.getActiveCentralisedPOIds = async () => [];
  employeeServicePOMappingRepository.bulkCreate = async () => {
    throw new Error('must not be reached — nothing to insert');
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, 10, 1, undefined);
  restore();
});

test('getActiveCentralisedPOIds(): scoped to the given tenant (its BUs, or BU-less POs created by its owners) — never platform-wide', async () => {
  const { Op } = require('sequelize');
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedWhere;
  ServicePO.findAll = async (args) => {
    capturedWhere = args.where;
    return [];
  };

  await servicePORepository.getActiveCentralisedPOIds(TENANT_A);

  assert.equal(capturedWhere.is_centralised, true);
  assert.deepEqual(capturedWhere[Op.or], [
    { company_id: { [Op.in]: [10, 11] } },
    { company_id: null, created_by: { [Op.in]: [1, 5] } },
  ]);

  ServicePO.findAll = originalFindAll;
});

test('getActiveCentralisedPOIds(): no tenant / empty tenant fails closed (returns [] without querying)', async () => {
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;
  ServicePO.findAll = async () => { throw new Error('must not query without a tenant'); };

  assert.deepEqual(await servicePORepository.getActiveCentralisedPOIds(), []);
  assert.deepEqual(await servicePORepository.getActiveCentralisedPOIds({ companyIds: [], ownerIds: [] }), []);

  ServicePO.findAll = originalFindAll;
});

// ── employeeServicePOMappingRepository.findByEmployee ──────────────────

test('findByEmployee(): includes a BU-less (company_id NULL) mapping alongside this employee\'s own-company mappings', async () => {
  const { EmployeeServicePOMapping } = require('../src/models');
  const original = EmployeeServicePOMapping.findAll;
  const { Op } = require('sequelize');

  let capturedWhere;
  EmployeeServicePOMapping.findAll = async (args) => {
    capturedWhere = args.where;
    return [];
  };

  await employeeServicePOMappingRepository.findByEmployee(77, 10, 'active');

  assert.equal(capturedWhere.employee_id, 77);
  assert.deepEqual(capturedWhere[Op.or], [{ company_id: 10 }, { company_id: null }]);
  assert.equal(capturedWhere.status, 'active');

  EmployeeServicePOMapping.findAll = original;
});
