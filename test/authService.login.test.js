'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported functions
// — authService.js holds a live reference to this SAME module-cached object,
// never destructured at call time, so mutating a property here is visible
// to the service's own calls. Same pattern as
// test/employeeService.duplicateCode.test.js. Employee-as-Identity redesign
// (database/migrations/20260864-20260880): login is Employee-based now, no
// more linked User account.
const authRepository = require('../src/repositories/authRepository');
const rbacService = require('../src/services/rbacService');
const authService = require('../src/services/authService');

const ORIGINAL = {
  findEmployeeByEmail: authRepository.findEmployeeByEmail,
  createSession: authRepository.createSession,
  updateLastLogin: authRepository.updateLastLogin,
  getActiveFormsForRoles: rbacService.getActiveFormsForRoles,
};

function restore() {
  authRepository.findEmployeeByEmail = ORIGINAL.findEmployeeByEmail;
  authRepository.createSession = ORIGINAL.createSession;
  authRepository.updateLastLogin = ORIGINAL.updateLastLogin;
  rbacService.getActiveFormsForRoles = ORIGINAL.getActiveFormsForRoles;
}

function stubHappyPathSideEffects() {
  authRepository.createSession = async () => ({});
  authRepository.updateLastLogin = async () => {};
  rbacService.getActiveFormsForRoles = async () => ({});
}

function activeRole(overrides) {
  return {
    id: 8,
    role_name: 'Employee',
    status: 'active',
    hierarchy_rank: 8,
    EmployeeRole: { status: 'active' },
    ...overrides,
  };
}

function baseEmployee(overrides) {
  return {
    id: 1,
    email: 'employee@example.com',
    password: 'hashed',
    status: 'active',
    is_deleted: false,
    roles: [activeRole()],
    businessUnits: [],
    toJSON() { return { ...this }; },
    validatePassword: async () => {
      throw new Error('must not be reached once an earlier account-state check rejects login');
    },
    ...overrides,
  };
}

test('login() rejects an inactive Employee account before ever checking the password', async () => {
  authRepository.findEmployeeByEmail = async () => baseEmployee({ status: 'inactive' });

  await assert.rejects(
    () => authService.login('employee@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects a soft-deleted Employee account before ever checking the password', async () => {
  authRepository.findEmployeeByEmail = async () => baseEmployee({ is_deleted: true });

  await assert.rejects(
    () => authService.login('employee@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects an Employee with no active role (role itself inactive)', async () => {
  authRepository.findEmployeeByEmail = async () => baseEmployee({ roles: [activeRole({ status: 'inactive' })] });

  await assert.rejects(
    () => authService.login('employee@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects an Employee with no active role (grant itself inactive)', async () => {
  authRepository.findEmployeeByEmail = async () => baseEmployee({
    roles: [activeRole({ EmployeeRole: { status: 'inactive' } })],
  });

  await assert.rejects(
    () => authService.login('employee@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_INACTIVE');
      return true;
    }
  );
  restore();
});

test('login() rejects an unregistered email without ever checking the password', async () => {
  authRepository.findEmployeeByEmail = async () => null;

  await assert.rejects(
    () => authService.login('nobody@example.com', 'whatever'),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'EMAIL_NOT_REGISTERED');
      return true;
    }
  );
  restore();
});

test('login() checks the password only after account-state checks pass, and rejects a wrong one', async () => {
  let passwordChecked = false;
  authRepository.findEmployeeByEmail = async () => baseEmployee({
    validatePassword: async () => { passwordChecked = true; return false; },
  });

  await assert.rejects(
    () => authService.login('employee@example.com', 'wrong-password'),
    (err) => {
      assert.equal(err.code, 'INVALID_CREDENTIALS');
      return true;
    }
  );
  assert.equal(passwordChecked, true);
  restore();
});

test('login() succeeds for an active Employee with an active role and the correct password', async () => {
  stubHappyPathSideEffects();
  authRepository.findEmployeeByEmail = async () => baseEmployee({ validatePassword: async () => true });

  const result = await authService.login('employee@example.com', 'correct-password');

  assert.equal(result.employee.id, 1);
  assert.equal(result.roles.length, 1);
  assert.equal(result.roles[0].name, 'Employee');
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  restore();
});
