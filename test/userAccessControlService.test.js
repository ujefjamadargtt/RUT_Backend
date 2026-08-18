'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch static methods on the
// SAME module-cached model objects — userAccessControlService.js requires
// Entity/Company and calls `.findAll(...)` on them directly, never
// destructured at call time, so mutating the property here is visible to
// the service. Consistent with this repo's plain node:test setup (see
// test/employeeAccessControlService.test.js).
const { Entity, Company } = require('../src/models');
const {
  hasUserManagementPermission,
  resolveUserAccessWhere,
} = require('../src/services/userAccessControlService');

const ORIGINAL = {
  entityFindAll: Entity.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function reqWith({ hierarchyRank, capabilities = [] }) {
  return {
    user: { role: { hierarchy_rank: hierarchyRank } },
    capabilities: new Set(capabilities),
  };
}

test('Platform Admin / Admin / Entity Admin / BU Admin (senior tier, rank 1-4) have User Management permission', () => {
  for (const rank of [1, 2, 3, 4]) {
    assert.equal(hasUserManagementPermission(reqWith({ hierarchyRank: rank })), true, `rank ${rank}`);
  }
});

test('HR (no hierarchy_rank) has User Management permission via hr.manage_employee capability', () => {
  assert.equal(
    hasUserManagementPermission(reqWith({ hierarchyRank: null, capabilities: ['hr.manage_employee'] })),
    true
  );
});

test('Project Admin (5), Service PO Admin (6), Manager (7), Employee (8) are DENIED — no capability, no senior-tier bypass', () => {
  for (const rank of [5, 6, 7, 8]) {
    assert.equal(hasUserManagementPermission(reqWith({ hierarchyRank: rank })), false, `rank ${rank}`);
  }
});

test('A rank-8 Employee who happens to hold OTHER capabilities (but not hr.manage_employee) is still denied', () => {
  const req = reqWith({ hierarchyRank: 8, capabilities: ['employee.view_timesheet', 'employee.fill_worklog'] });
  assert.equal(hasUserManagementPermission(req), false);
});

test('Admin (rank 2) scope is unrestricted — never touches Entity/Company', async () => {
  Entity.findAll = async () => { throw new Error('must not be called for Admin'); };
  Company.findAll = async () => { throw new Error('must not be called for Admin'); };

  const where = await resolveUserAccessWhere({ userId: 12, companyId: null, hierarchyRank: 2 });
  assert.deepEqual(where, {});
  restore();
});

test('Entity Admin (rank 3) is scoped to Companies under Entities they own', async () => {
  Entity.findAll = async ({ where }) => {
    assert.equal(where.entity_admin_user_id, 50);
    return [{ id: 6 }];
  };
  Company.findAll = async ({ where }) => {
    const opIn = Object.getOwnPropertySymbols(where.entity_id)[0];
    assert.deepEqual([...where.entity_id[opIn]], [6]);
    return [{ id: 46 }];
  };

  const where = await resolveUserAccessWhere({ userId: 50, companyId: null, hierarchyRank: 3 });
  const opIn = Object.getOwnPropertySymbols(where.company_id)[0];
  assert.deepEqual([...where.company_id[opIn]], [46]);
  restore();
});

test('Entity Admin owning no Entities is denied everything, never falls back to global/company-wide', async () => {
  Entity.findAll = async () => [];
  Company.findAll = async () => { throw new Error('must not be called when no Entities are owned'); };

  const where = await resolveUserAccessWhere({ userId: 999, companyId: null, hierarchyRank: 3 });
  assert.deepEqual(where, { id: -1 });
  restore();
});

test('BU Admin (rank 4) is scoped to their own Company only', async () => {
  const where = await resolveUserAccessWhere({ userId: 120, companyId: 54, hierarchyRank: 4 });
  assert.deepEqual(where, { company_id: 54 });
});

test('HR (no hierarchy_rank) is scoped to their own Company only', async () => {
  const where = await resolveUserAccessWhere({ userId: 200, companyId: 38, hierarchyRank: null });
  assert.deepEqual(where, { company_id: 38 });
});

test('BU Admin / HR tier with no companyId is denied everything, never left unscoped', async () => {
  const where = await resolveUserAccessWhere({ userId: 1, companyId: null, hierarchyRank: 4 });
  assert.deepEqual(where, { id: -1 });
});
