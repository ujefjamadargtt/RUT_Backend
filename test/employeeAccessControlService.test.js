'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

// Required BEFORE the service so we can monkey-patch their exported
// functions/static methods — employeeAccessControlService.js holds live
// references to these SAME module-cached objects (require(...) then call
// `.someFn(...)`, never destructured at call time), so mutating a property
// here is visible to the service's own calls. Consistent with this repo's
// plain node:test setup (see test/servicePOHierarchyService.deleteGuard.test.js).
const { Entity, Company } = require('../src/models');
const employeeRepository = require('../src/repositories/employeeRepository');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const teamMappingRepository = require('../src/repositories/teamMappingRepository');
const { resolveEmployeeAccessWhere } = require('../src/services/employeeAccessControlService');

const ORIGINAL = {
  entityFindAll: Entity.findAll,
  companyFindAll: Company.findAll,
  employeeScope: employeeRepository.employeeScope,
  findByManager: managerEmployeeMappingRepository.findByManager,
  findByManagerEmployeeIds: managerEmployeeMappingRepository.findByManagerEmployeeIds,
  findByServicePOAdmin: teamMappingRepository.findByServicePOAdmin,
};

// Deterministic stand-in for the real employeeScope() (which otherwise
// hits employee_business_units for real) — no Employee in these tests has
// a Business Unit membership, so it degrades to the legacy bare company_id
// filter these tests were written against.
function stubEmployeeScopeAsLegacyOnly() {
  employeeRepository.employeeScope = async (companyId) => {
    if (companyId == null) return {};
    return Array.isArray(companyId) ? { company_id: { [Op.in]: companyId } } : { company_id: companyId };
  };
}

function restore() {
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  employeeRepository.employeeScope = ORIGINAL.employeeScope;
  managerEmployeeMappingRepository.findByManager = ORIGINAL.findByManager;
  managerEmployeeMappingRepository.findByManagerEmployeeIds = ORIGINAL.findByManagerEmployeeIds;
  teamMappingRepository.findByServicePOAdmin = ORIGINAL.findByServicePOAdmin;
}

function stubNoMappings() {
  managerEmployeeMappingRepository.findByManager = async () => [];
  managerEmployeeMappingRepository.findByManagerEmployeeIds = async () => [];
  teamMappingRepository.findByServicePOAdmin = async () => [];
}

test('Admin (rank 2) owning Entities is scoped to Employees they created OR Companies under those Entities (transitively) — never unrestricted', async () => {
  stubEmployeeScopeAsLegacyOnly();
  // Same "Entities this Admin owns" resolution requireAdmin.js/
  // companyAccessControlService.resolveOwnedCompanyIds already use for
  // Company/Entity Master — a second, unrelated Admin must never see the
  // first Admin's Employees, so this must NOT be `{}` (unrestricted).
  Entity.findAll = async ({ where }) => {
    assert.deepEqual(where[Object.getOwnPropertySymbols(where)[0]], [
      { created_by: 1 },
      { '$entityAdmin.created_by$': 1 },
    ]);
    return [{ id: 6 }, { id: 7 }];
  };
  Company.findAll = async ({ where }) => {
    const opIn = Object.getOwnPropertySymbols(where.entity_id)[0];
    assert.deepEqual([...where.entity_id[opIn]], [6, 7]);
    return [{ id: 46 }, { id: 47 }];
  };

  const where = await resolveEmployeeAccessWhere({
    userId: 1, employeeId: 1, companyId: null, hierarchyRank: 2, roleNames: ['Admin'],
  });

  const opOr = Object.getOwnPropertySymbols(where)[0];
  const [ownWhere, companyWhere] = where[opOr];
  const ownOpOr = Object.getOwnPropertySymbols(ownWhere)[0];
  assert.deepEqual(ownWhere[ownOpOr], [{ id: 1 }, { created_by: 1 }]);
  const opIn = Object.getOwnPropertySymbols(companyWhere.company_id)[0];
  assert.deepEqual([...companyWhere.company_id[opIn]], [46, 47]);
  restore();
});

test('Admin (rank 2) owning zero Entities falls back to their own record plus Employees they directly created, never unrestricted', async () => {
  Entity.findAll = async () => [];
  Company.findAll = async () => { throw new Error('must not be called when no Entities are owned'); };

  const where = await resolveEmployeeAccessWhere({
    userId: 1, employeeId: 1, companyId: null, hierarchyRank: 2, roleNames: ['Admin'],
  });

  const opOr = Object.getOwnPropertySymbols(where)[0];
  assert.deepEqual(where[opOr], [{ id: 1 }, { created_by: 1 }]);
  restore();
});

test('Entity Admin (rank 3) with owned Entities is scoped to Companies under them', async () => {
  stubEmployeeScopeAsLegacyOnly();
  Entity.findAll = async ({ where }) => {
    assert.equal(where.entity_admin_employee_id, 50);
    return [{ id: 6 }, { id: 7 }];
  };
  Company.findAll = async ({ where }) => {
    assert.deepEqual([...where.entity_id[Object.getOwnPropertySymbols(where.entity_id)[0]]], [6, 7]);
    return [{ id: 46 }, { id: 47 }];
  };

  const where = await resolveEmployeeAccessWhere({
    userId: 50, employeeId: 50, companyId: null, hierarchyRank: 3, roleNames: ['Entity Admin'],
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
  stubEmployeeScopeAsLegacyOnly();
  const where = await resolveEmployeeAccessWhere({
    userId: 120, employeeId: null, companyId: 54, hierarchyRank: 4, roleNames: ['BU Admin'],
  });
  assert.deepEqual(where, { company_id: 54 });
  restore();
});

test('Project Admin (rank 5) is scoped to their own Company only (documented gap: no narrower mapping table exists yet)', async () => {
  stubEmployeeScopeAsLegacyOnly();
  const where = await resolveEmployeeAccessWhere({
    userId: 146, employeeId: 461, companyId: 54, hierarchyRank: 5, roleNames: ['Project Admin'],
  });
  assert.deepEqual(where, { company_id: 54 });
  restore();
});

test('HR (no hierarchy_rank) is scoped to their own Company only', async () => {
  stubEmployeeScopeAsLegacyOnly();
  const where = await resolveEmployeeAccessWhere({
    userId: 200, employeeId: null, companyId: 38, hierarchyRank: null, roleNames: ['HR'],
  });
  assert.deepEqual(where, { company_id: 38 });
  restore();
});

test('BU Admin / Project Admin / HR with no companyId is denied everything, never unrestricted', async () => {
  const where = await resolveEmployeeAccessWhere({
    userId: 1, employeeId: null, companyId: null, hierarchyRank: 4, roleNames: ['BU Admin'],
  });
  assert.deepEqual(where, { id: -1 });
});

test('Employee with no mappings and no additional role sees only their own Employee record', async () => {
  stubNoMappings();
  stubEmployeeScopeAsLegacyOnly();

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
  stubEmployeeScopeAsLegacyOnly();
  managerEmployeeMappingRepository.findByManager = async (managerEmployeeId, companyId) => {
    assert.equal(managerEmployeeId, 434);
    assert.equal(companyId, 54);
    return [{ employee_id: 435 }, { employee_id: 438 }, { employee_id: 450 }, { employee_id: 455 }];
  };
  managerEmployeeMappingRepository.findByManagerEmployeeIds = async () => [];
  teamMappingRepository.findByServicePOAdmin = async () => [];

  const where = await resolveEmployeeAccessWhere({
    userId: 121, employeeId: 434, companyId: 54, hierarchyRank: 7, roleNames: ['Manager'],
  });

  const opIn = Object.getOwnPropertySymbols(where.id)[0];
  assert.deepEqual([...where.id[opIn]].sort((a, b) => a - b), [434, 435, 438, 450, 455]);
  restore();
});

test('A caller whose ROLE is Service PO Admin but who ALSO holds a direct manager_employee_mappings row (a Secondary Manager mapping, unrelated to their role name) is granted that Employee too — access is data-driven, never role-name-gated', async () => {
  stubEmployeeScopeAsLegacyOnly();
  managerEmployeeMappingRepository.findByManager = async (managerEmployeeId) => {
    assert.equal(managerEmployeeId, 438);
    return [{ employee_id: 450 }]; // Secondary Manager mapping, despite the Service PO Admin role
  };
  managerEmployeeMappingRepository.findByManagerEmployeeIds = async () => [];
  teamMappingRepository.findByServicePOAdmin = async () => [];

  const where = await resolveEmployeeAccessWhere({
    userId: 128, employeeId: 438, companyId: 54, hierarchyRank: 6, roleNames: ['Service PO Admin'],
  });

  const opIn = Object.getOwnPropertySymbols(where.id)[0];
  assert.deepEqual([...where.id[opIn]].sort((a, b) => a - b), [438, 450]);
  restore();
});

test('Service PO Admin scope includes every Employee mapped to a Manager on their team_mappings roster', async () => {
  stubEmployeeScopeAsLegacyOnly();
  managerEmployeeMappingRepository.findByManager = async () => [];
  teamMappingRepository.findByServicePOAdmin = async (servicePOAdminEmployeeId, companyId) => {
    assert.equal(servicePOAdminEmployeeId, 414);
    assert.equal(companyId, 46);
    return [{ manager_employee_id: 104 }, { manager_employee_id: 121 }];
  };
  managerEmployeeMappingRepository.findByManagerEmployeeIds = async (managerUserIds, companyId) => {
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

test('BU Admin (rank 4) also matches an Employee whose Business Unit membership lives ONLY in employee_business_units (company_id NULL) — not just legacy company_id rows', async () => {
  // Regression test for the empty-manager-dropdown bug: an Employee created
  // after the Employee-Business-Unit redesign never gets employees.company_id
  // populated, so a bare `{ company_id: companyId }` filter silently excluded
  // every such Employee from GET /employees/active/list (the Primary/
  // Secondary Manager dropdown's data source) for a BU-scoped actor.
  employeeRepository.employeeScope = async (companyId) => ({
    [Op.or]: [{ company_id: companyId }, { id: { [Op.in]: [777] } }],
  });

  const where = await resolveEmployeeAccessWhere({
    userId: 120, employeeId: null, companyId: 54, hierarchyRank: 4, roleNames: ['BU Admin'],
  });

  const opOr = Object.getOwnPropertySymbols(where)[0];
  const [companyCondition, buCondition] = where[opOr];
  assert.deepEqual(companyCondition, { company_id: 54 });
  const opIn = Object.getOwnPropertySymbols(buCondition.id)[0];
  assert.deepEqual([...buCondition.id[opIn]], [777]);
  restore();
});
