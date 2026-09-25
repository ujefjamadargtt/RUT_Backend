'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companyAccessControlService = require('../src/services/companyAccessControlService');
const resolveCompany = require('../src/middlewares/resolveCompany');

/**
 * BU Hierarchy / Sub-BU support — resolveCompany.js's X-Company-Id gate: a
 * BU Admin (hierarchy_rank 4) mapped to only ONE Sub-BU (e.g. "DAS", under
 * Parent "DATA + AI") must still be able to switch their active Business
 * Unit (X-Company-Id) to a sibling Sub-BU (e.g. "IBM") — the whole family
 * their own mapping touches — since they hold the BU Admin role for that
 * BU, not just a plain Employee's single-mapping scope. Every other
 * rank/role keeps the existing literal-mapping-only behavior.
 */

const ORIGINAL = {
  expandBusinessUnitIdsToFamily: companyAccessControlService.expandBusinessUnitIdsToFamily,
};

function restore() {
  companyAccessControlService.expandBusinessUnitIdsToFamily = ORIGINAL.expandBusinessUnitIdsToFamily;
}

function makeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('BU Admin (rank 4) mapped to only ONE Sub-BU can switch X-Company-Id to a sibling Sub-BU in the same family — THE BUG FIX', async () => {
  try {
    companyAccessControlService.expandBusinessUnitIdsToFamily = async (ids) => {
      assert.deepEqual(ids, [42]); // DAS, their one literal mapping
      return [23, 42, 43, 44]; // DATA + AI, DAS, IBM, NON IBM
    };

    const req = {
      hierarchyRank: 4,
      employeeBusinessUnits: [{ id: 42 }],
      headers: { 'x-company-id': '43' }, // switching to IBM, not individually mapped
      employeeId: 900,
    };
    const res = makeRes();
    let nextCalled = false;

    await resolveCompany(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
    assert.equal(req.companyId, 43);
  } finally {
    restore();
  }
});

test('BU Admin (rank 4) mapped to only ONE Sub-BU, no header supplied — still auto-defaults to their own single mapped BU (unchanged)', async () => {
  try {
    companyAccessControlService.expandBusinessUnitIdsToFamily = async () => {
      throw new Error('must not be called — the no-header default path never needs the expanded set');
    };

    const req = { hierarchyRank: 4, employeeBusinessUnits: [{ id: 42 }], headers: {}, employeeId: 900 };
    const res = makeRes();
    let nextCalled = false;

    await resolveCompany(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, 42);
  } finally {
    restore();
  }
});

test('BU Admin (rank 4) mapped to only ONE Sub-BU is rejected switching to a BU entirely OUTSIDE their family', async () => {
  try {
    companyAccessControlService.expandBusinessUnitIdsToFamily = async () => [23, 42, 43, 44];

    const req = {
      hierarchyRank: 4,
      employeeBusinessUnits: [{ id: 42 }],
      headers: { 'x-company-id': '999' },
      employeeId: 900,
    };
    const res = makeRes();
    let nextCalled = false;

    await resolveCompany(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'BU_NOT_MAPPED');
  } finally {
    restore();
  }
});

test('BU Admin (rank 4) mapped to MULTIPLE Business Units can switch to a family member of any of them, not just their literal mappings', async () => {
  try {
    companyAccessControlService.expandBusinessUnitIdsToFamily = async (ids) => {
      assert.deepEqual(ids.sort((a, b) => a - b), [10, 42]);
      return [10, 23, 42, 43, 44];
    };

    const req = {
      hierarchyRank: 4,
      employeeBusinessUnits: [{ id: 10 }, { id: 42 }],
      headers: { 'x-company-id': '43' },
      employeeId: 900,
    };
    const res = makeRes();
    let nextCalled = false;

    await resolveCompany(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, 43);
  } finally {
    restore();
  }
});

test('a plain Employee (rank 8) mapped to only ONE Sub-BU is REJECTED switching to a sibling Sub-BU — family widening is BU-Admin-only', async () => {
  try {
    companyAccessControlService.expandBusinessUnitIdsToFamily = async () => {
      throw new Error('must not be called for a non-BU-Admin rank');
    };

    const req = {
      hierarchyRank: 8,
      employeeBusinessUnits: [{ id: 42 }],
      headers: { 'x-company-id': '43' },
      employeeId: 901,
    };
    const res = makeRes();
    let nextCalled = false;

    await resolveCompany(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'BU_NOT_MAPPED');
  } finally {
    restore();
  }
});

test('a plain Employee (rank 8) mapped to MULTIPLE Business Units still only accepts their own literal mappings (unchanged)', async () => {
  try {
    companyAccessControlService.expandBusinessUnitIdsToFamily = async () => {
      throw new Error('must not be called for a non-BU-Admin rank');
    };

    const req = {
      hierarchyRank: 8,
      employeeBusinessUnits: [{ id: 10 }, { id: 20 }],
      headers: { 'x-company-id': '20' },
      employeeId: 901,
    };
    const res = makeRes();
    let nextCalled = false;

    await resolveCompany(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, 20);
  } finally {
    restore();
  }
});

test('0 mapped Business Units still 403s (NO_BUSINESS_UNIT), unaffected by the family widening', async () => {
  const req = { hierarchyRank: 4, employeeBusinessUnits: [], headers: {}, employeeId: 902 };
  const res = makeRes();
  let nextCalled = false;

  await resolveCompany(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'NO_BUSINESS_UNIT');
});
