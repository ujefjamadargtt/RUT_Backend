'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeRepository = require('../src/repositories/employeeRepository');
const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const { Company } = require('../src/models');
const employeeService = require('../src/services/employeeService');

/**
 * Multi-Value Entity/BU Filtering — GET /employees. This endpoint has NO
 * req.companyIds/resolveReportCompanyScope at all (X-Company-Id is not a
 * filter here by design — see employeeController.buildEmployeeAuthContext's
 * doc comment); the ONLY existing BU-narrowing mechanism is the
 * ?business_unit_id= (singular) query param, composed via Op.and with
 * accessWhere inside employeeRepository.findAll(). entityIds/businessUnitIds
 * (plural) extend that SAME mechanism to accept multiple ids, rather than
 * trying to reuse the req.companyIds-intersection pattern every other
 * converted endpoint uses (which doesn't apply here at all).
 */

const ORIGINAL = {
  findAll: employeeRepository.findAll,
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  companyFindAll: Company.findAll,
};

function restore() {
  employeeRepository.findAll = ORIGINAL.findAll;
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubRepositoryCapture() {
  let capturedFilters;
  employeeRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  return () => capturedFilters;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 99, companyId: 10, hierarchyRank: 4, roleNames: [] };

test('no entityIds/businessUnitIds: filters.businessUnitId stays exactly whatever business_unit_id (legacy singular) resolved to (regression baseline)', async () => {
  const getCaptured = stubRepositoryCapture();
  try {
    await employeeService.getAll({}, AUTH_CONTEXT);
    assert.equal(getCaptured().businessUnitId, null);
  } finally {
    restore();
  }
});

test('businessUnitIds (plural) resolves to an array, superseding the legacy singular business_unit_id when both are given', async () => {
  const getCaptured = stubRepositoryCapture();
  try {
    await employeeService.getAll({ business_unit_id: '44', businessUnitIds: '10,12' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().businessUnitId, [10, 12]);
  } finally {
    restore();
  }
});

test('businessUnitIds alone (no legacy business_unit_id) resolves to an array', async () => {
  const getCaptured = stubRepositoryCapture();
  try {
    await employeeService.getAll({ businessUnitIds: '10,12,15' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().businessUnitId, [10, 12, 15]);
  } finally {
    restore();
  }
});

test('entityIds resolves to the Companies under those Entities via a real Entity->Company lookup', async () => {
  const getCaptured = stubRepositoryCapture();
  try {
    Company.findAll = async ({ where }) => {
      assert.ok(where.entity_id, 'expected an entity_id filter to be queried');
      return [{ id: 1 }, { id: 2 }];
    };
    await employeeService.getAll({ entityIds: '5,6' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().businessUnitId.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('entityIds AND businessUnitIds together: intersected (Companies under the Entities, narrowed further to the requested BU ids)', async () => {
  const getCaptured = stubRepositoryCapture();
  try {
    Company.findAll = async ({ where }) => {
      // BU-hierarchy expansion (parent_business_unit_id lookup) — no
      // Sub-BUs configured in this scenario, distinct from the entity_id
      // "Companies under this Entity" lookup below.
      if (where && where.parent_business_unit_id) return [];
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    };
    await employeeService.getAll({ entityIds: '5', businessUnitIds: '2,999' }, AUTH_CONTEXT);
    // 999 isn't under entity 5's Companies ([1,2,3]) — dropped, never an error.
    assert.deepEqual(getCaptured().businessUnitId, [2]);
  } finally {
    restore();
  }
});

test('every requested businessUnitId outside the caller\'s reach still reaches the repository as an (empty-matching) array, never an error — the accessWhere AND naturally yields zero rows', async () => {
  const getCaptured = stubRepositoryCapture();
  try {
    Company.findAll = async () => []; // no Companies under this Entity at all
    await employeeService.getAll({ entityIds: '999' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().businessUnitId, []);
  } finally {
    restore();
  }
});
