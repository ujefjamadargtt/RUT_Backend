'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the Employee Master list filter bug: the
// "Business Unit" dropdown on the filter bar had no backend support at
// all — GET /employees never read a business_unit_id param, so selecting a
// BU there had zero effect regardless of role. Same monkey-patch style as
// test/employeeService.duplicateCode.test.js — employeeService.js holds a
// live reference to these SAME module-cached objects.
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const employeeService = require('../src/services/employeeService');

const ORIGINAL = {
  findAll: employeeRepository.findAll,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
};

function restore() {
  employeeRepository.findAll = ORIGINAL.findAll;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
}

function stubRepositoryCapture() {
  let capturedFilters;
  employeeRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };

test('getAll(): no business_unit_id in the query -> filters.businessUnitId is null (existing behavior unchanged)', async () => {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({}, AUTH_CONTEXT);

  assert.equal(getCaptured().businessUnitId, null);
  restore();
});

test('getAll(): a valid business_unit_id in the query is parsed and threaded through to the repository as filters.businessUnitId — the bug fix', async () => {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({ business_unit_id: '44' }, AUTH_CONTEXT);

  assert.equal(getCaptured().businessUnitId, 44);
  restore();
});

test('getAll(): switching business_unit_id between calls changes the resolved filter (the exact reported symptom, now fixed)', async () => {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({ business_unit_id: '10' }, AUTH_CONTEXT);
  const first = getCaptured().businessUnitId;

  await employeeService.getAll({ business_unit_id: '44' }, AUTH_CONTEXT);
  const second = getCaptured().businessUnitId;

  assert.equal(first, 10);
  assert.equal(second, 44);
  assert.notEqual(first, second);
  restore();
});

test('getAll(): a non-numeric business_unit_id is ignored (no filter applied), never throws', async () => {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({ business_unit_id: 'not-a-number' }, AUTH_CONTEXT);

  assert.equal(getCaptured().businessUnitId, null);
  restore();
});

test('getAll(): business_unit_id=0 is ignored (no valid Business Unit has id 0), never filters to nothing by accident', async () => {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  const getCaptured = stubRepositoryCapture();

  await employeeService.getAll({ business_unit_id: '0' }, AUTH_CONTEXT);

  assert.equal(getCaptured().businessUnitId, null);
  restore();
});
