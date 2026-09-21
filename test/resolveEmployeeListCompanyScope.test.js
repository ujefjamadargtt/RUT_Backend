'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const resolveEmployeeListCompanyScope = require('../src/middlewares/resolveEmployeeListCompanyScope');

// Regression test for a real bug report: GET /employees (Employee Master)
// crashed for a BU Admin mapped to more than one Business Unit with
// "WHERE parameter \"company_id\" has invalid \"undefined\" value" — the
// screen never sends X-Company-Id (see employee.routes.js's GET / doc
// comment: "X-Company-Id is not read as a filter here"), but resolveCompany
// .js (the default authenticate() chain's tail) requires that header for
// ANY multi-BU caller and would 400 (COMPANY_HEADER_REQUIRED) before the
// request ever reaches the controller. This middleware relaxes exactly that
// one case for the "company-wide" tier (BU Admin/Project Admin/BU-Admin-peer
// roles), leaving req.companyId unset so
// employeeAccessControlService.resolveEmployeeAccessWhere falls back to
// req.employeeBusinessUnits instead.

function makeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('BU Admin (rank 4) mapped to MULTIPLE Business Units with NO X-Company-Id header — THE BUG FIX — is let through with req.companyId left unset', async () => {
  const req = {
    hierarchyRank: 4,
    userRoles: ['BU Admin'],
    employeeBusinessUnits: [{ id: 10 }, { id: 20 }],
    headers: {},
  };
  const res = makeRes();
  let nextCalled = false;

  await resolveEmployeeListCompanyScope(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(req.companyId, undefined);
});

test('a BU-Admin-peer role (HR, null hierarchy_rank) mapped to multiple Business Units with no header is also let through', async () => {
  const req = {
    hierarchyRank: null,
    userRoles: ['HR'],
    employeeBusinessUnits: [{ id: 10 }, { id: 20 }, { id: 30 }],
    headers: {},
  };
  const res = makeRes();
  let nextCalled = false;

  await resolveEmployeeListCompanyScope(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.companyId, undefined);
});

test('a Project Manager (rank 6, NOT a BU-Admin-peer role) mapped to multiple Business Units with no header still gets the strict COMPANY_HEADER_REQUIRED 400 (unchanged behavior)', async () => {
  const req = {
    hierarchyRank: 6,
    userRoles: ['Project Manager'],
    employeeBusinessUnits: [{ id: 10 }, { id: 20 }],
    headers: {},
  };
  const res = makeRes();
  let nextCalled = false;

  await resolveEmployeeListCompanyScope(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'COMPANY_HEADER_REQUIRED');
});

test('BU Admin mapped to a SINGLE Business Unit with no header keeps the existing auto-select behavior (req.companyId set, unchanged)', async () => {
  const req = {
    hierarchyRank: 4,
    userRoles: ['BU Admin'],
    employeeBusinessUnits: [{ id: 10 }],
    headers: {},
  };
  const res = makeRes();
  let nextCalled = false;

  await resolveEmployeeListCompanyScope(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.companyId, 10);
});

test('BU Admin mapped to multiple Business Units WITH a valid X-Company-Id header still narrows to that exact Business Unit (unchanged behavior)', async () => {
  const req = {
    hierarchyRank: 4,
    userRoles: ['BU Admin'],
    employeeBusinessUnits: [{ id: 10 }, { id: 20 }],
    headers: { 'x-company-id': '20' },
  };
  const res = makeRes();
  let nextCalled = false;

  await resolveEmployeeListCompanyScope(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.companyId, 20);
});

test('Admin (rank 2, cross-BU/company-less) is unaffected — resolveCompany already skips company resolution for ranks 1-3', async () => {
  const req = {
    hierarchyRank: 2,
    userRoles: ['Admin'],
    employeeBusinessUnits: [],
    headers: {},
  };
  const res = makeRes();
  let nextCalled = false;

  await resolveEmployeeListCompanyScope(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.companyId, undefined);
});
