'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/employeeServicePOMappingService.globalCentralised.test.js.
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findById: servicePORepository.findById,
  findByServicePO: employeeServicePOMappingRepository.findByServicePO,
};

function restore() {
  servicePORepository.findById = ORIGINAL.findById;
  employeeServicePOMappingRepository.findByServicePO = ORIGINAL.findByServicePO;
}

test('getServicePOEmployees(): a company-less actor CAN see mappings for their OWN Centralised (BU-less) PO', async () => {
  // servicePORepository.findById already handles this via companyScope()'s
  // createdBy fallback — stubbed here to simulate that success case.
  servicePORepository.findById = async (id, companyId, createdBy) => {
    assert.equal(id, 370);
    return { id: 370, company_id: null, created_by: createdBy };
  };

  let capturedArgs;
  employeeServicePOMappingRepository.findByServicePO = async (servicePOId, status) => {
    capturedArgs = { servicePOId, status };
    return [{ id: 1, employee_id: 576, service_po_id: 370 }];
  };

  const authContext = { companyId: undefined, hierarchyRank: 2, employeeId: 569 };
  const mappings = await employeeServicePOMappingService.getServicePOEmployees(370, authContext, 'active');

  assert.equal(mappings.length, 1);
  assert.equal(capturedArgs.servicePOId, 370);
  assert.equal(capturedArgs.status, 'active');

  restore();
});

test('getServicePOEmployees(): 404s (never leaks mapping rows) when the PO is not in the caller\'s scope', async () => {
  servicePORepository.findById = async () => null; // out of scope, or a different tenant's PO entirely

  let called = false;
  employeeServicePOMappingRepository.findByServicePO = async () => {
    called = true;
    return [];
  };

  const authContext = { companyId: undefined, hierarchyRank: 2, employeeId: 999 };
  await assert.rejects(
    () => employeeServicePOMappingService.getServicePOEmployees(370, authContext, undefined),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  assert.equal(called, false);

  restore();
});
