'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const requirePlatformAdmin = require('../src/middlewares/requirePlatformAdmin');

// Role -> hierarchy_rank, per database/migrations/20260836_seed_target_roles_and_capabilities.sql
// (1 Platform Admin, 2 Admin, 3 Entity Admin, 4 BU Admin, 5 Project Admin,
// 6 Service PO Admin, 7 Manager, 8 Employee; HR has no numeric rank).
const RANKS = {
  'Platform Admin': 1,
  Admin: 2,
  'Entity Admin': 3,
  'BU Admin': 4,
  'Project Admin': 5,
  'Service PO Admin': 6,
  Manager: 7,
  Employee: 8,
  HR: null,
};

function fakeReq(hierarchyRank) {
  return { user: { id: 1 }, userId: 1, hierarchyRank, path: '/organization-overview', method: 'GET' };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('Platform Admin (rank 1) passes through to next()', () => {
  let nextCalled = false;
  const res = fakeRes();
  requirePlatformAdmin(fakeReq(RANKS['Platform Admin']), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

for (const [roleName, rank] of Object.entries(RANKS)) {
  if (roleName === 'Platform Admin') continue;
  test(`${roleName} (rank ${rank}) is denied with 403 PLATFORM_ADMIN_REQUIRED`, () => {
    let nextCalled = false;
    const res = fakeRes();
    requirePlatformAdmin(fakeReq(rank), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'PLATFORM_ADMIN_REQUIRED');
  });
}

test('Unauthenticated (no req.user) is denied with 403, never reaches next()', () => {
  let nextCalled = false;
  const res = fakeRes();
  requirePlatformAdmin({ hierarchyRank: undefined }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
