'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch pattern as test/authService.login.test.js — authService.js
// holds a live reference to these module-cached objects, never destructured
// at call time, so mutating a property here is visible to the service's own
// calls.
const authRepository = require('../src/repositories/authRepository');
const rbacService = require('../src/services/rbacService');
const microsoftAuthService = require('../src/services/microsoftAuthService');
const authService = require('../src/services/authService');

const ORIGINAL = {
  findEmployeeByEmail: authRepository.findEmployeeByEmail,
  createSession: authRepository.createSession,
  updateLastLogin: authRepository.updateLastLogin,
  updateMicrosoftObjectId: authRepository.updateMicrosoftObjectId,
  getActiveFormsForRoles: rbacService.getActiveFormsForRoles,
  verifyMicrosoftIdToken: microsoftAuthService.verifyMicrosoftIdToken,
};

function restore() {
  authRepository.findEmployeeByEmail = ORIGINAL.findEmployeeByEmail;
  authRepository.createSession = ORIGINAL.createSession;
  authRepository.updateLastLogin = ORIGINAL.updateLastLogin;
  authRepository.updateMicrosoftObjectId = ORIGINAL.updateMicrosoftObjectId;
  rbacService.getActiveFormsForRoles = ORIGINAL.getActiveFormsForRoles;
  microsoftAuthService.verifyMicrosoftIdToken = ORIGINAL.verifyMicrosoftIdToken;
}

function stubHappyPathSideEffects() {
  authRepository.createSession = async () => ({});
  authRepository.updateLastLogin = async () => {};
  authRepository.updateMicrosoftObjectId = async () => {};
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
    ...overrides,
  };
}

function stubVerifiedToken(claims) {
  microsoftAuthService.verifyMicrosoftIdToken = async () => ({
    email: 'employee@example.com',
    oid: 'ms-oid-123',
    name: 'Test Employee',
    ...claims,
  });
}

test('loginWithMicrosoft() rejects an unregistered email without ever touching the Employee table for creation', async () => {
  stubVerifiedToken();
  authRepository.findEmployeeByEmail = async () => null;

  await assert.rejects(
    () => authService.loginWithMicrosoft('some-id-token'),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'EMAIL_NOT_REGISTERED');
      return true;
    }
  );
  restore();
});

test('loginWithMicrosoft() succeeds for an Employee with NO password set (SSO-only account)', async () => {
  stubHappyPathSideEffects();
  stubVerifiedToken();
  authRepository.findEmployeeByEmail = async () => baseEmployee({ password: null });

  const result = await authService.loginWithMicrosoft('some-id-token');

  assert.equal(result.employee.id, 1);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  restore();
});

test('loginWithMicrosoft() rejects an inactive Employee account', async () => {
  stubVerifiedToken();
  authRepository.findEmployeeByEmail = async () => baseEmployee({ status: 'inactive' });

  await assert.rejects(
    () => authService.loginWithMicrosoft('some-id-token'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('loginWithMicrosoft() rejects a soft-deleted Employee account', async () => {
  stubVerifiedToken();
  authRepository.findEmployeeByEmail = async () => baseEmployee({ is_deleted: true });

  await assert.rejects(
    () => authService.loginWithMicrosoft('some-id-token'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('loginWithMicrosoft() rejects an Employee with no active role', async () => {
  stubVerifiedToken();
  authRepository.findEmployeeByEmail = async () => baseEmployee({
    roles: [activeRole({ status: 'inactive' })],
  });

  await assert.rejects(
    () => authService.loginWithMicrosoft('some-id-token'),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_INACTIVE');
      return true;
    }
  );
  restore();
});

test('loginWithMicrosoft() returns requiresRoleSelection for an Employee with multiple active roles — same ticket mechanism as password login', async () => {
  stubHappyPathSideEffects();
  stubVerifiedToken();
  authRepository.findEmployeeByEmail = async () => baseEmployee({
    roles: [activeRole({ id: 8, role_name: 'Employee' }), activeRole({ id: 9, role_name: 'Manager' })],
  });

  const result = await authService.loginWithMicrosoft('some-id-token');

  assert.equal(result.requiresRoleSelection, true);
  assert.ok(result.loginTicket);
  assert.equal(result.roles.length, 2);
  restore();
});

test('loginWithMicrosoft() succeeds for an active Employee with a single active role and persists the Microsoft object id', async () => {
  stubHappyPathSideEffects();
  stubVerifiedToken({ oid: 'ms-oid-999' });
  authRepository.findEmployeeByEmail = async () => baseEmployee();

  let persistedOid = null;
  authRepository.updateMicrosoftObjectId = async (employeeId, oid) => {
    persistedOid = { employeeId, oid };
  };

  const result = await authService.loginWithMicrosoft('some-id-token');

  assert.equal(result.employee.id, 1);
  assert.equal(result.roles.length, 1);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);

  // updateMicrosoftObjectId is fire-and-forget (never awaited by the
  // service, so login isn't blocked on it) — give its microtask a tick.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persistedOid, { employeeId: 1, oid: 'ms-oid-999' });
  restore();
});

test('loginWithMicrosoft() never calls the Microsoft token verifier with anything but the raw idToken (no frontend-supplied claims trusted)', async () => {
  stubHappyPathSideEffects();
  let receivedArg;
  microsoftAuthService.verifyMicrosoftIdToken = async (arg) => {
    receivedArg = arg;
    return { email: 'employee@example.com', oid: 'ms-oid-123', name: null };
  };
  authRepository.findEmployeeByEmail = async () => baseEmployee();

  await authService.loginWithMicrosoft('the-raw-id-token');

  assert.equal(receivedArg, 'the-raw-id-token');
  restore();
});
