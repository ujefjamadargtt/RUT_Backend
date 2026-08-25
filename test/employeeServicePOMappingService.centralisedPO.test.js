'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/buHeadService.createBuHead.test.js —
// employeeServicePOMappingService.js holds live references to these
// module-cached repository objects, never destructured at call time.
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  getActiveCentralisedPOIds: servicePORepository.getActiveCentralisedPOIds,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
};

function restore() {
  servicePORepository.getActiveCentralisedPOIds = ORIGINAL.getActiveCentralisedPOIds;
  employeeServicePOMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
}

const FAKE_TRANSACTION = { __fakeTransaction: true };

test('autoMapCentralisedServicePOs: 0 active Centralised POs -> no insert attempted', async () => {
  servicePORepository.getActiveCentralisedPOIds = async () => [];
  employeeServicePOMappingRepository.bulkCreate = async () => {
    throw new Error('must not be reached — nothing to insert when there are no Centralised POs');
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(500, 10, 1, FAKE_TRANSACTION);

  restore();
});

test('autoMapCentralisedServicePOs: 3 active Centralised POs -> one bulk insert with exactly 3 records', async () => {
  servicePORepository.getActiveCentralisedPOIds = async (companyId) => {
    assert.equal(companyId, 10);
    return [{ id: 101, company_id: 10 }, { id: 102, company_id: 10 }, { id: 103, company_id: 10 }];
  };

  let bulkCreateCalls = 0;
  let capturedRecords, capturedOptions;
  employeeServicePOMappingRepository.bulkCreate = async (records, options) => {
    bulkCreateCalls += 1;
    capturedRecords = records;
    capturedOptions = options;
    return records;
  };

  await employeeServicePOMappingService.autoMapCentralisedServicePOs(500, 10, 1, FAKE_TRANSACTION);

  assert.equal(bulkCreateCalls, 1); // one bulk call, not 3 individual inserts
  assert.equal(capturedRecords.length, 3);
  assert.deepEqual(capturedRecords.map((r) => r.service_po_id), [101, 102, 103]);
  assert.ok(capturedRecords.every((r) =>
    r.employee_id === 500 &&
    r.company_id === 10 &&
    r.status === 'active' &&
    r.created_by === 1 &&
    r.updated_by === 1
  ));
  assert.ok(capturedOptions.transaction.__fakeTransaction); // same transaction as the Employee insert

  restore();
});

test('employeeServicePOMappingRepository.bulkCreate: empty records array is a no-op (never calls the model)', async () => {
  const result = await employeeServicePOMappingRepository.bulkCreate([], { transaction: FAKE_TRANSACTION });
  assert.deepEqual(result, []);
});

test('employeeServicePOMappingRepository.bulkCreate: passes ignoreDuplicates so a Centralised PO already manually assigned to this employee is not duplicated', async () => {
  // Duplicate protection is delegated to Sequelize bulkCreate's
  // ignoreDuplicates option + the DB's uq_employee_servicepo_mapping unique
  // constraint (employee_id, service_po_id) — this test only verifies the
  // repository actually requests that behavior, not the DB-level guarantee.
  const { EmployeeServicePOMapping } = require('../src/models');
  const originalModelBulkCreate = EmployeeServicePOMapping.bulkCreate;

  let capturedOptions;
  EmployeeServicePOMapping.bulkCreate = async (records, options) => {
    capturedOptions = options;
    return records;
  };

  await employeeServicePOMappingRepository.bulkCreate(
    [{ employee_id: 101, service_po_id: 1, company_id: 10, status: 'active', created_by: 1, updated_by: 1 }],
    { transaction: FAKE_TRANSACTION }
  );

  assert.equal(capturedOptions.ignoreDuplicates, true);
  assert.ok(capturedOptions.transaction.__fakeTransaction);

  EmployeeServicePOMapping.bulkCreate = originalModelBulkCreate;
});
