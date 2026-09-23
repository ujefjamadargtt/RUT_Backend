'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Section 6 of the PM redesign spec: employeeService.js's update() is the
// concrete role-update path in this codebase (Employee Master's role
// checkboxes) — when it removes the Project Manager role from an Employee,
// every Service PO mapping row where they were explicitly marked as PM
// (is_project_manager = true) must revert to a plain employee mapping,
// inside the SAME transaction, via employeeServicePOMappingService.
// clearProjectManagerAssignmentsForEmployee(). Same monkey-patch style as
// test/employeeService.duplicateCode.test.js.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const { Role, sequelize } = require('../src/models');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  findByIdWithEmail: employeeRepository.findByIdWithEmail,
  update: employeeRepository.update,
  replaceForEmployee: employeeRoleRepository.replaceForEmployee,
  clearProjectManagerAssignmentsForEmployee: employeeServicePOMappingService.clearProjectManagerAssignmentsForEmployee,
  roleFindOne: Role.findOne,
  transaction: sequelize.transaction,
};

function restore() {
  employeeRepository.findByIdWithEmail = ORIGINAL.findByIdWithEmail;
  employeeRepository.update = ORIGINAL.update;
  employeeRoleRepository.replaceForEmployee = ORIGINAL.replaceForEmployee;
  employeeServicePOMappingService.clearProjectManagerAssignmentsForEmployee = ORIGINAL.clearProjectManagerAssignmentsForEmployee;
  Role.findOne = ORIGINAL.roleFindOne;
  sequelize.transaction = ORIGINAL.transaction;
}

// BU Admin (rank 4) — the simplest resolveActorCompanyScope branch (a plain
// companyId, no extra DB calls), matching test/employeeService.duplicateCode.test.js.
const AUTH_CONTEXT = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };

const ROLES_BY_ID = {
  4: { id: 4, role_name: 'Project Manager', status: 'active', hierarchy_rank: 6 },
  5: { id: 5, role_name: 'Team Lead', status: 'active', hierarchy_rank: 7 },
  8: { id: 8, role_name: 'Employee', status: 'active', hierarchy_rank: 8 },
};

function stubRoles() {
  Role.findOne = async ({ where }) => ROLES_BY_ID[where.id] || null;
}

function stubEmployeeLookup() {
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP777', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
}

test('update(): removing the Project Manager role (not in the new role_ids) cascades to clear every PM-flagged Service PO mapping, inside the same transaction', async () => {
  try {
    stubEmployeeLookup();
    stubRoles();
    employeeRepository.update = async () => ({ toJSON: () => ({}) });
    employeeRoleRepository.replaceForEmployee = async () => {};

    let cascadeArgs = null;
    employeeServicePOMappingService.clearProjectManagerAssignmentsForEmployee = async (employeeId, userId, transaction) => {
      cascadeArgs = { employeeId, userId, transaction };
      // Stops the call chain right here, deterministically, so this test
      // never falls through to the (unmocked) post-transaction refresh
      // steps — same technique as employeeService.duplicateCode.test.js's
      // stopBeforeTransaction().
      throw new Error('__stopped_after_cascade__');
    };
    sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });

    // Was previously Project Manager (4) + Employee (8); this update's
    // role_ids no longer includes 4 — the role is being removed.
    await assert.rejects(
      () => employeeService.update(61, { role_ids: [8] }, 1, '127.0.0.1', AUTH_CONTEXT),
      (err) => err.message === '__stopped_after_cascade__'
    );

    assert.deepEqual(cascadeArgs, { employeeId: 61, userId: 1, transaction: { __fakeTransaction: true } });
  } finally {
    restore();
  }
});

test('update(): the new role_ids still includes Project Manager — the cascade is never called', async () => {
  try {
    stubEmployeeLookup();
    stubRoles();
    employeeRepository.update = async () => ({ toJSON: () => ({}) });
    employeeRoleRepository.replaceForEmployee = async () => {};
    employeeServicePOMappingService.clearProjectManagerAssignmentsForEmployee = async () => {
      throw new Error('must not be called — the Project Manager role is still held after this update');
    };
    sequelize.transaction = async (fn) => {
      await fn({ __fakeTransaction: true });
      throw new Error('__reached_end_of_transaction__');
    };

    await assert.rejects(
      () => employeeService.update(61, { role_ids: [4, 8] }, 1, '127.0.0.1', AUTH_CONTEXT),
      (err) => err.message === '__reached_end_of_transaction__'
    );
  } finally {
    restore();
  }
});

test('update(): an Employee who never held Project Manager in the first place is unaffected — the cascade is still a no-op call, never an error', async () => {
  try {
    stubEmployeeLookup();
    stubRoles();
    employeeRepository.update = async () => ({ toJSON: () => ({}) });
    employeeRoleRepository.replaceForEmployee = async () => {};
    let cascadeCalled = false;
    employeeServicePOMappingService.clearProjectManagerAssignmentsForEmployee = async () => {
      cascadeCalled = true;
      return 0; // no PM-flagged rows existed to clear
    };
    sequelize.transaction = async (fn) => {
      await fn({ __fakeTransaction: true });
      throw new Error('__reached_end_of_transaction__');
    };

    await assert.rejects(
      () => employeeService.update(61, { role_ids: [5, 8] }, 1, '127.0.0.1', AUTH_CONTEXT), // Team Lead + Employee, never PM
      (err) => err.message === '__reached_end_of_transaction__'
    );

    assert.equal(cascadeCalled, true);
  } finally {
    restore();
  }
});

test('update(): role_ids omitted from the payload never touches employee_roles or the PM cascade at all', async () => {
  try {
    stubEmployeeLookup();
    employeeRepository.update = async () => ({ toJSON: () => ({}) });
    employeeRoleRepository.replaceForEmployee = async () => {
      throw new Error('must not be called — role_ids was not part of this update');
    };
    employeeServicePOMappingService.clearProjectManagerAssignmentsForEmployee = async () => {
      throw new Error('must not be called — role_ids was not part of this update');
    };
    sequelize.transaction = async (fn) => {
      await fn({ __fakeTransaction: true });
      throw new Error('__reached_end_of_transaction__');
    };

    await assert.rejects(
      () => employeeService.update(61, { full_name: 'Renamed Only' }, 1, '127.0.0.1', AUTH_CONTEXT),
      (err) => err.message === '__reached_end_of_transaction__'
    );
  } finally {
    restore();
  }
});
