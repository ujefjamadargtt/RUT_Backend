'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companyAccessControlService = require('../src/services/companyAccessControlService');
const resolveFullReachCompanyScope = require('../src/middlewares/resolveFullReachCompanyScope');

const ORIGINAL = companyAccessControlService.resolveReportCompanyScope;
const restore = () => { companyAccessControlService.resolveReportCompanyScope = ORIGINAL; };

/**
 * GET /timesheets/import/:id (and /rows) must resolve against the caller's FULL reach — the same set
 * the multi-BU import history lists from — and never against the single BU in X-Company-Id.
 */
test('uses the full role reach and ignores X-Company-Id / ?company_id', async () => {
  let seen;
  companyAccessControlService.resolveReportCompanyScope = async (actor, requested) => { seen = { actor, requested }; return [10, 11, 12]; };
  const req = {
    headers: { 'x-company-id': '10' },
    query: { company_id: '11' },
    hierarchyRank: 4,
    employeeId: 7,
    employeeBusinessUnits: [{ id: 10 }, { id: 11 }, { id: 12 }],
  };
  let nextCalled = false;
  await resolveFullReachCompanyScope(req, {}, () => { nextCalled = true; });
  restore();

  assert.equal(nextCalled, true);
  assert.deepEqual(req.companyIds, [10, 11, 12]);
  assert.equal(seen.requested, null, 'the header / query BU must not narrow the scope');
  assert.equal(seen.actor.employeeId, 7);
  assert.equal(seen.actor.hierarchyRank, 4);
});

test('an actor with no reach gets an empty array (the lookup then 404s), never undefined', async () => {
  companyAccessControlService.resolveReportCompanyScope = async () => [];
  const req = { headers: {}, query: {}, hierarchyRank: 4, employeeId: 7, employeeBusinessUnits: [] };
  await resolveFullReachCompanyScope(req, {}, () => {});
  restore();
  assert.deepEqual(req.companyIds, []);
});

test('a scope error with a statusCode is answered as JSON, not thrown', async () => {
  companyAccessControlService.resolveReportCompanyScope = async () => {
    const err = new Error('No BU'); err.statusCode = 403; err.code = 'NO_BUSINESS_UNIT'; throw err;
  };
  let out;
  const res = { status(code) { out = { code }; return this; }, json(body) { out.body = body; return this; } };
  await resolveFullReachCompanyScope({ headers: {}, query: {}, hierarchyRank: 4, employeeId: 7 }, res, () => { throw new Error('next must not run'); });
  restore();
  assert.equal(out.code, 403);
  assert.equal(out.body.code, 'NO_BUSINESS_UNIT');
});
