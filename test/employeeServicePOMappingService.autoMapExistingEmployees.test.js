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
  findAllActiveIds: employeeRepository.findAllActiveIds,
  resolveCompanyIdsOwnedByCreator: companyAccessControlService.resolveCompanyIdsOwnedByCreator,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
};

function restore() {
  employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds = ORIGINAL.findActiveEmployeeIdsByBusinessUnitIds;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds = ORIGINAL.findBusinessUnitsByEmployeeIds;
  employeeRepository.findActiveUnassignedByCreator = ORIGINAL.findActiveUnassignedByCreator;
  employeeRepository.findAllActiveIds = ORIGINAL.findAllActiveIds;
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

test('autoMapExistingEmployeesToCentralisedServicePO: BU-less PO -> maps ONLY the creating Admin\'s own tenant (their BUs\' Employees + their own unassigned Employees), never another Admin\'s', async () => {
  employeeRepository.findAllActiveIds = async () => {
    throw new Error('must not be reached — a BU-less Centralised PO is never mapped platform-wide');
  };
  companyAccessControlService.resolveCompanyIdsOwnedByCreator = async (creatorId) => {
    assert.equal(creatorId, 1);
    return [10, 11]; // Admin 1's own Business Units
  };
  employeeBusinessUnitRepository.findActiveEmployeeIdsByBusinessUnitIds = async (businessUnitIds) => {
    assert.deepEqual(businessUnitIds, [10, 11]);
    return [201, 202]; // another Admin's Employee (e.g. 500) is never returned for these BUs
  };
  employeeRepository.findActiveUnassignedByCreator = async (creatorId) => {
    assert.equal(creatorId, 1);
    return [{ id: 301 }, { id: 302 }];
  };
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds = async () => [{ employee_id: 302, id: 10 }];

  let capturedRecords;
  employeeServicePOMappingRepository.bulkCreate = async (records) => {
    capturedRecords = records;
    return records;
  };

  await employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO(401, null, 1, FAKE_TRANSACTION);

  assert.deepEqual(capturedRecords.map((r) => r.employee_id).sort(), [201, 202, 301]);
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
