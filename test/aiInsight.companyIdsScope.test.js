'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companyAccessControlService = require('../src/services/companyAccessControlService');
const resolveInsightCompanyScope = require('../src/middlewares/resolveInsightCompanyScope');
const { listInsightsQuerySchema } = require('../src/validations/aiInsightValidation');

/**
 * AI Insight multi-select: ?company_ids=1,2,3 — every id validated against the
 * caller's reach (403 BU_NOT_MAPPED if ANY is outside it), a Parent id pulls in
 * its Sub-BUs (still only within reach), company_ids wins over company_id and the
 * X-Company-Id header, and company_id / header keep working exactly as before.
 */

const ORIGINAL = {
  resolveReportCompanyScope: companyAccessControlService.resolveReportCompanyScope,
  expand: companyAccessControlService.expandBusinessUnitIdsWithDescendants,
};

function restore() {
  companyAccessControlService.resolveReportCompanyScope = ORIGINAL.resolveReportCompanyScope;
  companyAccessControlService.expandBusinessUnitIdsWithDescendants = ORIGINAL.expand;
}

// reach 1(parent), 2, 3 (plain BUs), 5 and 6 (Sub-BUs of 1); 7 is a Sub-BU of 1 OUTSIDE the caller's reach
function stubServices({ reach = [1, 2, 3, 5, 6], children = { 1: [5, 6, 7] }, calls = [] } = {}) {
  companyAccessControlService.resolveReportCompanyScope = async (_ctx, requestedId) => {
    calls.push(requestedId);
    return requestedId == null ? reach : reach.filter((id) => id === requestedId);
  };
  companyAccessControlService.expandBusinessUnitIdsWithDescendants = async (ids) => [
    ...new Set([...ids, ...ids.flatMap((id) => children[id] || [])]),
  ];
  return calls;
}

async function run({ query = {}, headers = {} } = {}) {
  const req = { query, headers, hierarchyRank: 4, employeeId: 10, employeeBusinessUnits: [{ id: 1 }] };
  let status;
  let body;
  let nexted = false;
  const res = { status(code) { status = code; return { json(payload) { body = payload; } }; } };
  await resolveInsightCompanyScope(req, res, () => { nexted = true; });
  return { req, status, body, nexted };
}

test('company_ids: several BUs inside the reach -> exactly those', async () => {
  try {
    stubServices();
    const { req, nexted } = await run({ query: { company_ids: '2,3' } });
    assert.equal(nexted, true);
    assert.deepEqual([...req.companyIds].sort((a, b) => a - b), [2, 3]);
  } finally {
    restore();
  }
});

test('company_ids: a Parent id includes its Sub-BUs, but only those inside the caller reach (7 is dropped)', async () => {
  try {
    stubServices();
    const { req } = await run({ query: { company_ids: '1,2' } });
    assert.deepEqual([...req.companyIds].sort((a, b) => a - b), [1, 2, 5, 6]);
    assert.equal(req.companyIds.includes(7), false);
  } finally {
    restore();
  }
});

test('company_ids: ANY id outside the reach -> 403 BU_NOT_MAPPED, request stops, nothing is silently dropped', async () => {
  try {
    stubServices();
    const { status, body, nexted, req } = await run({ query: { company_ids: '2,99' } });
    assert.equal(status, 403);
    assert.equal(body.code, 'BU_NOT_MAPPED');
    assert.equal(nexted, false);
    assert.equal(req.companyIds, undefined);

    // a Sub-BU of a reachable Parent that the caller itself does not reach is also rejected
    const second = await run({ query: { company_ids: '7' } });
    assert.equal(second.status, 403);
    assert.equal(second.body.code, 'BU_NOT_MAPPED');
  } finally {
    restore();
  }
});

test('company_ids wins over company_id and the X-Company-Id header (the global selector always sends the header)', async () => {
  try {
    const calls = stubServices();
    const { req } = await run({ query: { company_ids: '2,3', company_id: '1' }, headers: { 'x-company-id': '5' } });
    assert.deepEqual([...req.companyIds].sort((a, b) => a - b), [2, 3]);
    assert.deepEqual(calls, [null]); // only the full-reach lookup — the single id/header path was not used
  } finally {
    restore();
  }
});

test('without company_ids, company_id and the header work exactly as before (query wins over header, absent = full reach)', async () => {
  try {
    const calls = stubServices();

    await run({ query: { company_id: '2' }, headers: { 'x-company-id': '3' } });
    await run({ headers: { 'x-company-id': '3' } });
    await run({});
    await run({ query: { company_id: 'abc' }, headers: { 'x-company-id': '5' } });

    assert.deepEqual(calls, [2, 3, null, 5]);
  } finally {
    restore();
  }
});

test('blank company_ids is treated as absent', async () => {
  try {
    const calls = stubServices();
    const { req, nexted } = await run({ query: { company_ids: '  ' }, headers: { 'x-company-id': '2' } });
    assert.equal(nexted, true);
    assert.deepEqual(req.companyIds, [2]);
    assert.deepEqual(calls, [2]);
  } finally {
    restore();
  }
});

test('malformed company_ids -> 400 INVALID_COMPANY_IDS without touching the reach lookup', async () => {
  try {
    const calls = stubServices();
    for (const bad of ['1,abc', '1,,2', '0', '-3', '1.5', '2,3,', ',2', Array.from({ length: 101 }, (_, i) => i + 1).join(',')]) {
      const { status, body, nexted } = await run({ query: { company_ids: bad } });
      assert.equal(status, 400, `"${bad}"`);
      assert.equal(body.code, 'INVALID_COMPANY_IDS');
      assert.equal(nexted, false);
    }
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('duplicates and spaces in company_ids are tolerated', async () => {
  try {
    stubServices();
    const { req } = await run({ query: { company_ids: ' 2 , 3,2 ' } });
    assert.deepEqual([...req.companyIds].sort((a, b) => a - b), [2, 3]);
  } finally {
    restore();
  }
});

test('an error from the reach lookup (e.g. no BU mapped) is returned as its own 403', async () => {
  try {
    companyAccessControlService.resolveReportCompanyScope = async () => {
      const err = new Error('Access denied: no Business Unit is assigned to your account.');
      err.statusCode = 403;
      err.code = 'NO_BUSINESS_UNIT';
      throw err;
    };
    const { status, body } = await run({ query: { company_ids: '2' } });
    assert.equal(status, 403);
    assert.equal(body.code, 'NO_BUSINESS_UNIT');
  } finally {
    restore();
  }
});

test('listInsightsQuerySchema accepts company_ids (multi) and company_id, rejects a malformed list', () => {
  const ok = (query) => assert.equal(listInsightsQuerySchema.validate(query).error, undefined, JSON.stringify(query));
  const bad = (query) => assert.ok(listInsightsQuerySchema.validate(query).error, JSON.stringify(query));

  ok({ company_ids: '1,2,3' });
  ok({ company_ids: '7' });
  ok({ company_ids: '1, 2' });
  ok({ company_ids: '' });
  ok({ company_ids: '1,2', company_id: '1', page: '2', limit: '50' });
  ok({ company_id: '3' });

  bad({ company_ids: '1,abc' });
  bad({ company_ids: '0,1' });
  bad({ company_ids: '1,,2' });
  bad({ company_ids: '1,2,' });
});
