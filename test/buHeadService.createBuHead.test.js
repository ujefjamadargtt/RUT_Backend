'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — buHeadService.js holds live references to these SAME
// module-cached objects. Same pattern as
// test/employeeService.duplicateCode.test.js / test/formMasterService.test.js.
const roleRepository = require('../src/repositories/roleRepository');
const companyRepository = require('../src/repositories/companyRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const userRepository = require('../src/repositories/userRepository');
const userAdditionalRoleRepository = require('../src/repositories/userAdditionalRoleRepository');
const buHeadCompanyMappingRepository = require('../src/repositories/buHeadCompanyMappingRepository');
const { sequelize } = require('../src/models');
const buHeadService = require('../src/services/buHeadService');

const ORIGINAL = {
  findByName: roleRepository.findByName,
  findIdsByEntityIds: companyRepository.findIdsByEntityIds,
  findByCode: employeeRepository.findByCode,
  findByEmail: userRepository.findByEmail,
  findById: userRepository.findById,
  employeeCreate: employeeRepository.create,
  userCreate: userRepository.create,
  replaceForUser: userAdditionalRoleRepository.replaceForUser,
  bulkCreate: buHeadCompanyMappingRepository.bulkCreate,
  exists: buHeadCompanyMappingRepository.exists,
  findCompanyIdsForBuHead: buHeadCompanyMappingRepository.findCompanyIdsForBuHead,
  transaction: sequelize.transaction,
};

function restore() {
  roleRepository.findByName = ORIGINAL.findByName;
  companyRepository.findIdsByEntityIds = ORIGINAL.findIdsByEntityIds;
  employeeRepository.findByCode = ORIGINAL.findByCode;
  userRepository.findByEmail = ORIGINAL.findByEmail;
  userRepository.findById = ORIGINAL.findById;
  employeeRepository.create = ORIGINAL.employeeCreate;
  userRepository.create = ORIGINAL.userCreate;
  userAdditionalRoleRepository.replaceForUser = ORIGINAL.replaceForUser;
  buHeadCompanyMappingRepository.bulkCreate = ORIGINAL.bulkCreate;
  buHeadCompanyMappingRepository.exists = ORIGINAL.exists;
  buHeadCompanyMappingRepository.findCompanyIdsForBuHead = ORIGINAL.findCompanyIdsForBuHead;
  sequelize.transaction = ORIGINAL.transaction;
}

// A managed-transaction stub that just invokes the callback with a fake
// transaction token — a throw inside the callback propagates out through
// this await exactly like a real Sequelize transaction rejecting/rolling
// back would, which is what the "mid-transaction failure" test relies on.
function fakeTransaction() {
  sequelize.transaction = async (callback) => callback({ __fakeTransaction: true });
}

function stubRoles() {
  roleRepository.findByName = async (name) => {
    if (name === 'BU Head') return { id: 20, role_name: 'BU Head' };
    if (name === 'Employee') return { id: 8, role_name: 'Employee' };
    return null;
  };
}

const BASE_DATA = {
  employee_code: 'BUH001',
  full_name: 'Priya Shah',
  email: 'priya.shah@example.com',
  company_ids: [52, 53, 52], // deliberate duplicate — must be deduped
};

test('createBuHead() rejects a company_id outside the caller\'s own Entities, before any write', async () => {
  companyRepository.findIdsByEntityIds = async () => [52]; // 53 is NOT in scope
  employeeRepository.create = async () => { throw new Error('must not be reached — scope check should short-circuit first'); };

  await assert.rejects(
    () => buHeadService.createBuHead(BASE_DATA, 1, '127.0.0.1', [10]),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /Company #53 is not one of your own Entities' BUs/);
      return true;
    }
  );
  restore();
});

test('createBuHead() rejects an email already registered, before the transaction', async () => {
  companyRepository.findIdsByEntityIds = async () => [52, 53];
  employeeRepository.findByCode = async () => null;
  userRepository.findByEmail = async () => ({ id: 999, email: BASE_DATA.email });
  employeeRepository.create = async () => { throw new Error('must not be reached — email conflict should short-circuit first'); };

  await assert.rejects(
    () => buHeadService.createBuHead(BASE_DATA, 1, '127.0.0.1', [10]),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already exists/);
      return true;
    }
  );
  restore();
});

test('createBuHead() happy path: creates Employee (home company = company_ids[0]) + User (role=BU Head, company_id=null) + additional Employee role + deduped BU mappings, in one transaction', async () => {
  companyRepository.findIdsByEntityIds = async () => [52, 53];
  employeeRepository.findByCode = async () => null;
  userRepository.findByEmail = async () => null;
  stubRoles();
  fakeTransaction();

  const calls = {};
  employeeRepository.create = async (data, options) => {
    calls.employeeData = data;
    calls.employeeTxn = options && options.transaction;
    return { id: 700, employee_code: data.employee_code, full_name: data.full_name, company_id: data.company_id };
  };
  userRepository.create = async (data, options) => {
    calls.userData = data;
    calls.userTxn = options && options.transaction;
    return { id: 500, email: data.email, role_id: data.role_id, company_id: data.company_id };
  };
  userAdditionalRoleRepository.replaceForUser = async (userId, roleIds, actorId, transaction) => {
    calls.additionalRoleArgs = { userId, roleIds, actorId, transaction };
  };
  buHeadCompanyMappingRepository.bulkCreate = async (companyIds, buHeadUserId, actorId, options) => {
    calls.mappingArgs = { companyIds, buHeadUserId, actorId };
    calls.mappingTxn = options && options.transaction;
  };

  const result = await buHeadService.createBuHead(BASE_DATA, 1, '127.0.0.1', [10]);

  assert.equal(calls.employeeData.company_id, 52); // home company = company_ids[0]
  assert.equal(calls.employeeData.is_timesheet_approval_required, false);
  assert.ok(calls.employeeTxn.__fakeTransaction);

  assert.equal(calls.userData.role_id, 20); // BU Head role
  assert.equal(calls.userData.company_id, null); // not single-company scoped
  assert.equal(calls.userData.employee_id, 700);
  assert.ok(calls.userTxn.__fakeTransaction);

  assert.deepEqual(calls.additionalRoleArgs.roleIds, [8]); // Employee, additive
  assert.equal(calls.additionalRoleArgs.userId, 500);

  assert.deepEqual(calls.mappingArgs.companyIds, [52, 53]); // deduped, order preserved
  assert.equal(calls.mappingArgs.buHeadUserId, 500);
  assert.ok(calls.mappingTxn.__fakeTransaction);

  assert.equal(result.buHead.roles.length, 2);
  assert.ok(result.buHead.roles.includes('BU Head'));
  assert.ok(result.buHead.roles.includes('Employee'));
  assert.deepEqual(result.companyIds, [52, 53]);
  assert.ok(result.temporaryPassword); // no password supplied -> one generated and returned once

  restore();
});

test('createBuHead() propagates a mid-transaction failure — no mapping row is ever attempted', async () => {
  companyRepository.findIdsByEntityIds = async () => [52, 53];
  employeeRepository.findByCode = async () => null;
  userRepository.findByEmail = async () => null;
  stubRoles();
  fakeTransaction();

  employeeRepository.create = async () => ({ id: 701, employee_code: 'BUH001', full_name: 'Priya Shah', company_id: 52 });
  userRepository.create = async () => { throw new Error('duplicate key value violates unique constraint'); };
  let mappingAttempted = false;
  buHeadCompanyMappingRepository.bulkCreate = async () => { mappingAttempted = true; };

  await assert.rejects(
    () => buHeadService.createBuHead(BASE_DATA, 1, '127.0.0.1', [10]),
    (err) => /duplicate key/.test(err.message)
  );
  assert.equal(mappingAttempted, false);
  restore();
});

test('mapCompanies() rejects a company_id already mapped to this BU Head', async () => {
  // getById()'s internal lookups
  userRepository.findById = async () => ({ id: 500, role_id: 20 });
  roleRepository.findByName = async () => ({ id: 20 });
  companyRepository.findIdsByEntityIds = async () => [52, 53];
  buHeadCompanyMappingRepository.findCompanyIdsForBuHead = async () => [52];
  buHeadCompanyMappingRepository.exists = async (userId, companyId) => companyId === 52;

  await assert.rejects(
    () => buHeadService.mapCompanies(500, [52], [10], 1, { ip: '127.0.0.1' }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already mapped/);
      return true;
    }
  );
  restore();
});
