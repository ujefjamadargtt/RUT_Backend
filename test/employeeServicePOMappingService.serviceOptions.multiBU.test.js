'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for a real bug report: saving the "Manage Service PO
// Mapping" screen (launched from Employee Master's "Map Roles & Business
// Units" action) rejected an already-eligible Service PO with "Service
// PO(s) <id> are not eligible for Employee #<id>" — getServicePOOptionsForEmployee()/
// saveEmployeeServicePOMappings() resolved the CALLER's scope via
// companyAccessControlService.resolveActorCompanyScope(), which narrows a
// BU-scoped caller down to their single currently-active companyId. A
// multi-BU BU Admin/Project Manager/Delivery Head managing several Business
// Units under the same owning Admin would then have any Service PO outside
// whichever ONE BU happened to be active rejected as "ineligible" — even
// when it was a perfectly legitimate, already-saved mapping. Same bug
// pattern already fixed for assign()/getServicePOEmployees() (see
// employeeServicePOMappingService.resolveEmployeeMappingScope's doc
// comment) — this was the one screen that had been missed.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findById: employeeRepository.findById,
  findBusinessUnitsByEmployeeId: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId,
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
  getEligibleForMapping: servicePORepository.getEligibleForMapping,
  findByEmployee: employeeServicePOMappingRepository.findByEmployee,
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findByEmployeeAndPOIds: employeeServicePOMappingRepository.findByEmployeeAndPOIds,
  bulkCreate: employeeServicePOMappingRepository.bulkCreate,
  bulkUpdateStatus: employeeServicePOMappingRepository.bulkUpdateStatus,
  resolveAdminScopeForBusinessUnits: companyAccessControlService.resolveAdminScopeForBusinessUnits,
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
  companyAccessControlService.resolveAdminScopeForBusinessUnits = ORIGINAL.resolveAdminScopeForBusinessUnits;
  // findAllByEmployee deliberately stays on its own safe default (empty) —
  // see stubScopePassthrough's comment; re-stubbed per test when needed.
  employeeServicePOMappingRepository.findAllByEmployee = async () => [];
}

// Identity passthrough — resolveAdminScopeForBusinessUnits' own DB-backed
// widening logic (own-BUs -> owning Admin's full company set) is tested
// directly in test/companyAccessControlService.resolveAdminScopeForBusinessUnits.test.js.
// Called at the START of each test since restore() resets it afterward.
function stubScopePassthrough() {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async (ownBusinessUnitIds) => ownBusinessUnitIds;
  employeeServicePOMappingRepository.findAllByEmployee = async () => [];
}

// A BU Admin mapped to BUs 3 and 7, currently active on BU 3 (the exact
// "Global BU selector on a different BU than the target record" scenario
// this bug report hit) — employeeBusinessUnits carries the FULL mapped set,
// companyId carries only the currently-active one.
const MULTI_BU_CALLER = {
  companyId: 3,
  hierarchyRank: 4,
  employeeId: 900,
  employeeBusinessUnits: [3, 7],
};

test('getServicePOOptionsForEmployee: a Service PO in the caller\'s OTHER managed BU (7, not the active companyId 3) is included as eligible', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: 7, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 7 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  let capturedCompanyId;
  servicePORepository.getEligibleForMapping = async (params) => {
    capturedCompanyId = params.companyId;
    return [{ id: 146, service_po_code: 'PO-146', service_po_name: 'Aarti Tableau', company_id: 7, is_centralised: false }];
  };

  const result = await employeeServicePOMappingService.getServicePOOptionsForEmployee(267, MULTI_BU_CALLER);

  assert.deepEqual([...capturedCompanyId].sort(), [3, 7]); // caller's FULL managed scope, not just the active BU 3
  assert.deepEqual(result.eligible_service_pos.map((po) => po.id), [146]);

  restore();
});

test('saveEmployeeServicePOMappings: a Service PO belonging to the caller\'s OTHER managed BU (7, not the active companyId 3) saves successfully — THE BUG FIX', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: 7, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 7 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [
    { id: 146, company_id: 7 },
  ];
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [];
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  let created;
  employeeServicePOMappingRepository.bulkCreate = async (records) => { created = records; return records; };
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids) => ids.length;

  await employeeServicePOMappingService.saveEmployeeServicePOMappings(267, [146], 900, MULTI_BU_CALLER);

  assert.equal(created.length, 1);
  assert.equal(created[0].service_po_id, 146);

  restore();
});

test('saveEmployeeServicePOMappings: a Service PO OUTSIDE the caller\'s full managed scope is still correctly rejected (authorization is narrowed, never bypassed)', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: 7, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 7 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [
    { id: 146, company_id: 7 },
  ];

  await assert.rejects(
    () => employeeServicePOMappingService.saveEmployeeServicePOMappings(267, [146, 999], 900, MULTI_BU_CALLER),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /999/);
      return true;
    }
  );

  restore();
});

// Regression test for the ACTUAL real-world case behind this bug report
// (Employee #267 "Umesh Patil", Service PO #146 "Idle") — verified directly
// against the synced local DB: Umesh's own Business Unit (40) exactly
// matches PO 146's company_id (40), so company/BU SCOPE was never the
// problem here. The real cause: PO 146's status had moved to 'completed'
// (servicePORepository.getEligibleForMapping only returns 'in-progress' /
// 'on-hold' / 'pending' POs), so it silently dropped out of eligibility —
// and because Save always resends the Employee's FULL existing mapping set
// (see saveEmployeeServicePOMappings' own doc comment), Umesh's still-active
// mapping to PO 146 made EVERY subsequent save of anything else about him
// (a role, a Business Unit) fail with "Service PO(s) 146 are not eligible."
test('saveEmployeeServicePOMappings: a Service PO the Employee is ALREADY actively mapped to is grandfathered in even after its status moves to completed/closed — THE BUG FIX', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: null, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 40 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }, { role_name: 'BU Admin' }, { role_name: 'Project Manager' }];
  // PO 146 ("Idle") is now completed -> excluded from getEligibleForMapping,
  // exactly like the real servicePORepository query would exclude it.
  servicePORepository.getEligibleForMapping = async () => [];
  employeeServicePOMappingRepository.findAllByEmployee = async () => [
    { service_po_id: 146, status: 'active' },
  ];
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async (employeeId, ids) => {
    assert.ok(ids.includes(146), 'must query the grandfathered PO\'s existing row, not skip it');
    return [{ id: 1520, service_po_id: 146, status: 'active' }];
  };

  let mutated = false;
  employeeServicePOMappingRepository.bulkCreate = async (records) => { mutated = true; return records; };
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids) => { mutated = true; return ids.length; };

  // Umesh's existing checked set (146) is resent unchanged — must succeed
  // as a no-op, never 400 "not eligible".
  const result = await employeeServicePOMappingService.saveEmployeeServicePOMappings(267, [146], 900, {
    companyId: 40, hierarchyRank: 4, employeeId: 900, employeeBusinessUnits: [40],
  });

  assert.equal(mutated, false); // already active -> no create/activate/deactivate needed
  assert.ok(Array.isArray(result));

  restore();
});

test('saveEmployeeServicePOMappings: a grandfathered completed PO that the caller DID uncheck is still correctly deactivated', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: null, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 40 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => [];
  employeeServicePOMappingRepository.findAllByEmployee = async () => [
    { service_po_id: 146, status: 'active' },
  ];
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [
    { id: 1520, service_po_id: 146, status: 'active' },
  ];

  let deactivated = null;
  employeeServicePOMappingRepository.bulkCreate = async () => [];
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids, status) => {
    if (status === 'inactive') deactivated = ids;
    return ids.length;
  };

  // Desired set is now empty -> PO 146 was explicitly removed.
  await employeeServicePOMappingService.saveEmployeeServicePOMappings(267, [], 900, {
    companyId: 40, hierarchyRank: 4, employeeId: 900, employeeBusinessUnits: [40],
  });

  assert.deepEqual(deactivated, [1520]);

  restore();
});

// PM redesign regression: the multi-BU scope fix (resolveEmployeeMappingScope,
// NOT resolveActorCompanyScope) must keep working identically once a PM
// assignment is layered on top of it — a multi-BU caller must be able to
// assign is_project_manager: true for an eligible Service PO in ANY of
// their managed Business Units, not just their single currently-active one.
test('saveEmployeeServicePOMappings: a multi-BU caller can assign is_project_manager:true for an eligible PO in their OTHER managed BU (7, not the active companyId 3)', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: 7, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 7 }];
  // The TARGET employee (267) must hold the Project Manager role for the
  // assignment to be allowed — independent of the CALLER's own multi-BU reach.
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Project Manager' }];
  servicePORepository.getEligibleForMapping = async (params) => {
    // Confirms this still resolves the caller's FULL managed scope (3 and 7),
    // not just the active companyId (3) — the exact bug this scope fix closed.
    assert.deepEqual([...params.companyId].sort(), [3, 7]);
    return [{ id: 146, company_id: 7 }];
  };
  employeeServicePOMappingRepository.findByEmployeeAndPOIds = async () => [];
  employeeServicePOMappingRepository.findByEmployee = async () => [];

  let created;
  employeeServicePOMappingRepository.bulkCreate = async (records) => { created = records; return records; };
  employeeServicePOMappingRepository.bulkUpdateStatus = async (ids) => ids.length;

  await employeeServicePOMappingService.saveEmployeeServicePOMappings(
    267, [{ service_po_id: 146, is_project_manager: true }], 900, MULTI_BU_CALLER
  );

  assert.equal(created.length, 1);
  assert.equal(created[0].service_po_id, 146);
  assert.equal(created[0].is_project_manager, true);

  restore();
});

test('saveEmployeeServicePOMappings: PM-role validation for the TARGET employee is completely independent of the multi-BU scope fix — still rejected with 400 when that employee lacks the role', async () => {
  stubScopePassthrough();
  employeeRepository.findById = async () => ({ id: 267, company_id: 7, status: 'active' });
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [{ id: 7 }];
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Employee' }];
  servicePORepository.getEligibleForMapping = async () => {
    throw new Error('must not be reached — PM-role validation runs before eligibility is fetched');
  };
  employeeServicePOMappingRepository.bulkCreate = async () => { throw new Error('must not write anything'); };

  await assert.rejects(
    () => employeeServicePOMappingService.saveEmployeeServicePOMappings(
      267, [{ service_po_id: 146, is_project_manager: true }], 900, MULTI_BU_CALLER
    ),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  restore();
});
