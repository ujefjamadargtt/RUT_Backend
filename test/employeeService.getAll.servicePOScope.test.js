'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GET /employees?service_po_id= — the frontend ended up calling the MAIN
// paginated Employee list (not /employees/active/list) for the Service PO
// -> Map Employees screen. Without service_po_id it must stay byte-for-byte
// unchanged (resolveEmployeeAccessWhere's per-role "own team" scope);
// with it, the same bypass as employeeService.getActiveEmployees()'s
// servicePOId param applies — the caller's FULL Admin/tenant scope, not
// the PO's own BU or the currently selected Global BU. Same monkey-patch
// style as test/employeeService.getAll.businessUnitFilter.test.js.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const servicePORepository = require('../src/repositories/servicePORepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  findAll: employeeRepository.findAll,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  poFindById: servicePORepository.findById,
  resolveActorCompanyScope: companyAccessControlService.resolveActorCompanyScope,
  resolveOwnedCompanyIds: companyAccessControlService.resolveOwnedCompanyIds,
  resolveAdminScopeForBusinessUnits: companyAccessControlService.resolveAdminScopeForBusinessUnits,
};

function restore() {
  employeeRepository.findAll = ORIGINAL.findAll;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  servicePORepository.findById = ORIGINAL.poFindById;
  companyAccessControlService.resolveActorCompanyScope = ORIGINAL.resolveActorCompanyScope;
  companyAccessControlService.resolveOwnedCompanyIds = ORIGINAL.resolveOwnedCompanyIds;
  companyAccessControlService.resolveAdminScopeForBusinessUnits = ORIGINAL.resolveAdminScopeForBusinessUnits;
}

// Identity passthrough for BU Admin/Service PO Admin scenarios —
// resolveAdminScopeForBusinessUnits' own widening logic (own-BUs -> owning
// Admin -> Admin's full scope) is tested directly in
// test/companyAccessControlService.resolveAdminScopeForBusinessUnits.test.js.
// Called at the START of a test (not module scope) since restore() resets it.
function stubScopePassthrough() {
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async (ownBusinessUnitIds) => ownBusinessUnitIds;
}

function stubRepositoryCapture() {
  let capturedFilters;
  employeeRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

// Admin (company-less), owning Companies 10 and 20.
const ADMIN_AUTH_CONTEXT = { userId: 1, employeeId: 1, companyId: null, hierarchyRank: 2, roleNames: [], employeeBusinessUnits: [] };
// BU Admin mapped to BUs 3 and 7 — the non-Admin/Entity-Admin scope path
// (plain companyId array, not resolveEmployeeAccessWhere's fragment).
const BU_ADMIN_AUTH_CONTEXT = { userId: 2, employeeId: 900, companyId: 3, hierarchyRank: 4, roleNames: ['BU Admin'], employeeBusinessUnits: [3, 7] };

test('no service_po_id: resolveEmployeeAccessWhere is used exactly as before (unchanged)', async () => {
  let accessWhereCalled = false;
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => {
    accessWhereCalled = true;
    return { id: -1 };
  };
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({}, ADMIN_AUTH_CONTEXT);

  assert.equal(accessWhereCalled, true);
  assert.deepEqual(getCaptured().accessWhere, { id: -1 });
  restore();
});

test('service_po_id given for a BU Admin: bypasses resolveEmployeeAccessWhere entirely, using their full Business-Unit-membership scope instead', async () => {
  stubScopePassthrough();
  servicePORepository.findById = async () => ({ id: 388, company_id: 3 });
  let accessWhereCalled = false;
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => {
    accessWhereCalled = true;
    return { id: -1 };
  };
  const getCaptured = stubRepositoryCapture();

  const result = await employeeService.getAll({ service_po_id: '388', limit: '50', status: 'active' }, BU_ADMIN_AUTH_CONTEXT);

  assert.equal(accessWhereCalled, false);
  assert.equal(getCaptured().accessWhere, undefined);
  assert.deepEqual(getCaptured().companyId, [3, 7]);
  assert.ok(result.data);
  restore();
});

test('service_po_id given for an Admin: uses resolveEmployeeAccessWhere\'s scope (not a plain owned-Company array) — the reported "only 10 of 18" bug, caused by dropping its "directly created, no BU yet" fallback', async () => {
  companyAccessControlService.resolveOwnedCompanyIds = async () => [10, 20];
  servicePORepository.findById = async () => ({ id: 388, company_id: 10 });
  const adminAccessWhere = { fake: 'admin-scope-with-created-by-fallback' };
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => adminAccessWhere;
  const getCaptured = stubRepositoryCapture();

  const result = await employeeService.getAll({ service_po_id: '388', limit: '50', status: 'active' }, ADMIN_AUTH_CONTEXT);

  assert.equal(getCaptured().companyId, undefined);
  assert.deepEqual(getCaptured().accessWhere, adminAccessWhere);
  assert.ok(result.data);
  restore();
});

test('service_po_id + business_unit_id together (BU Admin): the broadened scope is still further narrowed by business_unit_id (the two filters compose)', async () => {
  stubScopePassthrough();
  servicePORepository.findById = async () => ({ id: 388, company_id: 3 });
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({ service_po_id: '388', business_unit_id: '7' }, BU_ADMIN_AUTH_CONTEXT);

  assert.deepEqual(getCaptured().companyId, [3, 7]);
  assert.equal(getCaptured().businessUnitId, 7);
  restore();
});

test('a service_po_id outside the caller\'s tenant scope 404s rather than silently falling back to the narrower default scope', async () => {
  companyAccessControlService.resolveActorCompanyScope = async () => [10, 20];
  servicePORepository.findById = async () => null;

  await assert.rejects(
    () => employeeService.getAll({ service_po_id: '999' }, ADMIN_AUTH_CONTEXT),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

test('a non-numeric service_po_id is ignored — falls back to the normal accessWhere scope, never throws', async () => {
  let accessWhereCalled = false;
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => {
    accessWhereCalled = true;
    return { id: -1 };
  };
  stubRepositoryCapture();

  await employeeService.getAll({ service_po_id: 'not-a-number' }, ADMIN_AUTH_CONTEXT);

  assert.equal(accessWhereCalled, true);
  restore();
});
