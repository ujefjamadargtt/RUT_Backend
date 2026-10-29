'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Primary/Secondary Manager (the Employee Master "Team Lead" pickers) must
// hold the Team Lead role DIRECTLY — Project Manager inherits Team Lead's
// capabilities (config/roleHierarchy.js) but routes approvals via Service
// PO, so it must neither be offered by GET /employees/eligible-managers
// nor accepted on save. Same monkey-patch style as
// employeeService.duplicateCode.test.js.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const { Role, sequelize } = require('../src/models');
const employeeService = require('../src/services/employeeService');
// Tenant (owning Admin) resolution is a DB lookup — pinned here; code uniqueness is checked per Admin tenant.
require('../src/services/companyAccessControlService').resolveTenantAdminId = async () => 7;

const TEAM_LEAD_ROLE_ID = 3;
const PROJECT_MANAGER_ROLE_ID = 2;

const ORIGINAL = {
  findById: employeeRepository.findById,
  findByIdWithEmail: employeeRepository.findByIdWithEmail,
  findByCodeInTenant: employeeRepository.findByCodeInTenant,
  findByEmail: employeeRepository.findByEmail,
  findEligibleManagers: employeeRepository.findEligibleManagers,
  findIdsByEmployeeId: employeeRoleRepository.findIdsByEmployeeId,
  findByEmployeeAndType: managerEmployeeMappingRepository.findByEmployeeAndType,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  roleFindOne: Role.findOne,
  transaction: sequelize.transaction,
};

function restore() {
  employeeRepository.findById = ORIGINAL.findById;
  employeeRepository.findByIdWithEmail = ORIGINAL.findByIdWithEmail;
  employeeRepository.findByCodeInTenant = ORIGINAL.findByCodeInTenant;
  employeeRepository.findByEmail = ORIGINAL.findByEmail;
  employeeRepository.findEligibleManagers = ORIGINAL.findEligibleManagers;
  employeeRoleRepository.findIdsByEmployeeId = ORIGINAL.findIdsByEmployeeId;
  managerEmployeeMappingRepository.findByEmployeeAndType = ORIGINAL.findByEmployeeAndType;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  Role.findOne = ORIGINAL.roleFindOne;
  sequelize.transaction = ORIGINAL.transaction;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };

function stubCommon({ managerRoleIds, currentPrimaryManagerId = null }) {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => null;
  // create() also resolves its default "Employee" role through Role.findOne.
  Role.findOne = async ({ where }) => (where.role_name === 'Team Lead'
    ? { id: TEAM_LEAD_ROLE_ID }
    : { id: 8, role_name: 'Employee', status: 'active', hierarchy_rank: 8 });
  employeeRepository.findByIdWithEmail = async () => ({
    id: 61, employee_code: 'EMP061', company_id: 10, is_deleted: false, toJSON() { return this; },
  });
  employeeRepository.findById = async (id) => ({ id, status: 'active', company_id: 10 });
  employeeRoleRepository.findIdsByEmployeeId = async () => managerRoleIds;
  managerEmployeeMappingRepository.findByEmployeeAndType = async (employeeId, type) =>
    (type === 'PRIMARY' && currentPrimaryManagerId ? { manager_employee_id: currentPrimaryManagerId } : null);
  sequelize.transaction = async () => { throw new Error('__stopped_before_transaction__'); };
}

test('getEligibleManagers() queries ONLY the Team Lead role id (not every role inheriting its capability)', async () => {
  stubCommon({ managerRoleIds: [] });
  employeeRepository.findEligibleManagers = async (companyId, roleIds) => {
    assert.deepEqual(roleIds, [TEAM_LEAD_ROLE_ID]);
    return [{ id: 7, employee_code: 'TL7', full_name: 'Tee Ell', designation: null, status: 'active' }];
  };

  const result = await employeeService.getEligibleManagers(AUTH_CONTEXT);
  assert.deepEqual(result.map((e) => e.id), [7]);
  restore();
});

test('update() rejects NEWLY assigning a Project Manager as Primary Manager', async () => {
  stubCommon({ managerRoleIds: [PROJECT_MANAGER_ROLE_ID], currentPrimaryManagerId: 5 });

  await assert.rejects(
    () => employeeService.update(61, { primary_manager_employee_id: 40 }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Primary Manager must hold the Team Lead role/);
      return true;
    }
  );
  restore();
});

test('update() accepts a Team Lead as Primary Manager', async () => {
  stubCommon({ managerRoleIds: [TEAM_LEAD_ROLE_ID], currentPrimaryManagerId: 5 });

  await assert.rejects(
    () => employeeService.update(61, { primary_manager_employee_id: 40 }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});

test('update() does not re-validate an UNCHANGED legacy (pre-rule) Project Manager mapping', async () => {
  stubCommon({ managerRoleIds: [PROJECT_MANAGER_ROLE_ID], currentPrimaryManagerId: 40 });

  await assert.rejects(
    () => employeeService.update(61, { primary_manager_employee_id: 40 }, 1, '127.0.0.1', AUTH_CONTEXT),
    (err) => err.message === '__stopped_before_transaction__'
  );
  restore();
});

test('create() rejects a Project Manager as Primary Manager', async () => {
  stubCommon({ managerRoleIds: [PROJECT_MANAGER_ROLE_ID] });
  employeeRepository.findByCodeInTenant = async () => null;
  employeeRepository.findByEmail = async () => null;

  await assert.rejects(
    () => employeeService.create(
      { employee_code: 'EMP999', full_name: 'New Hire', email: 'x@example.com', primary_manager_employee_id: 40 },
      1, '127.0.0.1', AUTH_CONTEXT
    ),
    (err) => {
      assert.match(err.message, /Primary Manager must hold the Team Lead role/);
      return true;
    }
  );
  restore();
});

test.after(async () => {
  await sequelize.close();
});
