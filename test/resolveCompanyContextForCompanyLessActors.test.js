'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the middleware so we can monkey-patch these SAME
// module-cached model statics — consistent with this repo's plain node:test
// setup (see test/employeeAccessControlService.test.js).
const { Entity, Company } = require('../src/models');
const middleware = require('../src/middlewares/resolveCompanyContextForCompanyLessActors');

const ORIGINAL = { entityFindAll: Entity.findAll, companyFindAll: Company.findAll };

function mockReqRes(overrides) {
  const req = {
    headers: {},
    companyId: null,
    hierarchyRank: 2,
    employeeId: 55,
    path: '/x',
    method: 'GET',
    ...overrides,
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

// Stubs resolveOwnedCompanyIds()'s underlying queries so it resolves to
// exactly `ownedCompanyIds`, regardless of hierarchyRank (2 or 3).
function stubOwnedCompanies(ownedCompanyIds) {
  Entity.findAll = async () => [{ id: 1 }];
  Company.findAll = async () => ownedCompanyIds.map((id) => ({ id }));
}

function restoreStubs() {
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

test('Case 3 (one BU): rank >= 4 with an already-resolved req.companyId is untouched (no-op)', async () => {
  const { req, res } = mockReqRes({ hierarchyRank: 4, companyId: 999 });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(req.companyId, 999);
  assert.equal(res.statusCode, null);
});

test('Platform Admin (rank 1) is exempt — companyId stays null, pre-existing behavior unchanged', async () => {
  const { req, res } = mockReqRes({ hierarchyRank: 1 });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(req.companyId, null);
});

test('Case 5 (no BU selected / none owned): Admin (rank 2) with 0 owned Companies -> 403 NO_BUSINESS_UNIT', async (t) => {
  stubOwnedCompanies([]);
  t.after(restoreStubs);

  const { req, res } = mockReqRes({ hierarchyRank: 2 });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'NO_BUSINESS_UNIT');
});

test('Case 3 (one BU): Entity Admin (rank 3) with exactly 1 owned Company is auto-selected, no header needed', async (t) => {
  stubOwnedCompanies([42]);
  t.after(restoreStubs);

  const { req, res } = mockReqRes({ hierarchyRank: 3 });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(req.companyId, 42);
});

test('Case 5 (no BU selected): Admin with multiple owned Companies and no X-Company-Id header -> 400 COMPANY_HEADER_REQUIRED', async (t) => {
  stubOwnedCompanies([1, 2, 3]);
  t.after(restoreStubs);

  const { req, res } = mockReqRes({ hierarchyRank: 2 });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'COMPANY_HEADER_REQUIRED');
});

test('Case 4 (unauthorized BU): header names a Company NOT in the owned set -> 403 BU_NOT_MAPPED, never trusted blindly', async (t) => {
  stubOwnedCompanies([1, 2, 3]);
  t.after(restoreStubs);

  const { req, res } = mockReqRes({ hierarchyRank: 2, headers: { 'x-company-id': '99' } });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BU_NOT_MAPPED');
});

test('Case 1/2 (multi-BU Admin/BU Admin-tier select): header names an owned Company -> req.companyId set to exactly that BU', async (t) => {
  stubOwnedCompanies([1, 2, 3]);
  t.after(restoreStubs);

  const { req, res } = mockReqRes({ hierarchyRank: 3, headers: { 'x-company-id': '2' } });
  let calledNext = false;
  await middleware(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(req.companyId, 2);
});
