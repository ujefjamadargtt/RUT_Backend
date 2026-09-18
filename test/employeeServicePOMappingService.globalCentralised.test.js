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

// Decided design: a Centralised Service PO is BU-less and is for every
// Employee — regardless of the new Employee's own Business Unit, and
// regardless of which Admin/BU Admin created the PO. No creator-ownership
// restriction applies (see servicePORepository.getActiveCentralisedPOIds()
// and employeeServicePOMappingService.autoMapCentralisedServicePOs()).

test('autoMapCentralisedServicePOs(): every active Centralised PO is mapped, a per-company one keeps its own company_id, a BU-less one maps as null', async () => {
  servicePORepository.getActiveCentralisedPOIds = async () => [
    { id: 501, company_id: 10, created_by: 5 },   // a legacy per-company centralised PO
    { id: 999, company_id: null, created_by: 5 }, // BU-less centralised PO
  ];

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

test('autoMapCentralisedServicePOs(): a BU-less Centralised PO created by a DIFFERENT Admin is STILL mapped (no creator restriction, by decided design)', async () => {
  servicePORepository.getActiveCentralisedPOIds = async () => [
    { id: 999, company_id: null, created_by: 6 }, // created by a DIFFERENT Admin than the one creating this Employee
  ];

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, 10, 1, undefined);

  assert.equal(capturedRecords.length, 1);
  assert.equal(capturedRecords[0].service_po_id, 999);

  restore();
});

test('autoMapCentralisedServicePOs(): a company-less employee (no BU at all) is mapped to every BU-less Centralised PO regardless of creator', async () => {
  servicePORepository.getActiveCentralisedPOIds = async () => [
    { id: 999, company_id: null, created_by: 1 },
    { id: 998, company_id: null, created_by: 2 }, // a different creator — still included
  ];

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(77, null, 1, undefined);

  assert.equal(capturedRecords.length, 2);
  assert.deepEqual(capturedRecords.map((r) => r.service_po_id).sort(), [998, 999]);
  assert.ok(capturedRecords.every((r) => r.company_id === null && r.employee_id === 77));

  restore();
});

test('getActiveCentralisedPOIds(): queries is_centralised=true platform-wide, with no company_id condition at all', async () => {
  const { ServicePO } = require('../src/models');
  const originalFindAll = ServicePO.findAll;

  let capturedWhere;
  ServicePO.findAll = async (args) => {
    capturedWhere = args.where;
    return [];
  };

  await servicePORepository.getActiveCentralisedPOIds();

  assert.equal(capturedWhere.is_centralised, true);
  assert.equal(capturedWhere.company_id, undefined);

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
