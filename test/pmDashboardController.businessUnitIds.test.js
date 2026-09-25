'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// PM Dashboard multi-BU filter: `businessUnitIds` (+ `buId=all`) must scope
// every endpoint to the selected BUs (each incl. its Sub-BUs), ignoring the
// X-Company-Id header's single-BU narrowing; absent -> req.companyIds as-is.
// Same monkey-patch style as the other tests — the controller calls these
// through the module objects at request time.
const pmDashboardService = require('../src/services/pmDashboardService');
const companyAccessControlService = require('../src/services/companyAccessControlService');

const ORIGINAL = {
  getSummary: pmDashboardService.getSummary,
  resolveActorFullReach: companyAccessControlService.resolveActorFullReach,
  intersectIdsWithBuHierarchy: companyAccessControlService.intersectIdsWithBuHierarchy,
};

function restore() {
  pmDashboardService.getSummary = ORIGINAL.getSummary;
  companyAccessControlService.resolveActorFullReach = ORIGINAL.resolveActorFullReach;
  companyAccessControlService.intersectIdsWithBuHierarchy = ORIGINAL.intersectIdsWithBuHierarchy;
}

// Controller is required AFTER the service stub is installed per test via
// a fresh require of the handler factory output — getSummary is captured at
// module load, so stub the service before loading the controller.
function loadController() {
  delete require.cache[require.resolve('../src/controllers/pmDashboardController')];
  return require('../src/controllers/pmDashboardController');
}

// Actor reach: BUs 23 (Parent of 42, 43) and 24 — mirrors the real
// helpers' contract (requested Parent ids expand to their Sub-BUs, then
// intersect with reach; empty request = whole reach).
function stubReach() {
  companyAccessControlService.resolveActorFullReach = async () => [23, 24, 42, 43];
  companyAccessControlService.intersectIdsWithBuHierarchy = async (reach, requested) => {
    if (!requested || requested.length === 0) return reach;
    const expanded = new Set(requested.flatMap((id) => (id === 23 ? [23, 42, 43] : [id])));
    return reach.filter((id) => expanded.has(id));
  };
}

function fakeReq(query) {
  return {
    query,
    companyIds: [42], // what resolveReportCompanyScope set from X-Company-Id: 42
    hierarchyRank: 6,
    employeeId: 9,
    employeeBusinessUnits: [{ id: 23 }, { id: 24 }],
    userRoles: ['Project Manager'],
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function run(query) {
  let captured;
  pmDashboardService.getSummary = async (q, auth, companyIds) => {
    captured = companyIds;
    return {};
  };
  const controller = loadController();
  const res = fakeRes();
  await controller.getSummary(fakeReq(query), res, (err) => { throw err; });
  return { captured, res };
}

test('no businessUnitIds / buId: uses req.companyIds unchanged (header-scoped, existing behaviour)', async () => {
  stubReach();
  try {
    const { captured } = await run({ month: '9', year: '2026' });
    assert.deepEqual(captured, [42]);
  } finally {
    restore();
  }
});

test('businessUnitIds=24,42 ignores the header BU and scopes to exactly the selected BUs', async () => {
  stubReach();
  try {
    const { captured } = await run({ buId: 'all', businessUnitIds: '24,42' });
    assert.deepEqual(captured.slice().sort((a, b) => a - b), [24, 42]);
  } finally {
    restore();
  }
});

test('businessUnitIds naming a Parent BU includes its Sub-BUs', async () => {
  stubReach();
  try {
    const { captured } = await run({ buId: 'all', businessUnitIds: '23' });
    assert.deepEqual(captured.slice().sort((a, b) => a - b), [23, 42, 43]);
  } finally {
    restore();
  }
});

test('buId=all alone: the caller\'s full reach, not just the header BU', async () => {
  stubReach();
  try {
    const { captured } = await run({ buId: 'all' });
    assert.deepEqual(captured.slice().sort((a, b) => a - b), [23, 24, 42, 43]);
  } finally {
    restore();
  }
});

test('businessUnitIds entirely outside the caller\'s reach -> 403, never widened', async () => {
  stubReach();
  try {
    const { captured, res } = await run({ buId: 'all', businessUnitIds: '999' });
    assert.equal(captured, undefined);
    assert.equal(res.statusCode, 403);
  } finally {
    restore();
  }
});
