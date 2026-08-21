'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — authService.js holds live references to these SAME
// module-cached objects. Same pattern as test/authService.login.test.js.
const authRepository = require('../src/repositories/authRepository');
const rbacService = require('../src/services/rbacService');
const buHeadCompanyMappingRepository = require('../src/repositories/buHeadCompanyMappingRepository');
const authService = require('../src/services/authService');

const ORIGINAL = {
  findUserByEmail: authRepository.findUserByEmail,
  createSession: authRepository.createSession,
  updateLastLogin: authRepository.updateLastLogin,
  getActiveFormsForRoles: rbacService.getActiveFormsForRoles,
  findMappingsForBuHead: buHeadCompanyMappingRepository.findMappingsForBuHead,
};

function restore() {
  authRepository.findUserByEmail = ORIGINAL.findUserByEmail;
  authRepository.createSession = ORIGINAL.createSession;
  authRepository.updateLastLogin = ORIGINAL.updateLastLogin;
  rbacService.getActiveFormsForRoles = ORIGINAL.getActiveFormsForRoles;
  buHeadCompanyMappingRepository.findMappingsForBuHead = ORIGINAL.findMappingsForBuHead;
}

function stubHappyPathCollaborators() {
  authRepository.createSession = async () => {};
  authRepository.updateLastLogin = async () => {};
  rbacService.getActiveFormsForRoles = async () => ({});
}

function baseUser(overrides) {
  return {
    id: 500,
    email: 'bu.head@example.com',
    role_id: 20,
    employee_id: 428,
    status: 'active',
    role: { id: 20, role_name: 'BU Head', permission: 'Read & Write', status: 'active', hierarchy_rank: null },
    additionalRoles: [{ id: 8, role_name: 'Employee', permission: 'Read', status: 'active', hierarchy_rank: 8 }],
    employee: null,
    company: null,
    toJSON() { return { ...this }; },
    validatePassword: async () => true,
    ...overrides,
  };
}

test('login() attaches mapped_bu for a BU Head, sourced from bu_head_company_mappings', async () => {
  authRepository.findUserByEmail = async () => baseUser();
  buHeadCompanyMappingRepository.findMappingsForBuHead = async (userId) => {
    assert.equal(userId, 500);
    return [
      { company: { id: 52, company_name: 'ABC Technologies' } },
      { company: { id: 53, company_name: 'XYZ Technologies' } },
    ];
  };
  stubHappyPathCollaborators();

  const response = await authService.login('bu.head@example.com', 'whatever');

  assert.deepEqual(response.mapped_bu, [
    { id: 52, name: 'ABC Technologies' },
    { id: 53, name: 'XYZ Technologies' },
  ]);
  assert.deepEqual(
    response.roles.map((r) => r.name),
    ['BU Head', 'Employee']
  );
  restore();
});

test('login() never queries bu_head_company_mappings, and never sets mapped_bu, for a non-BU-Head role', async () => {
  let mappingQueried = false;
  authRepository.findUserByEmail = async () => baseUser({
    role: { id: 4, role_name: 'BU Admin', permission: 'Read & Write', status: 'active', hierarchy_rank: 4 },
    additionalRoles: [],
  });
  buHeadCompanyMappingRepository.findMappingsForBuHead = async () => {
    mappingQueried = true;
    return [];
  };
  stubHappyPathCollaborators();

  const response = await authService.login('bu.head@example.com', 'whatever');

  assert.equal(mappingQueried, false);
  assert.equal(response.mapped_bu, undefined);
  restore();
});
