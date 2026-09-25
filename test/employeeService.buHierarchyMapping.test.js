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

/**
 * BU Hierarchy / Sub-BU support — "map BU + Sub-BU, compulsory": a Business
 * Unit that currently has Sub-BUs can no longer be the final Employee
 * assignment (resolveBusinessUnitIds(), internal to employeeService.js,
 * exercised here through create()/update()).
 */

const ORIGINAL = {
  findByCode: employeeRepository.findByCode,
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
  employeeRepository.findByCode = ORIGINAL.findByCode;
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
  employeeRepository.findByCode = async () => null;
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
    restore();
  }
});
