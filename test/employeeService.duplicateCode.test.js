'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — employeeService.js holds a live reference to these SAME
// module-cached objects, never destructured at call time, so mutating a
// property here is visible to the service's own calls. Same pattern as
// test/formMasterService.test.js.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const { Role, Company, sequelize } = require('../src/models');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  findByCode: employeeRepository.findByCode,
  findById: employeeRepository.findById,
  findByIdWithEmail: employeeRepository.findByIdWithEmail,
  create: employeeRepository.create,
  findByEmail: employeeRepository.findByEmail,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  roleFindOne: Role.findOne,
  companyFindAll: Company.findAll,
  transaction: sequelize.transaction,
};

function restore() {
  employeeRepository.findByCode = ORIGINAL.findByCode;
  employeeRepository.findById = ORIGINAL.findById;
  employeeRepository.findByIdWithEmail = ORIGINAL.findByIdWithEmail;
  employeeRepository.create = ORIGINAL.create;
  employeeRepository.findByEmail = ORIGINAL.findByEmail;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  Role.findOne = ORIGINAL.roleFindOne;
  Company.findAll = ORIGINAL.companyFindAll;
  sequelize.transaction = ORIGINAL.transaction;
}

// BU Admin (rank 4) — the simplest resolveEmployeeAccessWhere/
// resolveActorCompanyScope branch (a plain companyId, no extra DB calls),
// so these tests don't need to stub manager-mapping/team-mapping lookups.
const AUTH_CONTEXT = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };

// Stops the call chain deterministically right at the transaction boundary
// — used by the two "the check correctly let a free code through" tests
// below so they never fall through to a real DB connection/write for the
// unmocked steps (Role lookup, insert) that follow the part we're testing.
function stopBeforeTransaction() {
  sequelize.transaction = async () => { throw new Error('__stopped_before_transaction__'); };
}

// A soft-deleted employee row still holding the code being requested —
// employeeRepository.findByCode() intentionally has no is_deleted filter
// (see its doc comment in src/repositories/employeeRepository.js), so this
// is exactly what it would return.
function deletedEmployeeRow(overrides) {
  return { id: 55, employee_code: 'EMP001', company_id: 10, is_deleted: true, status: 'inactive', ...overrides };
}

test('create() rejects a code already held by a SOFT-DELETED employee in the same company, with a clear conflict message', async () => {
  employeeRepository.findByCode = async (code, companyId) => {
    assert.equal(code, 'EMP001');
    assert.equal(companyId, 10);
    return deletedEmployeeRow();
  };
  employeeRepository.findByEmail = async () => {
    throw new Error('must not be reached — the employee_code conflict should short-circuit before the email check');
  };
  employeeRepository.create = async () => {
    throw new Error('must not be reached — no insert should be attempted once employee_code conflicts');
  };

  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP001', full_name: 'New Hire', email: 'new.hire@example.com', role_ids: [8] },
      1,
      '127.0.0.1',
      AUTH_CONTEXT
    ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Employee code "EMP001" is already in use/);
      return true;
    }
  );
  restore();
});

test('create() lets a genuinely free code (held by no one, deleted or active) pass the conflict check', async () => {
  let codeChecked = false;
  employeeRepository.findByCode = async () => { codeChecked = true; return null; };
  employeeRepository.findByEmail = async () => null;
  Role.findOne = async () => ({ id: 8, role_name: 'Employee', status: 'active', hierarchy_rank: 8 });
  Company.findAll = async () => [{ id: 10 }];
  stopBeforeTransaction(); // never reach a real DB insert

  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP999', full_name: 'New Hire', email: 'fresh.hire@example.com', role_ids: [8] },
      1, '127.0.0.1', AUTH_CONTEXT
    ),
    (err) => err.message === '__stopped_before_transaction__'
  );
  assert.equal(codeChecked, true);
  restore();
});

test('update() rejects renaming to a code already held by a SOFT-DELETED employee in the same company', async () => {
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  employeeRepository.findByCode = async (code, companyId) => {
    assert.equal(code, 'EMP001');
    assert.equal(companyId, 10);
    return deletedEmployeeRow();
  };

  await assert.rejects(
    () => employeeService.update(61, { employee_code: 'EMP001' }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Employee code "EMP001" is already in use/);
      return true;
    }
  );
  restore();
});

test('update() skips the code-conflict check entirely when employee_code is unchanged', async () => {
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  employeeRepository.findByCode = async () => {
    throw new Error('must not be called — employee_code did not actually change');
  };
  stopBeforeTransaction(); // never reach a real DB update

  await assert.rejects(
    () => employeeService.update(61, { employee_code: 'EMP777', full_name: 'Renamed' }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});

test('update() 404s when the target Employee falls outside the caller\'s resolved access scope (cross-tenant IDOR fix)', async () => {
  // Simulates Admin A1 (rank 2, no companyId) guessing the id of an
  // Employee belonging to Admin A2's Company. resolveEmployeeAccessWhere
  // itself is exercised by employeeAccessControlService's own tests — here
  // it's stubbed to return a scope ({id:-1}) that can never match any real
  // row, so findByIdWithEmail correctly 404s instead of silently falling
  // back to an unscoped lookup.
  employeeAccessControlService.resolveEmployeeAccessWhere = async (authContext) => {
    assert.equal(authContext.hierarchyRank, 2);
    return { id: -1 };
  };
  employeeRepository.findByIdWithEmail = async (id, companyId, accessWhere) => {
    assert.deepEqual(accessWhere, { id: -1 }, 'the resolved accessWhere must be passed through, not ignored');
    return null; // out of scope -> not found, same as a genuinely missing id
  };
  employeeRepository.findByCode = async () => {
    throw new Error('must not be reached — the access-scope check must 404 first');
  };

  const adminA1Context = { userId: 2, employeeId: 200, companyId: null, hierarchyRank: 2, roleNames: [] };

  await assert.rejects(
    () => employeeService.update(999, { full_name: 'Hijacked' }, 2, '127.0.0.1', adminA1Context),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  restore();
});
