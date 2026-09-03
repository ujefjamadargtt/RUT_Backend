'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as employeeServicePOMappingService.centralisedPO.test.js
// — the module holds live references to these repository objects, never
// destructured at call time.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findActiveEmployeeIdsByBusinessUnitIds: employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds,
  findBusinessUnitsByEmployeeIds: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds,
  findActiveUnassignedByCreator: employeeRepository.findActiveUnassignedByCreator,
  resolveCompanyIdsOwnedByCreator: companyAccessControlService.resolveCompanyIdsOwnedByCreator,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
};

function restore() {
  employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds = ORIGINAL.findActiveEmployeeIdsByBusinessUnitIds;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds = ORIGINAL.findBusinessUnitsByEmployeeIds;
  employeeRepository.findActiveUnassignedByCreator = ORIGINAL.findActiveUnassignedByCreator;
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = ORIGINAL.resolveCompanyIdsOwnedByCreator;
  employeeServicePOMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
}

const FAKE_TRANSACTION = { __fakeTransaction: true };

test('autoMapExistingEmployeesToCentralisedServicePO: per-company PO -> maps every active Employee assigned to that Business Unit', async () => {
  employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds = async (businessUnitIds) => {
    assert.deepEqual(businessUnitIds, [10]);
    return [201, 202];
  };
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async () => {
    throw new Error('must not be reached — companyId is given, so ownership hierarchy resolution is unnecessary');
  };

  let capturedRecords, capturedOptions;
  employeeServicePOMappingRepository.bulkCreate = async (records, options) => {
    capturedRecords = records;
    capturedOptions = options;
    return records;
  };

  await employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO(401, 10, 1, FAKE_TRANSACTION);

  assert.equal(capturedRecords.length, 2);
  assert.deepEqual(capturedRecords.map((r) => r.employee_id), [201, 202]);
  assert.ok(capturedRecords.every((r) =>
    r.service_po_id === 401 &&
    r.company_id === 10 &&
    r.status === 'active' &&
    r.created_by === 1 &&
    r.updated_by === 1
  ));
  assert.ok(capturedOptions.transaction.__fakeTransaction);

  restore();
});

test('autoMapExistingEmployeesToCentralisedServicePO: BU-less PO -> maps Employees across the creator\'s owned Business Units PLUS the creator\'s own genuinely-unassigned Employees, deduped', async () => {
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async (creatorId) => {
    assert.equal(creatorId, 1);
    return [10, 20];
  };
  employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds = async (businessUnitIds) => {
    assert.deepEqual(businessUnitIds, [10, 20]);
    return [201, 202];
  };
  employeeRepository.findActiveUnassignedByCreator = async (createdBy) => {
    assert.equal(createdBy, 1);
    return [{ id: 500 }, { id: 501 }];
  };
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds = async (employeeIds) => {
    assert.deepEqual(employeeIds, [500, 501]);
    // 501 actually has a BU grant (company_id was null but they're not
    // genuinely unassigned) -> must be excluded.
    return [{ employee_id: 501, id: 30, name: 'Some BU' }];
  };

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO(401, null, 1, FAKE_TRANSACTION);

  assert.deepEqual(capturedRecords.map((r) => r.employee_id).sort(), [201, 202, 500]);
  assert.ok(capturedRecords.every((r) => r.company_id === null && r.service_po_id === 401));

  restore();
});

test('autoMapExistingEmployeesToCentralisedServicePO: no applicable Employees -> no insert attempted', async () => {
  employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds = async () => [];
  employeeServicePOMappingRepository.bulkCreate = async () => {
    throw new Error('must not be reached — nothing to insert');
  };

  await employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO(401, 10, 1, FAKE_TRANSACTION);

  restore();
});
