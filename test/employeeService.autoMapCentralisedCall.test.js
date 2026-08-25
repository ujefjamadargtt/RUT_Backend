'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/employeeService.duplicateCode.test.js —
// employeeService.js holds live references to these SAME module-cached
// objects, never destructured at call time.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const { Role, Company, sequelize } = require('../src/models');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  findByCode: employeeRepository.findByCode,
  findByEmail: employeeRepository.findByEmail,
  create: employeeRepository.create,
  replaceRoles: employeeRoleRepository.replaceForEmployee,
  replaceBUs: employeeBusinessUnitRepository.replaceForEmployee,
  autoMap: employeeServicePOMappingService.autoMapCentralisedServicePOs,
  resolveActorCompanyScope: companyAccessControlService.resolveActorCompanyScope,
  roleFindOne: Role.findOne,
  companyFindAll: Company.findAll,
  transaction: sequelize.transaction,
};

function restore() {
  employeeRepository.findByCode = ORIGINAL.findByCode;
  employeeRepository.findByEmail = ORIGINAL.findByEmail;
  employeeRepository.create = ORIGINAL.create;
  employeeRoleRepository.replaceForEmployee = ORIGINAL.replaceRoles;
  employeeBusinessUnitRepository.replaceForEmployee = ORIGINAL.replaceBUs;
  employeeServicePOMappingService.autoMapCentralisedServicePOs = ORIGINAL.autoMap;
  companyAccessControlService.resolveActorCompanyScope = ORIGINAL.resolveActorCompanyScope;
  Role.findOne = ORIGINAL.roleFindOne;
  Company.findAll = ORIGINAL.companyFindAll;
  sequelize.transaction = ORIGINAL.transaction;
}

function stubCommonCreatePath({ companies, ownedScope }) {
  employeeRepository.findByCode = async () => null;
  employeeRepository.findByEmail = async () => null;
  employeeRepository.create = async (data) => ({ id: 900, ...data, toJSON() { return this; } });
  employeeRoleRepository.replaceForEmployee = async () => {};
  employeeBusinessUnitRepository.replaceForEmployee = async () => {};
  Role.findOne = async () => ({ id: 8, role_name: 'Employee', status: 'active', hierarchy_rank: 8 });
  Company.findAll = async () => companies;
  // Only relevant for a company-less actor (resolveBusinessUnitIds()'s
  // ownership check) — a BU-scoped actor's own companyId always wins
  // before this is even consulted, so a plain number here is harmless.
  if (ownedScope !== undefined) {
    companyAccessControlService.resolveActorCompanyScope = async () => ownedScope;
  }
  // Real pass-through transaction (not stopped early) — we need execution
  // to actually reach the autoMapCentralisedServicePOs call(s).
  sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
}

test('create(): a BU-scoped actor (own companyId, no explicit business_unit_ids) calls autoMap once with that companyId', async () => {
  stubCommonCreatePath({ companies: [{ id: 10 }] });

  const calls = [];
  employeeServicePOMappingService.autoMapCentralisedServicePOs = async (employeeId, companyId) => {
    calls.push({ employeeId, companyId });
  };

  const authContext = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };
  await employeeService.create(
    { full_name: 'New Hire', email: 'bu-scoped@example.com', role_ids: [8] },
    1, '127.0.0.1', authContext
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, 10);

  restore();
});

test('create(): a company-less actor assigning business_unit_ids calls autoMap once per assigned BU', async () => {
  stubCommonCreatePath({ companies: [{ id: 20 }, { id: 21 }], ownedScope: [20, 21] });

  const calls = [];
  employeeServicePOMappingService.autoMapCentralisedServicePOs = async (employeeId, companyId) => {
    calls.push({ employeeId, companyId });
  };

  const authContext = { userId: 2, employeeId: 200, companyId: null, hierarchyRank: 2, roleNames: [] };
  await employeeService.create(
    { full_name: 'New Hire', email: 'admin-assigned@example.com', role_ids: [8], business_unit_ids: [20, 21] },
    2, '127.0.0.1', authContext
  );

  assert.deepEqual(calls.map((c) => c.companyId).sort(), [20, 21]);

  restore();
});

test('create(): an employee created with NO Business Unit at all still calls autoMap once with companyId: null (Centralised POs reach BU-less employees too)', async () => {
  stubCommonCreatePath({ companies: [] });

  const calls = [];
  employeeServicePOMappingService.autoMapCentralisedServicePOs = async (employeeId, companyId) => {
    calls.push({ employeeId, companyId });
  };

  const authContext = { userId: 2, employeeId: 200, companyId: null, hierarchyRank: 2, roleNames: [] };
  await employeeService.create(
    { full_name: 'New Hire', email: 'no-bu@example.com', role_ids: [8] },
    2, '127.0.0.1', authContext
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, null);

  restore();
});
