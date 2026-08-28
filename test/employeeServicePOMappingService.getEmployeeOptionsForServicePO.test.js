'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// getEmployeeOptionsForServicePO() — the "Service PO -> Map Employees"
// employee-loading fix: this Employee list must NEVER be narrowed by
// Business Unit (not the PO's own BU, not the caller's currently selected
// Global BU) — only by the caller's authorized Admin/company/tenant scope.
// Same monkey-patch style as test/employeeServicePOMappingService.
// crossTenant.test.js — every dependency stubbed, no real DB.
const employeeRepository = require('../src/repositories/employeeRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');

const ORIGINAL = {
  findAll: employeeRepository.findAll,
  poFindById: servicePORepository.findById,
  findByServicePO: employeeServicePOMappingRepository.findByServicePO,
  resolveActorCompanyScope: companyAccessControlService.resolveActorCompanyScope,
  resolveOwnedCompanyIds: companyAccessControlService.resolveOwnedCompanyIds,
  resolveAdminScopeForBusinessUnits: companyAccessControlService.resolveAdminScopeForBusinessUnits,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
};

function restore() {
  employeeRepository.findAll = ORIGINAL.findAll;
  servicePORepository.findById = ORIGINAL.poFindById;
  employeeServicePOMappingRepository.findByServicePO = ORIGINAL.findByServicePO;
  companyAccessControlService.resolveActorCompanyScope = ORIGINAL.resolveActorCompanyScope;
  companyAccessControlService.resolveOwnedCompanyIds = ORIGINAL.resolveOwnedCompanyIds;
  companyAccessControlService.resolveAdminScopeForBusinessUnits = ORIGINAL.resolveAdminScopeForBusinessUnits;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
}

function stubHappyPath({ po = { id: 378, company_id: 1 }, mappedEmployeeIds = [] } = {}) {
  companyAccessControlService.resolveActorCompanyScope = async () => 1;
  // Identity passthrough — resolveAdminScopeForBusinessUnits' own widening
  // logic (own-BUs -> owning Admin -> Admin's full scope) is tested
  // directly in test/companyAccessControlService.
  // resolveAdminScopeForBusinessUnits.test.js; these tests only need to
  // verify whatever it returns flows through correctly.
  companyAccessControlService.resolveAdminScopeForBusinessUnits = async (ownBusinessUnitIds) => ownBusinessUnitIds;
  servicePORepository.findById = async () => po;
  employeeServicePOMappingRepository.findByServicePO = async () => mappedEmployeeIds.map((id) => ({ employee_id: id }));
}

function stubEmployeeFindAllCapture(rows = []) {
  let capturedFilters;
  let capturedOptions;
  employeeRepository.findAll = async (filters, pagination) => {
    capturedFilters = filters;
    capturedOptions = pagination;
    return { rows, count: rows.length };
  };
  return { getFilters: () => capturedFilters, getPagination: () => capturedOptions };
}

// BU Admin mapped to THREE Business Units (1, 2, 3), currently viewing
// Global BU 1 (authContext.companyId). Per the requirement, the Employee
// list must span all three, not just the one currently selected.
const BU_ADMIN_MULTI_BU = {
  companyId: 1,
  hierarchyRank: 4,
  employeeId: 900,
  roleNames: ['BU Admin'],
  employeeBusinessUnits: [1, 2, 3],
};

test('rejects a caller with no Service PO mapping authority (e.g. a plain Employee/Manager) with 403', async () => {
  stubHappyPath();
  await assert.rejects(
    () => employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, {
      companyId: 1, hierarchyRank: 8, employeeId: 900, roleNames: ['Employee'], employeeBusinessUnits: [1],
    }),
    (err) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
  restore();
});

test('404s when the Service PO is outside the caller\'s tenant scope (never leaks its existence)', async () => {
  companyAccessControlService.resolveActorCompanyScope = async () => 1;
  servicePORepository.findById = async () => null;

  await assert.rejects(
    () => employeeServicePOMappingService.getEmployeeOptionsForServicePO(999, BU_ADMIN_MULTI_BU),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});

// TEST 1 / TEST 7 (from the requirement) — PO belongs to BU 1; a BU Admin
// mapped to BU 1/2/3 must see employees from all three, not just BU 1.
test('TEST 1/7: BU Admin with multiple Business Units — the eligible Employee list spans ALL of them, not just the PO\'s own BU or the currently selected Global BU', async () => {
  stubHappyPath({ po: { id: 378, company_id: 1 } });
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, BU_ADMIN_MULTI_BU);

  assert.deepEqual(getFilters().companyId, [1, 2, 3]);
  restore();
});

// TEST 3 — Global BU = 1 selected; employees from BU 2/3 still returned.
test('TEST 3: switching the Global BU selector does not change the resolved Employee scope', async () => {
  stubHappyPath({ po: { id: 378, company_id: 1 } });
  const { getFilters: getFiltersBU1 } = stubEmployeeFindAllCapture([]);
  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, { ...BU_ADMIN_MULTI_BU, companyId: 1 });
  const scopeWithBU1Selected = getFiltersBU1().companyId;

  const { getFilters: getFiltersBU2 } = stubEmployeeFindAllCapture([]);
  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, { ...BU_ADMIN_MULTI_BU, companyId: 2 });
  const scopeWithBU2Selected = getFiltersBU2().companyId;

  assert.deepEqual(scopeWithBU1Selected, [1, 2, 3]);
  assert.deepEqual(scopeWithBU2Selected, [1, 2, 3]);
  restore();
});

// TEST 4 — an Admin's scope must never include a company they don't own,
// and must preserve resolveEmployeeAccessWhere's "directly created, no BU
// yet" fallback (a plain owned-Company array would silently drop those
// Employees — the actual root cause of an Admin seeing fewer Employees
// than their real total, e.g. "10 of 18").
test('TEST 4: an Admin\'s resolved Employee scope comes from resolveEmployeeAccessWhere (not a plain owned-Company array), never a wider/different tenant', async () => {
  companyAccessControlService.resolveOwnedCompanyIds = async () => [10, 20];
  stubHappyPath({ po: { id: 100, company_id: 10 } });
  const adminAccessWhere = { fake: 'admin-scope-with-created-by-fallback' };
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => adminAccessWhere;
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(100, {
    companyId: null, hierarchyRank: 2, employeeId: 1, roleNames: [], employeeBusinessUnits: [],
  });

  assert.equal(getFilters().companyId, undefined);
  assert.deepEqual(getFilters().accessWhere, adminAccessWhere);
  restore();
});

// TEST 5 — an already-mapped Employee whose BU differs from the PO's BU
// still shows up as mapped (mapped_employee_ids is independent of the
// BU-agnostic eligible-employee query).
test('TEST 5: an existing mapping to an Employee outside the resolved BU set still appears in mapped_employee_ids', async () => {
  stubHappyPath({ po: { id: 378, company_id: 1 }, mappedEmployeeIds: [55] });
  stubEmployeeFindAllCapture([]);

  const result = await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, BU_ADMIN_MULTI_BU);

  assert.deepEqual(result.mapped_employee_ids, [55]);
  restore();
});

// TEST 6 — search spans the whole scope, not just one BU.
test('TEST 6: a search term is passed straight through to the (already cross-BU) Employee query', async () => {
  stubHappyPath();
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, BU_ADMIN_MULTI_BU, { search: 'jane' });

  assert.equal(getFilters().search, 'jane');
  assert.deepEqual(getFilters().companyId, [1, 2, 3]);
  restore();
});

// TEST 8 — Service PO Admin gets the same broad access.
test('TEST 8: Service PO Admin is authorized and gets the same cross-BU Employee scope', async () => {
  stubHappyPath();
  const { getFilters } = stubEmployeeFindAllCapture([]);

  const result = await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, {
    companyId: 1, hierarchyRank: 6, employeeId: 900, roleNames: ['Service PO Admin'], employeeBusinessUnits: [1, 2],
  });

  assert.deepEqual(getFilters().companyId, [1, 2]);
  assert.ok(result.eligible_employees);
  restore();
});

// TEST 9 — Delivery Head gets the same broad access (role-name substring
// match, same technique as hasUnrestrictedServicePOVisibility).
test('TEST 9: Delivery Head is authorized and gets the same cross-BU Employee scope', async () => {
  stubHappyPath();
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, {
    companyId: 1, hierarchyRank: 6, employeeId: 900, roleNames: ['Delivery Head'], employeeBusinessUnits: [1, 2],
  });

  assert.deepEqual(getFilters().companyId, [1, 2]);
  restore();
});

// TEST 2 — an employee with NULL BU still appearing is a property of the
// underlying employeeRepository.employeeScope() helper (unchanged by this
// fix, already relied upon elsewhere) — this test confirms this function
// applies NO ambient BU-based narrowing of its own on top of it when the
// caller doesn't ask for one: the filters handed to the repository carry no
// `businessUnitId`, which is what would have excluded a NULL-BU Employee.
test('TEST 2: no businessUnitId/BU-narrowing filter is applied by default — a NULL-BU Employee is never excluded by this function itself', async () => {
  stubHappyPath();
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, BU_ADMIN_MULTI_BU);

  assert.equal(getFilters().businessUnitId, null);
  restore();
});

// TEST 10 — the panel's own opt-in Entity → BU filter dropdowns DO narrow
// the query, on top of (not instead of) the full cross-BU scope above.
test('TEST 10: an explicit business_unit_id option narrows the query via businessUnitId, without touching the resolved companyId scope', async () => {
  stubHappyPath();
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, BU_ADMIN_MULTI_BU, { business_unit_id: 2 });

  assert.equal(getFilters().businessUnitId, 2);
  assert.deepEqual(getFilters().companyId, [1, 2, 3]);
  restore();
});

// TEST 11 — an invalid business_unit_id is ignored rather than erroring,
// matching getAll()'s existing permissive handling of the same field.
test('TEST 11: a non-numeric business_unit_id is ignored (no filter applied)', async () => {
  stubHappyPath();
  const { getFilters } = stubEmployeeFindAllCapture([]);

  await employeeServicePOMappingService.getEmployeeOptionsForServicePO(378, BU_ADMIN_MULTI_BU, { business_unit_id: 'not-a-number' });

  assert.equal(getFilters().businessUnitId, null);
  restore();
});

test('hasServicePOMappingAuthority(): matches BU Admin, Service PO Admin, and Delivery Head case-insensitively', () => {
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority(['BU Admin']), true);
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority(['bu admin']), true);
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority(['Service PO Admin']), true);
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority(['Delivery Head']), true);
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority(['Manager']), false);
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority(['Employee']), false);
  assert.equal(employeeServicePOMappingService.hasServicePOMappingAuthority([]), false);
});
