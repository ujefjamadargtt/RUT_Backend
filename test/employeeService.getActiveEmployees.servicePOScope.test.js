'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GET /employees/active/list?service_po_id= — the Service PO -> Map
// Employees screen's actual data source (per the frontend's own contract:
// extend the existing active-employees list rather than switch to a new
// endpoint). Without service_po_id, behavior must be byte-for-byte
// unchanged. With it, the caller's normal per-role "own team" scope
// (resolveEmployeeAccessWhere) is bypassed for their FULL Admin/company/
// tenant scope — ignoring the Service PO's own BU AND the caller's
// currently selected Global BU. Same monkey-patch style as
// test/employeeServicePOMappingService.getEmployeeOptionsForServicePO.test.js.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const servicePORepository = require('../src/repositories/servicePORepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  getActiveEmployees: employeeRepository.getActiveEmployees,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  poFindById: servicePORepository.findById,
  resolveActorCompanyScope: companyAccessControlService.resolveActorCompanyScope,
  resolveOwnedCompanyIds: companyAccessControlService.resolveOwnedCompanyIds,
  resolveAdminScopeForBusinessUnits: companyAccessControlService.resolveAdminScopeForBusinessUnits,
};

function restore() {
  employeeRepository.getActiveEmployees = ORIGINAL.getActiveEmployees;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  servicePORepository.findById = ORIGINAL.poFindById;
  companyAccessControlService.resolveActorCompanyScope = ORIGINAL.resolveActorCompanyScope;
  companyAccessControlService.resolveOwnedCompanyIds = ORIGINAL.resolveOwnedCompanyIds;
  companyAccessControlService.resolveAdminScopeForBusinessUnits = ORIGINAL.resolveAdminScopeForBusinessUnits;
}

// Identity passthrough for BU Admin/Service PO Admin scenarios —
// resolveAdminScopeForBusinessUnits' own widening logic is tested directly
// in test/companyAccessControlService.resolveAdminScopeForBusinessUnits.test.js.
// Called at the START of a test (not module scope) since restore() resets it.
function stubScopePassthrough() {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async (ownBusinessUnitIds) => ownBusinessUnitIds;
}

function captureRepoCall(rows = []) {
  let capturedCompanyId;
  let capturedAccessWhere;
  let capturedBusinessUnitId;
  employeeRepository.getActiveEmployees = async (companyId, accessWhere, businessUnitId) => {
    capturedCompanyId = companyId;
    capturedAccessWhere = accessWhere;
    capturedBusinessUnitId = businessUnitId;
    return rows;
  };
  return {
    getCompanyId: () => capturedCompanyId,
    getAccessWhere: () => capturedAccessWhere,
    getBusinessUnitId: () => capturedBusinessUnitId,
  };
}

// Service PO Admin mapped to BU 3 and BU 7, currently viewing (selected)
// Global BU 3 — the exact scenario from the frontend's own example.
const SERVICE_PO_ADMIN_MULTI_BU = {
  companyId: 3,
  hierarchyRank: 6,
  employeeId: 900,
  roleNames: ['Service PO Admin'],
  employeeBusinessUnits: [3, 7],
};

test('no service_po_id: behavior is completely unchanged — resolveEmployeeAccessWhere\'s scope is used, exactly as before', async () => {
  let accessWhereCalled = false;
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => {
    accessWhereCalled = true;
    return { id: -1 };
  };
  const { getCompanyId, getAccessWhere } = captureRepoCall([]);

  await employeeService.getActiveEmployees(SERVICE_PO_ADMIN_MULTI_BU, null);

  assert.equal(accessWhereCalled, true);
  assert.equal(getCompanyId(), 3);
  assert.deepEqual(getAccessWhere(), { id: -1 });
  restore();
});

test('service_po_id given: bypasses resolveEmployeeAccessWhere entirely (no "own team" restriction) in favor of the caller\'s full Admin/tenant scope', async () => {
  stubScopePassthrough();
  companyAccessControlService.resolveActorCompanyScope = async () => 3;
  servicePORepository.findById = async () => ({ id: 388, company_id: 7 });
  let accessWhereCalled = false;
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => {
    accessWhereCalled = true;
    return { id: -1 };
  };
  const { getCompanyId, getAccessWhere } = captureRepoCall([]);

  await employeeService.getActiveEmployees(SERVICE_PO_ADMIN_MULTI_BU, 388);

  assert.equal(accessWhereCalled, false);
  assert.deepEqual(getCompanyId(), [3, 7]);
  assert.equal(getAccessWhere(), undefined);
  restore();
});

test('a BU Admin whose Global BU selector is on BU 3, mapping a BU 7 PO, still gets employees from BU 7 (and every other BU they manage) — the exact frontend scenario', async () => {
  stubScopePassthrough();
  companyAccessControlService.resolveActorCompanyScope = async () => 3;
  servicePORepository.findById = async () => ({ id: 388, company_id: 7 });
  const { getCompanyId } = captureRepoCall([]);

  await employeeService.getActiveEmployees(
    { companyId: 3, hierarchyRank: 4, employeeId: 900, roleNames: ['BU Admin'], employeeBusinessUnits: [3, 7] },
    388
  );

  assert.deepEqual(getCompanyId(), [3, 7]);
  restore();
});

test('a Centralised Service PO (no company_id) uses the SAME caller-scope resolution as a normal PO — no special-casing needed', async () => {
  stubScopePassthrough();
  companyAccessControlService.resolveActorCompanyScope = async () => 3;
  servicePORepository.findById = async () => ({ id: 500, company_id: null, is_centralised: true });
  const { getCompanyId } = captureRepoCall([]);

  await employeeService.getActiveEmployees(SERVICE_PO_ADMIN_MULTI_BU, 500);

  assert.deepEqual(getCompanyId(), [3, 7]);
  restore();
});

test('an Admin (company-less) gets resolveEmployeeAccessWhere\'s scope (not a plain owned-Company array) — preserves the "directly created, no BU yet" fallback', async () => {
  companyAccessControlService.resolveOwnedCompanyIds = async () => [10, 20];
  servicePORepository.findById = async () => ({ id: 100, company_id: 10 });
  const adminAccessWhere = { fake: 'admin-scope-with-created-by-fallback' };
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => adminAccessWhere;
  const { getCompanyId, getAccessWhere } = captureRepoCall([]);

  await employeeService.getActiveEmployees(
    { companyId: null, hierarchyRank: 2, employeeId: 1, roleNames: [], employeeBusinessUnits: [] },
    100
  );

  assert.equal(getCompanyId(), undefined);
  assert.deepEqual(getAccessWhere(), adminAccessWhere);
  restore();
});

test('a service_po_id outside the caller\'s tenant scope 404s rather than silently falling back to the unscoped list', async () => {
  companyAccessControlService.resolveActorCompanyScope = async () => 3;
  servicePORepository.findById = async () => null;

  await assert.rejects(
    () => employeeService.getActiveEmployees(SERVICE_PO_ADMIN_MULTI_BU, 999),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});
