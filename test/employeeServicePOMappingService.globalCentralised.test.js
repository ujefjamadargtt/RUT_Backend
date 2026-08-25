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
};

function restore() {
  servicePORepository.getActiveCentralisedPOIds = ORIGINAL.getActiveCentralisedPOIds;
  employeeServicePOMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = ORIGINAL.resolveCompanyIdsOwnedByCreator;
}

test('autoMapCentralisedServicePOs(): a BU-less Centralised PO OWNED BY THE SAME ADMIN is mapped with company_id: null, a per-company one keeps its own company_id', async () => {
  servicePORepository.getActiveCentralisedPOIds = async (companyId) => {
    assert.equal(companyId, 10);
    return [
      { id: 501, company_id: 10, created_by: 5 },   // this company's own centralised PO
      { id: 999, company_id: null, created_by: 5 }, // BU-less centralised PO, created by Admin 5 (who also owns company 10)
    ];
  };
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async (creatorEmployeeId) => {
    assert.equal(creatorEmployeeId, 5);
    return [10, 11]; // Admin 5 owns companies 10 and 11
  };

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, 10, 1, undefined);

  assert.equal(capturedRecords.length, 2);
  const perCompany = capturedRecords.find((r) => r.service_po_id === 501);
  const global = capturedRecords.find((r) => r.service_po_id === 999);
  assert.equal(perCompany.company_id, 10);
  assert.equal(global.company_id, null);
  assert.equal(perCompany.employee_id, 77);
  assert.equal(global.employee_id, 77);

  restore();
});

test('autoMapCentralisedServicePOs(): a BU-less Centralised PO owned by a DIFFERENT Admin is NOT mapped (the cross-Admin visibility bug)', async () => {
  servicePORepository.getActiveCentralisedPOIds = async () => [
    { id: 999, company_id: null, created_by: 6 }, // created by a DIFFERENT Admin (6), who does NOT own company 10
  ];
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async (creatorEmployeeId) => {
    assert.equal(creatorEmployeeId, 6);
    return [42]; // Admin 6 owns an unrelated company — NOT 10
  };

  let bulkCreateCalled = false;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    bulkCreateCalled = records.length > 0;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, 10, 1, undefined);

  assert.equal(bulkCreateCalled, false);

  restore();
});

test('autoMapCentralisedServicePOs(): a company-less employee (no BU at all) gets mapped ONLY to a BU-less Centralised PO created by the SAME actor', async () => {
  servicePORepository.getActiveCentralisedPOIds = async (companyId) => {
    assert.equal(companyId, null);
    return [
      { id: 999, company_id: null, created_by: 1 }, // created by the SAME actor (userId: 1 below)
      { id: 998, company_id: null, created_by: 2 }, // created by a DIFFERENT actor — must be excluded
    ];
  };

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, null, 1, undefined);

  assert.equal(capturedRecords.length, 1);
  assert.equal(capturedRecords[0].service_po_id, 999);
  assert.equal(capturedRecords[0].company_id, null);
  assert.equal(capturedRecords[0].employee_id, 77);

  restore();
});

test('getActiveCentralisedPOIds(): companyId null matches ONLY BU-less Centralised POs, not company-scoped ones', async () => {
  const { Op } = require('sequelize');
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedWhere;
  ServicePO.findAll = async (args) => {
    capturedWhere = args.where;
    return [];
  };

  await servicePORepository.getActiveCentralisedPOIds(null);

  assert.equal(capturedWhere.company_id, null);
  assert.equal(capturedWhere[Op.or], undefined);

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
