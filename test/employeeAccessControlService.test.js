'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions/static methods — employeeAccessControlService.js holds live
// references to these SAME module-cached objects (require(...) then call
// `.someFn(...)`, never destructured at call time), so mutating a property
// here is visible to the service's own calls. Consistent with this repo's
// plain node:test setup (see test/servicePOHierarchyService.deleteGuard.test.js).
const { Entity, Company } = require('../src/models');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const teamMappingRepository = require('../src/repositories/teamMappingRepository');
const { resolveEmployeeAccessWhere } = require('../src/services/employeeAccessControlService');

const ORIGINAL = {
  entityFindAll: Entity.findAll,
  companyFindAll: Company.findAll,
  findByManager: managerEmployeeMappingRepository.findByManager,
  findByManagerUserIds: managerEmployeeMappingRepository.findByManagerUserIds,
  findByServicePOAdmin: teamMappingRepository.findByServicePOAdmin,
};

function restore() {
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  managerEmployeeMappingRepository.findByManager = ORIGINAL.findByManager;
  managerEmployeeMappingRepository.findByManagerUserIds = ORIGINAL.findByManagerUserIds;
  teamMappingRepository.findByServicePOAdmin = ORIGINAL.findByServicePOAdmin;
}

function stubNoMappings() {
  managerEmployeeMappingRepository.findByManager = async () => [];
  managerEmployeeMappingRepository.findByManagerUserIds = async () => [];
  teamMappingRepository.findByServicePOAdmin = async () => [];
}

test('Admin (rank 2) gets an unrestricted scope — never touches Entity/Company/mapping tables', async () => {
  Entity.findAll = async () => { throw new Error('must not be called for Admin'); };
  Company.findAll = async () => { throw new Error('must not be called for Admin'); };

  const where = await resolveEmployeeAccessWhere({
    userId: 1, employeeId: null, companyId: null, hierarchyRank: 2, roleNames: ['Admin'],
  });

  assert.deepEqual(where, {});
  restore();
});

test('Entity Admin (rank 3) with owned Entities is scoped to Companies under them', async () => {
  Entity.findAll = async ({ where }) => {
    assert.equal(where.entity_admin_user_id, 50);
    return [{ id: 6 }, { id: 7 }];
  };
  Company.findAll = async ({ where }) => {
    assert.deepEqual([...where.entity_id[Object.getOwnPropertySymbols(where.entity_id)[0]]], [6, 7]);
    return [{ id: 46 }, { id: 47 }];
  };

  const where = await resolveEmployeeAccessWhere({
    userId: 50, employeeId: null, companyId: null, hierarchyRank: 3, roleNames: ['Entity Admin'],
  });

  const opIn = Object.getOwnPropertySymbols(where.company_id)[0];
  assert.deepEqual([...where.company_id[opIn]], [46, 47]);
  restore();
});

test('Entity Admin owning no Entities is denied everything (id: -1), never falls back to company-wide', async () => {
  Entity.findAll = async () => [];
  Company.findAll = async () => { throw new Error('must not be called when no Entities are owned'); };

  const where = await resolveEmployeeAccessWhere({
    userId: 999, employeeId: null, companyId: null, hierarchyRank: 3, roleNames: ['Entity Admin'],
  });

  assert.deepEqual(where, { id: -1 });
  restore();
});

test('BU Admin (rank 4) is scoped to their own Company only', async () => {
  const where = await resolveEmployeeAccessWhere({
    userId: 120, employeeId: null, companyId: 54, hierarchyRank: 4, roleNames: ['BU Admin'],
  });
  assert.deepEqual(where, { company_id: 54 });
});

test('Project Admin (rank 5) is scoped to their own Company only (documented gap: no narrower mapping table exists yet)', async () => {
  const where = await resolveEmployeeAccessWhere({
    userId: 146, employeeId: 461, companyId: 54, hierarchyRank: 5, roleNames: ['Project Admin'],
  });
  assert.deepEqual(where, { company_id: 54 });
});

test('HR (no hierarchy_rank) is scoped to their own Company only', async () => {
  const where = await resolveEmployeeAccessWhere({
    userId: 200, employeeId: null, companyId: 38, hierarchyRank: null, roleNames: ['HR'],
  });
  assert.deepEqual(where, { company_id: 38 });
});

test('BU Admin / Project Admin / HR with no companyId is denied everything, never unrestricted', async () => {
  const where = await resolveEmployeeAccessWhere({
    userId: 1, employeeId: null, companyId: null, hierarchyRank: 4, roleNames: ['BU Admin'],
  });
  assert.deepEqual(where, { id: -1 });
});

test('Employee with no mappings and no additional role sees only their own Employee record', async () => {
  stubNoMappings();

  const where = await resolveEmployeeAccessWhere({
    userId: 108, employeeId: 428, companyId: 52, hierarchyRank: 8, roleNames: ['Employee'],
  });

  const opIn = Object.getOwnPropertySymbols(where.id)[0];
  assert.deepEqual([...where.id[opIn]], [428]);
  assert.equal(where.company_id, 52);
  restore();
});

test('Employee with no linked Employee record and no mappings is denied everything (id: -1)', async () => {
  stubNoMappings();

  const where = await resolveEmployeeAccessWhere({
    userId: 999, employeeId: null, companyId: 52, hierarchyRank: 8, roleNames: ['Employee'],
  });

  assert.deepEqual(where, { id: -1 });
  restore();
});

test('Manager scope is data-driven from manager_employee_mappings, unioned with their own record', async () => {
  managerEmployeeMappingRepository.findByManager = async (managerUserId, companyId) => {
    assert.equal(managerUserId, 121);
    assert.equal(companyId, 54);
    return [{ employee_id: 435 }, { employee_id: 438 }, { employee_id: 450 }, { employee_id: 455 }];
  };
  managerEmployeeMappingRepository.findByManagerUserIds = async () => [];
  teamMappingRepository.findByServicePOAdmin = async () => [];

  const where = await resolveEmployeeAccessWhere({
    userId: 121, employeeId: 434, companyId: 54, hierarchyRank: 7, roleNames: ['Manager'],
  });

  const opIn = Object.getOwnPropertySymbols(where.id)[0];
  assert.deepEqual([...where.id[opIn]].sort((a, b) => a - b), [434, 435, 438, 450, 455]);
  restore();
});

test('A caller whose ROLE is Service PO Admin but who ALSO holds a direct manager_employee_mappings row (a Secondary Manager mapping, unrelated to their role name) is granted that Employee too — access is data-driven, never role-name-gated', async () => {
  managerEmployeeMappingRepository.findByManager = async (managerUserId) => {
    assert.equal(managerUserId, 128);
    return [{ employee_id: 450 }]; // Secondary Manager mapping, despite the Service PO Admin role
  };
  managerEmployeeMappingRepository.findByManagerUserIds = async () => [];
  teamMappingRepository.findByServicePOAdmin = async () => [];

  const where = await resolveEmployeeAccessWhere({
    userId: 128, employeeId: 438, companyId: 54, hierarchyRank: 6, roleNames: ['Service PO Admin'],
  });

  const opIn = Object.getOwnPropertySymbols(where.id)[0];
  assert.deepEqual([...where.id[opIn]].sort((a, b) => a - b), [438, 450]);
  restore();
});

test('Service PO Admin scope includes every Employee mapped to a Manager on their team_mappings roster', async () => {
  managerEmployeeMappingRepository.findByManager = async () => [];
  teamMappingRepository.findByServicePOAdmin = async (servicePOAdminUserId, companyId) => {
    assert.equal(servicePOAdminUserId, 52);
    assert.equal(companyId, 46);
    return [{ manager_user_id: 104 }, { manager_user_id: 121 }];
  };
  managerEmployeeMappingRepository.findByManagerUserIds = async (managerUserIds, companyId) => {
    assert.deepEqual(managerUserIds.sort((a, b) => a - b), [104, 121]);
    assert.equal(companyId, 46);
    return [{ employee_id: 428 }, { employee_id: 433 }];
  };

  const where = await resolveEmployeeAccessWhere({
    userId: 52, employeeId: 414, companyId: 46, hierarchyRank: 6, roleNames: ['Service PO Admin'],
  });

  const opIn = Object.getOwnPropertySymbols(where.id)[0];
  assert.deepEqual([...where.id[opIn]].sort((a, b) => a - b), [414, 428, 433]);
  restore();
});

test('Manager/Employee-tier caller with no companyId is denied everything, not left unscoped', async () => {
  stubNoMappings();
  const where = await resolveEmployeeAccessWhere({
    userId: 121, employeeId: 434, companyId: null, hierarchyRank: 7, roleNames: ['Manager'],
  });
  assert.deepEqual(where, { id: -1 });
  restore();
});
