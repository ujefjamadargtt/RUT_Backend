'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the middleware so we can monkey-patch its exported
// function — resolveCompany.js holds a live reference to this SAME
// module-cached object, never destructured at call time. Same pattern as
// test/employeeService.duplicateCode.test.js.
const buHeadCompanyMappingRepository = require('../src/repositories/buHeadCompanyMappingRepository');
const resolveCompany = require('../src/middlewares/resolveCompany');

const ORIGINAL = {
  exists: buHeadCompanyMappingRepository.exists,
};

function restore() {
  buHeadCompanyMappingRepository.exists = ORIGINAL.exists;
}

function fakeReq(overrides) {
  return {
    hierarchyRank: null,
    userRoleName: 'BU Head',
    userId: 500,
    user: { company_id: null },
    headers: {},
    path: '/clients',
    method: 'GET',
    ...overrides,
  };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('BU Head request with no X-Company-Id header is rejected with 400', async () => {
  let nextCalled = false;
  const res = fakeRes();
  await resolveCompany(fakeReq({ headers: {} }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'COMPANY_HEADER_REQUIRED');
});

test('BU Head request for an UNMAPPED company is rejected with 403, never reaches next()', async () => {
  buHeadCompanyMappingRepository.exists = async (userId, companyId) => {
    assert.equal(userId, 500);
    assert.equal(companyId, 99);
    return false;
  };

  let nextCalled = false;
  const res = fakeRes();
  await resolveCompany(fakeReq({ headers: { 'x-company-id': '99' } }), res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BU_NOT_MAPPED');
  restore();
});

test('BU Head request for a MAPPED company sets req.companyId and calls next()', async () => {
  buHeadCompanyMappingRepository.exists = async () => true;

  let nextCalled = false;
  const res = fakeRes();
  const req = fakeReq({ headers: { 'x-company-id': '52' } });
  await resolveCompany(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.companyId, 52);
  assert.equal(res.statusCode, null);
  restore();
});

test('Platform Admin (rank 1) still no-ops, unaffected by the new BU Head branch', async () => {
  let nextCalled = false;
  const res = fakeRes();
  await resolveCompany(
    fakeReq({ hierarchyRank: 1, userRoleName: 'Platform Admin', headers: {} }),
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('Entity Admin (rank 3) still no-ops, unaffected by the new BU Head branch', async () => {
  let nextCalled = false;
  const res = fakeRes();
  await resolveCompany(
    fakeReq({ hierarchyRank: 3, userRoleName: 'Entity Admin', headers: {} }),
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('BU Admin (single-company branch) is unaffected — resolves req.companyId from req.user.company_id, not the BU Head path', async () => {
  const previousShadow = process.env.COMPANY_SCOPE_SHADOW_MODE;
  process.env.COMPANY_SCOPE_SHADOW_MODE = 'false';

  let nextCalled = false;
  const res = fakeRes();
  const req = fakeReq({
    hierarchyRank: 4,
    userRoleName: 'BU Admin',
    user: { company_id: 52 },
    headers: { 'x-company-id': '52' },
  });
  await resolveCompany(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.companyId, 52);
  assert.equal(res.statusCode, null);

  process.env.COMPANY_SCOPE_SHADOW_MODE = previousShadow;
});
