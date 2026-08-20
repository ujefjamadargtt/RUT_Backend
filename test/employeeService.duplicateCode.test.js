'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — employeeService.js holds a live reference to these SAME
// module-cached objects, never destructured at call time, so mutating a
// property here is visible to the service's own calls. Same pattern as
// test/formMasterService.test.js.
const employeeRepository = require('../src/repositories/employeeRepository');
const userRepository = require('../src/repositories/userRepository');
const { Role, sequelize } = require('../src/models');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  findByCode: employeeRepository.findByCode,
  findById: employeeRepository.findById,
  create: employeeRepository.create,
  findByEmail: userRepository.findByEmail,
  roleFindOne: Role.findOne,
  transaction: sequelize.transaction,
};

function restore() {
  employeeRepository.findByCode = ORIGINAL.findByCode;
  employeeRepository.findById = ORIGINAL.findById;
  employeeRepository.create = ORIGINAL.create;
  userRepository.findByEmail = ORIGINAL.findByEmail;
  Role.findOne = ORIGINAL.roleFindOne;
  sequelize.transaction = ORIGINAL.transaction;
}

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
  userRepository.findByEmail = async () => {
    throw new Error('must not be reached — the employee_code conflict should short-circuit before the email check');
  };
  employeeRepository.create = async () => {
    throw new Error('must not be reached — no insert should be attempted once employee_code conflicts');
  };

  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP001', full_name: 'New Hire', email: 'new.hire@example.com' },
      1,
      '127.0.0.1',
      10
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
  userRepository.findByEmail = async () => null;
  Role.findOne = async () => ({ id: 8, role_name: 'Employee' });
  stopBeforeTransaction(); // never reach a real DB insert

  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP999', full_name: 'New Hire', email: 'fresh.hire@example.com' },
      1, '127.0.0.1', 10
    ),
    (err) => err.message === '__stopped_before_transaction__'
  );
  assert.equal(codeChecked, true);
  restore();
});

test('update() rejects renaming to a code already held by a SOFT-DELETED employee in the same company', async () => {
  employeeRepository.findById = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  employeeRepository.findByCode = async (code, companyId) => {
    assert.equal(code, 'EMP001');
    assert.equal(companyId, 10);
    return deletedEmployeeRow();
  };

  await assert.rejects(
    () => employeeService.update(61, { employee_code: 'EMP001' }, 1, '127.0.0.1', 10),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Employee code "EMP001" is already in use/);
      return true;
    }
  );
  restore();
});

test('update() skips the code-conflict check entirely when employee_code is unchanged', async () => {
  employeeRepository.findById = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  employeeRepository.findByCode = async () => {
    throw new Error('must not be called — employee_code did not actually change');
  };
  stopBeforeTransaction(); // never reach a real DB update

  await assert.rejects(
    () => employeeService.update(61, { employee_code: 'EMP777', full_name: 'Renamed' }, 1, '127.0.0.1', 10),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});
