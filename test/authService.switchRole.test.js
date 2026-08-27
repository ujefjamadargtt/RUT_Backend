'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch pattern as test/authService.login.test.js — authService.js
// holds a live reference to these module-cached objects, so mutating a
// property here is visible to the service's own calls.
const authRepository = require('../src/repositories/authRepository');
const rbacService = require('../src/services/rbacService');
const authService = require('../src/services/authService');

const ORIGINAL = {
  findEmployeeById: authRepository.findEmployeeById,
  createSession: authRepository.createSession,
  updateLastLogin: authRepository.updateLastLogin,
  getActiveFormsForRoles: rbacService.getActiveFormsForRoles,
};

function restore() {
  authRepository.findEmployeeById = ORIGINAL.findEmployeeById;
  authRepository.createSession = ORIGINAL.createSession;
  authRepository.updateLastLogin = ORIGINAL.updateLastLogin;
  rbacService.getActiveFormsForRoles = ORIGINAL.getActiveFormsForRoles;
}

function stubHappyPathSideEffects() {
  authRepository.createSession = async () => ({});
  authRepository.updateLastLogin = async () => {};
  rbacService.getActiveFormsForRoles = async () => ({});
}

function role(overrides) {
  return {
    id: 8,
    role_name: 'Employee',
    permission: 'Read',
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
    status: 'active',
    is_deleted: false,
    roles: [role()],
    businessUnits: [],
    toJSON() { return { ...this }; },
    ...overrides,
  };
}

test('switchRole() rejects an inactive Employee account', async () => {
  authRepository.findEmployeeById = async () => baseEmployee({ status: 'inactive' });

  await assert.rejects(
    () => authService.switchRole(1, 8),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('switchRole() rejects a soft-deleted Employee account', async () => {
  authRepository.findEmployeeById = async () => baseEmployee({ is_deleted: true });

  await assert.rejects(
    () => authService.switchRole(1, 8),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('switchRole() rejects a missing Employee account', async () => {
  authRepository.findEmployeeById = async () => null;

  await assert.rejects(
    () => authService.switchRole(1, 8),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ACCOUNT_INACTIVE');
      return true;
    }
  );
  restore();
});

test('switchRole() rejects a roleId not assigned to this employee at all (never trusts the caller-supplied roleId blindly)', async () => {
  authRepository.findEmployeeById = async () => baseEmployee({
    roles: [role({ id: 2, role_name: 'Admin' }), role({ id: 4, role_name: 'BU Admin' })],
  });

  await assert.rejects(
    () => authService.switchRole(1, 999 /* e.g. Entity Admin — never granted to this employee */),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_NOT_AVAILABLE');
      return true;
    }
  );
  restore();
});

test('switchRole() rejects a role the employee holds but whose ROLE record is inactive', async () => {
  authRepository.findEmployeeById = async () => baseEmployee({
    roles: [
      role({ id: 2, role_name: 'Admin' }),
      role({ id: 4, role_name: 'BU Admin', status: 'inactive' }),
    ],
  });

  await assert.rejects(
    () => authService.switchRole(1, 4),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_NOT_AVAILABLE');
      return true;
    }
  );
  restore();
});

test('switchRole() rejects a role the employee holds but whose GRANT (employee_roles) is inactive', async () => {
  authRepository.findEmployeeById = async () => baseEmployee({
    roles: [
      role({ id: 2, role_name: 'Admin' }),
      role({ id: 4, role_name: 'BU Admin', EmployeeRole: { status: 'inactive' } }),
    ],
  });

  await assert.rejects(
    () => authService.switchRole(1, 4),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ROLE_NOT_AVAILABLE');
      return true;
    }
  );
  restore();
});

test('switchRole() switches Admin -> BU Admin for a two-role employee and scopes the new session to BU Admin only', async () => {
  stubHappyPathSideEffects();
  authRepository.findEmployeeById = async () => baseEmployee({
    roles: [
      role({ id: 2, role_name: 'Admin', hierarchy_rank: 2 }),
      role({ id: 4, role_name: 'BU Admin', hierarchy_rank: 4 }),
    ],
  });

  const result = await authService.switchRole(1, 4);

  assert.equal(result.roles.length, 1);
  assert.equal(result.roles[0].id, 4);
  assert.equal(result.roles[0].name, 'BU Admin');
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  restore();
});

test('switchRole() switches BU Admin -> Admin (the reverse direction)', async () => {
  stubHappyPathSideEffects();
  authRepository.findEmployeeById = async () => baseEmployee({
    roles: [
      role({ id: 2, role_name: 'Admin', hierarchy_rank: 2 }),
      role({ id: 4, role_name: 'BU Admin', hierarchy_rank: 4 }),
    ],
  });

  const result = await authService.switchRole(1, 2);

  assert.equal(result.roles.length, 1);
  assert.equal(result.roles[0].id, 2);
  assert.equal(result.roles[0].name, 'Admin');
  restore();
});

test('switchRole() supports switching among three assigned roles (Admin / Entity Admin / BU Admin)', async () => {
  stubHappyPathSideEffects();
  const employee = baseEmployee({
    roles: [
      role({ id: 2, role_name: 'Admin', hierarchy_rank: 2 }),
      role({ id: 3, role_name: 'Entity Admin', hierarchy_rank: 3 }),
      role({ id: 4, role_name: 'BU Admin', hierarchy_rank: 4 }),
    ],
  });
  authRepository.findEmployeeById = async () => employee;

  const toEntityAdmin = await authService.switchRole(1, 3);
  assert.equal(toEntityAdmin.roles[0].name, 'Entity Admin');

  const toBuAdmin = await authService.switchRole(1, 4);
  assert.equal(toBuAdmin.roles[0].name, 'BU Admin');

  restore();
});

test('switchRole() result carries the target role\'s own hierarchyRank/permission, not the previously active role\'s (authorization actually follows the new role)', async () => {
  stubHappyPathSideEffects();
  authRepository.findEmployeeById = async () => baseEmployee({
    roles: [
      role({ id: 2, role_name: 'Admin', hierarchy_rank: 2, permission: 'Read & Write' }),
      role({ id: 4, role_name: 'BU Admin', hierarchy_rank: 4, permission: 'Read' }),
    ],
  });

  const result = await authService.switchRole(1, 4);

  assert.equal(result.roles[0].hierarchyRank, 4);
  assert.equal(result.roles[0].permission, 'Read');
  restore();
});
