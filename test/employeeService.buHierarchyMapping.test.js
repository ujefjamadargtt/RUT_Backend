'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/employeeService.duplicateCode.test.js —
// employeeService.js holds a live reference to these SAME module-cached
// objects, never destructured at call time.
const employeeRepository = require('../src/repositories/employeeRepository');
const companyRepository = require('../src/repositories/companyRepository');
const { Role, Company, sequelize } = require('../src/models');
const employeeService = require('../src/services/employeeService');
// Tenant (owning Admin) resolution is a DB lookup — pinned here; code uniqueness is checked per Admin tenant.
require('../src/services/companyAccessControlService').resolveTenantAdminId = async () => 7;

/**
 * BU Hierarchy / Sub-BU support — "map BU + Sub-BU, compulsory": a Business
 * Unit that currently has Sub-BUs can no longer be the final Employee
 * assignment (resolveBusinessUnitIds(), internal to employeeService.js,
 * exercised here through create()/update()).
 */

const ORIGINAL = {
  findByCodeInTenant: employeeRepository.findByCodeInTenant,
  findByEmail: employeeRepository.findByEmail,
  findByIdWithEmail: employeeRepository.findByIdWithEmail,
  update: employeeRepository.update,
  roleFindOne: Role.findOne,
  companyFindAll: Company.findAll,
  hasChildren: companyRepository.hasChildren,
  findIdsWithChildren: companyRepository.findIdsWithChildren,
  transaction: sequelize.transaction,
};

function restore() {
  employeeRepository.findByCodeInTenant = ORIGINAL.findByCodeInTenant;
  employeeRepository.findByEmail = ORIGINAL.findByEmail;
  employeeRepository.findByIdWithEmail = ORIGINAL.findByIdWithEmail;
  employeeRepository.update = ORIGINAL.update;
  Role.findOne = ORIGINAL.roleFindOne;
  Company.findAll = ORIGINAL.companyFindAll;
  companyRepository.hasChildren = ORIGINAL.hasChildren;
  companyRepository.findIdsWithChildren = ORIGINAL.findIdsWithChildren;
  sequelize.transaction = ORIGINAL.transaction;
}

// BU Admin (rank 4) — a plain companyId, no extra DB calls for scope
// resolution, same fixture every other employeeService test file uses.
const AUTH_CONTEXT = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };

function stopBeforeTransaction() {
  sequelize.transaction = async () => { throw new Error('__stopped_before_transaction__'); };
}

function stubCommonCreatePrereqs() {
  employeeRepository.findByCodeInTenant = async () => null;
  employeeRepository.findByEmail = async () => null;
  Role.findOne = async () => ({ id: 8, role_name: 'Employee', status: 'active', hierarchy_rank: 8 });
}

test('create(): rejects a business_unit_ids entry that currently has Sub-BUs', async () => {
  stubCommonCreatePrereqs();
  companyRepository.hasChildren = async (id) => id === 10; // the actor's own home BU (10) has children
  Company.findAll = async () => [{ id: 1, company_name: 'Technology' }];
  companyRepository.findIdsWithChildren = async (ids) => ids.filter((id) => id === 1);

  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP001', full_name: 'New Hire', email: 'new.hire@example.com', role_ids: [8], business_unit_ids: [1] },
      1, '127.0.0.1', AUTH_CONTEXT
    ),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Technology.*Sub-BUs/);
      return true;
    }
  );
  restore();
});

test('create(): a leaf Sub-BU id passes the check and reaches the transaction (no hierarchy rejection)', async () => {
  stubCommonCreatePrereqs();
  companyRepository.hasChildren = async () => false; // the actor's own home BU (10) has no children either
  Company.findAll = async () => [{ id: 10, company_name: 'Home BU' }];
  companyRepository.findIdsWithChildren = async () => []; // no parents among the requested ids
  stopBeforeTransaction();

  // Business unit id 10 IS the actor's own home BU (companyId), so it's
  // within scope on its own merits — isolates the hierarchy check from the
  // separate ownedScope/ownership check.
  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP002', full_name: 'New Hire', email: 'new.hire2@example.com', role_ids: [8], business_unit_ids: [10] },
      1, '127.0.0.1', AUTH_CONTEXT
    ),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});

test('create(): the actor\'s own home BU is silently skipped from auto-injection when it has Sub-BUs, instead of erroring', async () => {
  stubCommonCreatePrereqs();
  companyRepository.hasChildren = async (id) => id === 10; // home BU (10) has children
  companyRepository.findIdsWithChildren = async () => {
    throw new Error('must not be called — with no ids left, resolveBusinessUnitIds short-circuits before this check');
  };
  Company.findAll = async () => {
    throw new Error('must not be called — ids resolves to empty, no existence lookup needed');
  };
  stopBeforeTransaction();

  // No explicit business_unit_ids — the home BU (10, has children) would
  // normally be auto-injected as the default, but must be skipped here.
  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP003', full_name: 'New Hire', email: 'new.hire3@example.com', role_ids: [8] },
      1, '127.0.0.1', AUTH_CONTEXT
    ),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});

test('update(): parent + one of its own children both submitted (real bug: [40, 23, 42] where 40="DATA + AI" has Sub-BU 42="DAS") — the Parent is KEPT alongside its Sub-BU (a Sub-BU is part of its Parent, like a department)', async () => {
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  Company.findAll = async ({ where }) => {
    if (where.parent_business_unit_id) {
      // 40's own children: just 42 ("DAS").
      return [{ id: 42, parent_business_unit_id: 40 }];
    }
    // Existence check for ids [40, 23, 42].
    return [
      { id: 40, company_name: 'DATA + AI' },
      { id: 23, company_name: 'Some Other BU' },
      { id: 42, company_name: 'DAS' },
    ];
  };
  companyRepository.hasChildren = async (id) => id === 10;
  companyRepository.findIdsWithChildren = async (ids) => ids.filter((id) => id === 40);
  employeeRepository.update = async (empId, payload) => ({ id: empId, ...payload, toJSON() { return this; } });
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  let replaced;
  const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
  const originalReplace = employeeBusinessUnitRepository.replaceForEmployee;
  employeeBusinessUnitRepository.replaceForEmployee = async (employeeId, businessUnitIds) => {
    replaced = businessUnitIds;
  };

  // Multi-BU actor mapped to all four ids — resolveBUAssignmentScope()
  // widens ownership to this full set (not just the single active
  // companyId), so the ownership check below isn't what's under test here.
  const multiBuAuthContext = {
    ...AUTH_CONTEXT,
    employeeBusinessUnits: [10, 40, 23, 42],
  };
  await employeeService.update(61, { business_unit_ids: [40, 23, 42] }, 1, '127.0.0.1', multiBuAuthContext);

  assert.deepEqual(replaced.slice().sort((a, b) => a - b), [23, 40, 42]); // Parent 40 kept with its Sub-BU 42
  employeeBusinessUnitRepository.replaceForEmployee = originalReplace;
  restore();
});

test('update(): rejects re-submitting a business_unit_ids entry that currently has Sub-BUs', async () => {
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  Company.findAll = async () => [{ id: 1, company_name: 'Technology' }];
  // The employee's own company_id (10) also has children here, so it's
  // correctly skipped from auto-injection rather than polluting the
  // requested [1] set with an id Company.findAll doesn't return.
  companyRepository.hasChildren = async (id) => id === 10;
  companyRepository.findIdsWithChildren = async (ids) => ids.filter((id) => id === 1);

  await assert.rejects(
    () => employeeService.update(61, { business_unit_ids: [1] }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Technology.*Sub-BUs/);
      return true;
    }
  );
  restore();
});

test('update(): omitting business_unit_ids entirely leaves existing mappings untouched (no hierarchy check runs)', async () => {
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  companyRepository.hasChildren = async () => {
    throw new Error('must not be called — business_unit_ids was not supplied, resolveBusinessUnitIds never runs');
  };
  companyRepository.findIdsWithChildren = async () => {
    throw new Error('must not be called — business_unit_ids was not supplied, resolveBusinessUnitIds never runs');
  };
  stopBeforeTransaction();

  await assert.rejects(
    () => employeeService.update(61, { full_name: 'Renamed' }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});

test('update(): a BU Admin mapped only to the Parent BU may assign Parent + its Sub-BU (Sub-BU is within their reach)', async () => {
  const companyAccessControlService = require('../src/services/companyAccessControlService');
  const originalExpand = companyAccessControlService.expandBusinessUnitIdsWithDescendants;
  companyAccessControlService.expandBusinessUnitIdsWithDescendants = async (ids) => (ids.includes(40) ? [...ids, 42] : ids);
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: null, is_deleted: false, toJSON() { return this; },
  });
  Company.findAll = async ({ where }) => {
    if (where.parent_business_unit_id) return [{ id: 42, parent_business_unit_id: 40 }];
    return [{ id: 40, company_name: 'DATA + AI' }, { id: 42, company_name: 'DAS' }];
  };
  companyRepository.hasChildren = async (id) => id === 40;
  companyRepository.findIdsWithChildren = async (ids) => ids.filter((id) => id === 40);
  employeeRepository.update = async (empId, payload) => ({ id: empId, ...payload, toJSON() { return this; } });
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  let replaced;
  const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
  const originalReplace = employeeBusinessUnitRepository.replaceForEmployee;
  const originalFindIds = employeeBusinessUnitRepository.findIdsByEmployeeId;
  employeeBusinessUnitRepository.findIdsByEmployeeId = async () => [];
  employeeBusinessUnitRepository.replaceForEmployee = async (employeeId, businessUnitIds) => {
    replaced = businessUnitIds;
  };

  try {
    // Actor mapped to Parent 40 only — NOT directly to Sub-BU 42.
    await employeeService.update(61, { business_unit_ids: [40, 42] }, 1, '127.0.0.1', {
      ...AUTH_CONTEXT, companyId: 40, employeeBusinessUnits: [40],
    });
    assert.deepEqual(replaced.slice().sort((a, b) => a - b), [40, 42]);
  } finally {
    companyAccessControlService.expandBusinessUnitIdsWithDescendants = originalExpand;
    employeeBusinessUnitRepository.replaceForEmployee = originalReplace;
    employeeBusinessUnitRepository.findIdsByEmployeeId = originalFindIds;
    restore();
  }
});

// ── update() BU mapping rules ────────────────────────────────────────────────────────────────
async function runUpdate({ existingBuIds, roles, companies, parentRows = [], hasChildrenIds = [], submitted, ctx, empId = 61 }) {
  const companyAccessControlService = require('../src/services/companyAccessControlService');
  const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
  const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
  const exclusionRepository = require('../src/repositories/employeeBusinessUnitRoleExclusionRepository');
  const orig = {
    expand: companyAccessControlService.expandBusinessUnitIdsWithDescendants,
    replace: employeeBusinessUnitRepository.replaceForEmployee,
    findIds: employeeBusinessUnitRepository.findIdsByEmployeeId,
    findRoles: employeeRoleRepository.findRolesByEmployeeId,
    add: exclusionRepository.addExclusions,
    clear: exclusionRepository.clearForBusinessUnits,
  };
  const out = { replaced: null, added: null, cleared: null };
  companyAccessControlService.expandBusinessUnitIdsWithDescendants = async (ids) => ids;
  employeeRepository.findByIdWithEmail = async (id) => ({
    id, employee_code: 'EMP1', company_id: null, is_deleted: false, toJSON() { return this; },
  });
  Company.findAll = async ({ where }) => {
    if (where.parent_business_unit_id) return parentRows;
    const key = Object.getOwnPropertySymbols(where.id || {})[0];
    const wanted = key ? where.id[key] : [];
    return companies.filter((c) => wanted.includes(c.id));
  };
  companyRepository.hasChildren = async (id) => hasChildrenIds.includes(id);
  companyRepository.findIdsWithChildren = async (ids) => ids.filter((id) => hasChildrenIds.includes(id));
  employeeRepository.update = async (e, payload) => ({ id: e, ...payload, toJSON() { return this; } });
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
  employeeBusinessUnitRepository.findIdsByEmployeeId = async () => existingBuIds;
  employeeRoleRepository.findRolesByEmployeeId = async () => roles;
  employeeBusinessUnitRepository.replaceForEmployee = async (e, ids) => { out.replaced = ids; };
  exclusionRepository.addExclusions = async (e, buIds, roleIds) => { out.added = { buIds, roleIds }; };
  exclusionRepository.clearForBusinessUnits = async (e, buIds) => { out.cleared = buIds; };
  try {
    await employeeService.update(empId, { business_unit_ids: submitted }, 1, '127.0.0.1', ctx);
  } finally {
    companyAccessControlService.expandBusinessUnitIdsWithDescendants = orig.expand;
    employeeBusinessUnitRepository.replaceForEmployee = orig.replace;
    employeeBusinessUnitRepository.findIdsByEmployeeId = orig.findIds;
    employeeRoleRepository.findRolesByEmployeeId = orig.findRoles;
    exclusionRepository.addExclusions = orig.add;
    exclusionRepository.clearForBusinessUnits = orig.clear;
    restore();
  }
  return out;
}
const EMP_ROLE = [{ id: 14, role_name: 'Employee' }];
const BU_ADMIN_ROLE_ONLY = [{ id: 2, role_name: 'BU Admin' }];
const BU_ADMIN_AND_PM = [{ id: 2, role_name: 'BU Admin' }, { id: 12, role_name: 'Project Manager' }];
const sortNum = (arr) => arr.slice().sort((a, b) => a - b);

test('update(): BUs the Employee already holds outside the actor reach are kept, not rejected', async () => {
  const ctx = { ...AUTH_CONTEXT, companyId: 40, employeeBusinessUnits: [40] };
  const out = await runUpdate({
    existingBuIds: [40, 56, 57], roles: EMP_ROLE, companies: [{ id: 40, company_name: 'DATA + AI' }],
    submitted: [40, 56, 57], ctx,
  });
  assert.deepEqual(sortNum(out.replaced), [40, 56, 57]);
  // A NEW id outside the actor reach is still refused.
  await assert.rejects(runUpdate({
    existingBuIds: [40, 56, 57], roles: EMP_ROLE,
    companies: [{ id: 40, company_name: 'A' }, { id: 987654, company_name: 'Other' }],
    submitted: [40, 987654], ctx,
  }));
});

test('update(): mapping a Sub-BU also maps its Parent BU, even when the actor is not directly mapped to the Parent', async () => {
  const out = await runUpdate({
    existingBuIds: [], roles: EMP_ROLE,
    companies: [{ id: 42, company_name: 'DAS', parent_business_unit_id: 40 }, { id: 40, company_name: 'DATA + AI', parent_business_unit_id: null }],
    submitted: [42], ctx: { ...AUTH_CONTEXT, companyId: 42, employeeBusinessUnits: [42] },
  });
  assert.deepEqual(sortNum(out.replaced), [40, 42]);
});

test('update(): a Parent the Employee already holds is not rejected as bare on an unrelated edit', async () => {
  const out = await runUpdate({
    existingBuIds: [40], roles: EMP_ROLE, companies: [{ id: 40, company_name: 'DATA + AI' }],
    parentRows: [{ id: 43, parent_business_unit_id: 40 }], hasChildrenIds: [40],
    submitted: [40], ctx: { ...AUTH_CONTEXT, companyId: 40, employeeBusinessUnits: [40] },
  });
  assert.deepEqual(out.replaced, [40]);
});

test('update(): a BU Admin with NO other role cannot unmap a BU from their OWN record, but can for another employee', async () => {
  const ctx = { ...AUTH_CONTEXT, companyId: 40, employeeBusinessUnits: [40, 41], roleNames: ['BU Admin'] };
  const base = { existingBuIds: [40, 41], roles: BU_ADMIN_ROLE_ONLY, companies: [{ id: 40, company_name: 'A' }], submitted: [40], ctx };
  await assert.rejects(runUpdate({ ...base, empId: 99 }), /cannot unmap/);
  const out = await runUpdate({ ...base, empId: 61 });
  assert.deepEqual(out.replaced, [40]);
});

test('update(): a BU Admin + Project Manager unmapped from a BU is unmapped for the OTHER role only (row kept, exclusion added)', async () => {
  const ctx = { ...AUTH_CONTEXT, companyId: 40, employeeBusinessUnits: [40, 41], roleNames: ['BU Admin'] };
  const out = await runUpdate({
    existingBuIds: [40, 41], roles: BU_ADMIN_AND_PM, companies: [{ id: 40, company_name: 'A' }],
    submitted: [40], ctx, empId: 99,
  });
  assert.deepEqual(sortNum(out.replaced), [40, 41]); // nothing deleted from employee_business_units
  assert.deepEqual(out.added, { buIds: [41], roleIds: [12] });
  assert.deepEqual(out.cleared, [40]);
});
