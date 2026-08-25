'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for the "Manage Service PO Mapping" (Employee Master action)
// feature: getServicePOOptionsForEmployee() (GET options) and
// saveEmployeeServicePOMappings() (PUT save). Same monkey-patch style as
// test/employeeServicePOMappingService.crossTenant.test.js — every
// repository call is stubbed, no real DB. authContext.companyId is always a
// plain number (a BU-scoped actor) so companyAccessControlService.
// resolveActorCompanyScope() short-circuits without hitting the DB.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findById: employeeRepository.findById,
  findBusinessUnitsByEmployeeId: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId,
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
  getEligibleForMapping: servicePORepository.getEligibleForMapping,
  findByEmployee: employeeServicePOMappingRepository.findByEmployee,
  findByEmployeeAndPOIds: employeeServicePOMappingRepository.findByEmployeeAndPOIds,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
  bulkUpdateStatus: employeeServicePOMappingRepository.bulkUpdateStatus,
};

function restore() {
  employeeRepository.findById = ORIGINAL.findById;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = ORIGINAL.findBusinessUnitsByEmployeeId;
  employeeRoleRepository.findRolesByEmployeeId = ORIGINAL.findRolesByEmployeeId;
  servicePORepository.getEligibleForMapping = ORIGINAL.getEligibleForMapping;
  employeeServicePOMappingRepository.findByEmployee = ORIGINAL.findByEmployee;
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = ORIGINAL.findByEmployeeAndPOIds;
  employeeServicePOMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeServicePOMappingRepository.bulkUpdateStatus = ORIGINAL.bulkUpdateStatus;
}

const AUTH_CONTEXT = { companyId: 10, hierarchyRank: 4, employeeId: 900 }; // BU Admin, own BU 10

// --- hasUnrestrictedServicePOVisibility() -----------------------------

test('hasUnrestrictedServicePOVisibility(): matches "Service PO Admin" case-insensitively', () => {
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['Service PO Admin']), true);
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['service po admin']), true);
});

test('hasUnrestrictedServicePOVisibility(): matches a role renamed to "Service PO Admin/Delivery Head"', () => {
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['Service PO Admin/Delivery Head']), true);
});

test('hasUnrestrictedServicePOVisibility(): matches a standalone "Delivery Head" role too', () => {
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['Delivery Head']), true);
});

test('hasUnrestrictedServicePOVisibility(): false for Manager/Employee/BU Admin and other unrelated roles', () => {
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['Manager']), false);
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['Employee']), false);
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility(['BU Admin']), false);
  assert.equal(employeeServicePOMappingService.hasUnrestrictedServicePOVisibility([]), false);
});

// --- getServicePOOptionsForEmployee() ----------------------------------

test('TEST 1/2 — Service PO Admin (or Delivery Head): eligible query is called unrestricted=true, ignoring the employee\'s own BU', async () => {
  employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' }); // employee's home BU = 1
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Service PO Admin' }];
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  let captured;
  servicePORepository.getEligibleForMapping = async (params) => {
    captured = params;
    return [
      { id: 1, service_po_code: 'PO-001', service_po_name: 'A', company_id: 1, is_centralised: false },
      { id: 2, service_po_code: 'PO-002', service_po_name: 'B', company_id: 2, is_centralised: false },
      { id: 3, service_po_code: 'PO-003', service_po_name: 'C', company_id: 3, is_centralised: false },
    ];
  };

  const result = await employeeServicePOMappingService.getServicePOOptionsForEmployee(1, AUTH_CONTEXT);

  assert.equal(captured.unrestricted, true);
  assert.equal(captured.companyId, 10); // the CALLER's authorized scope, not the employee's own BU
  assert.equal(result.unrestricted, true);
  assert.equal(result.eligible_service_pos.length, 3); // PO-002/PO-003 (different BUs) still included

  restore();
});

test('TEST 3 — normal Employee role: eligible query is called unrestricted=false with the employee\'s own BU ids', async () => {
  employeeRepository.findById = async () => ({ id: 2, company_id: null, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }, { id: 5 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  let captured;
  servicePORepository.getEligibleForMapping = async (params) => {
    captured = params;
    return [];
  };

  await employeeServicePOMappingService.getServicePOOptionsForEmployee(2, AUTH_CONTEXT);

  assert.equal(captured.unrestricted, false);
  assert.deepEqual([...captured.businessUnitIds].sort(), [1, 5]);

  restore();
});

test('TEST 5 — mapped_service_po_ids only reflects ACTIVE mapping rows, not inactive ones', async () => {
  employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [];
  employeeServicePOMappingRepository.findByEmployee = async () => [
    { service_po_id: 1, status: 'active' },
    { service_po_id: 3, status: 'active' },
    { service_po_id: 2, status: 'inactive' },
  ];

  const result = await employeeServicePOMappingService.getServicePOOptionsForEmployee(1, AUTH_CONTEXT);

  assert.deepEqual(result.mapped_service_po_ids.sort(), [1, 3]);

  restore();
});

// --- saveEmployeeServicePOMappings() -----------------------------------

test('TEST 4/8 (security) — rejects with 400 when a requested Service PO id is outside the eligible set, and never writes anything', async () => {
  employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [
    { id: 1, company_id: 1 },
  ];

  let wroteAnything = false;
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => {
    wroteAnything = true; // must not even be reached — validation fails first
    return [];
  };
  employeeServicePOMappingRepository.bulkCreate = async () => { wroteAnything = true; return []; };
  employeeServicePOMappingRepository.bulkUpdateStatus = async () => { wroteAnything = true; return 0; };

  await assert.rejects(
    () => employeeServicePOMappingService.saveEmployeeServicePOMappings(1, [1, 101], 900, AUTH_CONTEXT),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /101/);
      return true;
    }
  );
  assert.equal(wroteAnything, false);

  restore();
});

test('TEST 6 — a newly selected, previously-unmapped eligible PO is created as an active mapping', async () => {
  employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [
    { id: 1, company_id: 1 },
    { id: 2, company_id: 1 },
  ];
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
    { id: 11, service_po_id: 1, status: 'active' },
  ];

  let created;
  employeeServicePOMappingRepository.bulkCreate = async (records) => { created = records; return records; };
  let activated = null;
  let deactivated = null;
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids, status) => {
    if (status === 'active') activated = ids;
    if (status === 'inactive') deactivated = ids;
    return ids.length;
  };
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  await employeeServicePOMappingService.saveEmployeeServicePOMappings(1, [1, 2], 900, AUTH_CONTEXT);

  assert.equal(created.length, 1);
  assert.equal(created[0].service_po_id, 2);
  assert.equal(created[0].status, 'active');
  assert.equal(created[0].company_id, 1);
  assert.equal(activated, null); // PO 1 was already active — no redundant update
  assert.equal(deactivated, null);

  restore();
});

test('TEST 7 — an unselected, previously-active mapping is deactivated (soft), never hard-deleted', async () => {
  employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [
    { id: 1, company_id: 1 },
    { id: 3, company_id: 1 },
  ];
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
    { id: 11, service_po_id: 1, status: 'active' },
    { id: 13, service_po_id: 3, status: 'active' },
  ];

  let deactivated = null;
  employeeServicePOMappingRepository.bulkCreate = async () => [];
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids, status) => {
    if (status === 'inactive') deactivated = ids;
    return ids.length;
  };
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  // Desired set drops PO 3 -> its active row must be deactivated, not removed.
  await employeeServicePOMappingService.saveEmployeeServicePOMappings(1, [1], 900, AUTH_CONTEXT);

  assert.deepEqual(deactivated, [13]);

  restore();
});

test('TEST 8 (duplicate protection) — saving the identical set twice is a no-op the second time: no create/activate/deactivate calls', async () => {
  employeeRepository.findById = async () => ({ id: 1, company_id: 1, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 1 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [{ id: 1, company_id: 1 }];
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
    { id: 11, service_po_id: 1, status: 'active' },
  ];

  let mutationCount = 0;
  employeeServicePOMappingRepository.bulkCreate = async (records) => { mutationCount += records.length; return records; };
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids) => { mutationCount += ids.length; return ids.length; };
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  await employeeServicePOMappingService.saveEmployeeServicePOMappings(1, [1], 900, AUTH_CONTEXT);

  assert.equal(mutationCount, 0);

  restore();
});
