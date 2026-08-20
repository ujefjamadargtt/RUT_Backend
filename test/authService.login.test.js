'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported functions
// — authService.js holds a live reference to this SAME module-cached object,
// never destructured at call time, so mutating a property here is visible
// to the service's own calls. Same pattern as
// test/employeeService.duplicateCode.test.js.
const authRepository = require('../src/repositories/authRepository');
const authService = require('../src/services/authService');

const ORIGINAL = {
  findUserByEmail: authRepository.findUserByEmail,
};

function restore() {
  authRepository.findUserByEmail = ORIGINAL.findUserByEmail;
}

function activeRole(overrides) {
  return { id: 8, role_name: 'Employee', status: 'active', hierarchy_rank: 8, ...overrides };
}

function baseUser(overrides) {
  return {
    id: 1,
    email: 'user@example.com',
    status: 'active',
    role: activeRole(),
    additionalRoles: [],
    employee: null,
    company: null,
    toJSON() { return { ...this }; },
    validatePassword: async () => {
      throw new Error('must not be reached once an earlier account-state check rejects login');
    },
    ...overrides,
  };
}

test('login() rejects an inactive User account before ever checking the password', async () => {
  authRepository.findUserByEmail = async () => baseUser({ status: 'inactive' });

  await assert.rejects(
    () => authService.login('user@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects a user whose PRIMARY role is inactive', async () => {
  authRepository.findUserByEmail = async () => baseUser({ role: activeRole({ status: 'inactive' }) });

  await assert.rejects(
    () => authService.login('user@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects a user whose linked Employee record is inactive', async () => {
  authRepository.findUserByEmail = async () => baseUser({
    employee: { id: 55, status: 'inactive', is_deleted: false },
  });

  await assert.rejects(
    () => authService.login('user@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'EMPLOYEE_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects a user whose linked Employee record is soft-deleted', async () => {
  authRepository.findUserByEmail = async () => baseUser({
    employee: { id: 55, status: 'active', is_deleted: true },
  });

  await assert.rejects(
    () => authService.login('user@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'EMPLOYEE_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() never runs the Employee check for an account with no linked Employee (Admin/Manager tiers)', async () => {
  let passwordChecked = false;
  authRepository.findUserByEmail = async () => baseUser({
    employee: null,
    validatePassword: async () => { passwordChecked = true; return false; },
  });

  await assert.rejects(
    () => authService.login('user@example.com', 'wrong-password'),
    (err) => {
      assert.equal(err.code, 'INVALID_CREDENTIALS');
      return true;
    }
  );
  assert.equal(passwordChecked, true);
  restore();
});
