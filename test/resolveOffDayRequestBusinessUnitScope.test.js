'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companyAccessControlService = require('../src/services/companyAccessControlService');
const resolveOffDayRequestBusinessUnitScope = require('../src/middlewares/resolveOffDayRequestBusinessUnitScope');

// Regression test for a real bug report: an Admin (cross-BU, hierarchy_rank
// 2) called GET /my-team/off-day-requests with six different real
// X-Company-Id headers (plus once with none) and got the identical 6 rows
// every time. Root cause: resolveCompany.js (the default authenticate()
// chain) returns early for hierarchy_rank <= 3 WITHOUT ever reading
// X-Company-Id, so req.companyId stayed permanently undefined for that tier
// no matter what header was sent — offDayWorkRequestService.listPendingQueue
// pushes companyId straight into its WHERE clause, so "undefined" meant
// "every Business Unit's requests, always."

const originalResolveReportCompanyScope = companyAccessControlService.resolveReportCompanyScope;

function restore() {
  companyAccessControlService.resolveReportCompanyScope = originalResolveReportCompanyScope;
}

function makeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('a BU-scoped actor (rank >= 4) whose req.companyId is already set by resolveCompany is left completely untouched', async () => {
  try {
    companyAccessControlService.resolveReportCompanyScope = async () => {
      throw new Error('must not be called — resolveCompany already resolved this actor\'s companyId');
    };
    const req = { hierarchyRank: 4, companyId: 41, headers: { 'x-company-id': '99' } };
    const res = makeRes();
    let nextCalled = false;

    await resolveOffDayRequestBusinessUnitScope(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, 41);
  } finally {
    restore();
  }
});

test('a cross-BU actor (Admin, rank 2) with NO X-Company-Id header keeps req.companyId undefined (unscoped default), never calling resolveReportCompanyScope', async () => {
  try {
    companyAccessControlService.resolveReportCompanyScope = async () => {
      throw new Error('must not be called when no header is present');
    };
    const req = { hierarchyRank: 2, employeeId: 7, employeeBusinessUnits: [], headers: {} };
    const res = makeRes();
    let nextCalled = false;

    await resolveOffDayRequestBusinessUnitScope(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, undefined);
  } finally {
    restore();
  }
});

test('a cross-BU actor (Admin, rank 2) WITH a valid X-Company-Id header — THE BUG FIX — narrows req.companyId to that exact Business Unit', async () => {
  try {
    let calledWith = null;
    companyAccessControlService.resolveReportCompanyScope = async (authContext, requestedCompanyId) => {
      calledWith = { authContext, requestedCompanyId };
      return [requestedCompanyId];
    };
    const req = { hierarchyRank: 2, employeeId: 7, employeeBusinessUnits: [], headers: { 'x-company-id': '30' } };
    const res = makeRes();
    let nextCalled = false;

    await resolveOffDayRequestBusinessUnitScope(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, 30);
    assert.equal(calledWith.requestedCompanyId, 30);
    assert.equal(calledWith.authContext.hierarchyRank, 2);
    assert.equal(calledWith.authContext.employeeId, 7);
  } finally {
    restore();
  }
});

test('a Platform Admin (rank 1) WITH a valid X-Company-Id header also gets req.companyId narrowed', async () => {
  try {
    companyAccessControlService.resolveReportCompanyScope = async (_authContext, requestedCompanyId) => [requestedCompanyId];
    const req = { hierarchyRank: 1, employeeId: 1, employeeBusinessUnits: [], headers: { 'x-company-id': '24' } };
    const res = makeRes();
    let nextCalled = false;

    await resolveOffDayRequestBusinessUnitScope(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.companyId, 24);
  } finally {
    restore();
  }
});

test('an invalid (non-numeric) X-Company-Id header is rejected with 400 before ever calling resolveReportCompanyScope', async () => {
  try {
    companyAccessControlService.resolveReportCompanyScope = async () => {
      throw new Error('must not be called for a malformed header');
    };
    const req = { hierarchyRank: 2, employeeId: 7, employeeBusinessUnits: [], headers: { 'x-company-id': 'abc' } };
    const res = makeRes();
    let nextCalled = false;

    await resolveOffDayRequestBusinessUnitScope(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_COMPANY_HEADER');
  } finally {
    restore();
  }
});

test('a Business Unit outside the cross-BU actor\'s own reach is rejected with the 403 resolveReportCompanyScope raises', async () => {
  try {
    companyAccessControlService.resolveReportCompanyScope = async () => {
      const err = new Error('Access denied: the selected Business Unit is not assigned to your account.');
      err.statusCode = 403;
      err.code = 'BU_NOT_MAPPED';
      throw err;
    };
    const req = { hierarchyRank: 3, employeeId: 9, employeeBusinessUnits: [], headers: { 'x-company-id': '999' } };
    const res = makeRes();
    let nextCalled = false;

    await resolveOffDayRequestBusinessUnitScope(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'BU_NOT_MAPPED');
  } finally {
    restore();
  }
});
