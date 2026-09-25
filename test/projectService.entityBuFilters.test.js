'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const projectRepository = require('../src/repositories/projectRepository');
const { Company } = require('../src/models');
const projectService = require('../src/services/projectService');
const { listProjectsQuerySchema } = require('../src/validations/projectValidation');

/**
 * Multi-Value Entity/BU Filtering pilot — GET /projects. Mirrors the
 * production wiring: projectController.buildAuthContext() sets
 * authContext.companyId = req.companyIds (an ARRAY, from
 * resolveReportCompanyScope), always — never a plain number, for this
 * route. entityIds/businessUnitIds must narrow that array before it
 * reaches projectRepository.findAll()'s existing companyScope().
 */

const ORIGINAL = {
  findAll: projectRepository.findAll,
  countServicePOsByProjectIds: projectRepository.countServicePOsByProjectIds,
  companyFindAll: Company.findAll,
};

function restore() {
  projectRepository.findAll = ORIGINAL.findAll;
  projectRepository.countServicePOsByProjectIds = ORIGINAL.countServicePOsByProjectIds;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedFilters;
  projectRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  projectRepository.countServicePOsByProjectIds = async () => new Map();
  return () => capturedFilters;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 1, companyId: [1, 2, 3], hierarchyRank: 7, employeeBusinessUnits: [] };

test('no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await projectService.getAll({}, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await projectService.getAll({ businessUnitIds: '2,999' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('a single businessUnitId behaves identically to the equivalent multi-id case with just that one id', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await projectService.getAll({ businessUnitIds: '2' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('empty businessUnitIds string behaves exactly like omitting it', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await projectService.getAll({ businessUnitIds: '' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('every requested businessUnitId outside the caller\'s reach resolves to an empty scope, never an error', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await projectService.getAll({ businessUnitIds: '888,999' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, []);
  } finally {
    restore();
  }
});

test('entityIds narrows the companyId array via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async ({ where }) => {
      assert.ok(where.entity_id, 'expected an entity_id filter to be queried');
      return [{ id: 1 }, { id: 2 }]; // BU 3 is not under the requested entities
    };
    await projectService.getAll({ entityIds: '5,6' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('entityIds and businessUnitIds compose: entity narrowing runs first, then businessUnitIds narrows further', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async ({ where }) => {
      // BU-hierarchy expansion (parent_business_unit_id lookup) — no
      // Sub-BUs configured in this scenario, distinct from the entity_id
      // "Companies under this Entity" lookup below.
      if (where && where.parent_business_unit_id) return [];
      return [{ id: 1 }, { id: 2 }];
    };
    await projectService.getAll({ entityIds: '5', businessUnitIds: '2' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('a BU-scoped actor with a single already-selected companyId (a childless, parent-less BU) expands to just itself — nothing left to narrow', async () => {
  const getCaptured = stubFilterCapture();
  try {
    // BU Hierarchy / Sub-BU support — projectService.getAll() now expands a
    // BU-scoped actor's companyId to its Parent+Sub-BU family
    // (expandBusinessUnitIdsToFamily()), always returning an array; for a
    // company with no parent and no children that's just [companyId] — the
    // same single-BU scope as before, in array form.
    const singleBuAuthContext = { userId: 1, employeeId: 1, companyId: 5, hierarchyRank: 7, employeeBusinessUnits: [] };
    await projectService.getAll({ businessUnitIds: '5' }, singleBuAuthContext);
    assert.deepEqual(getCaptured().companyId, [5]);
  } finally {
    restore();
  }
});

test('listProjectsQuerySchema: entityIds/businessUnitIds are accepted as comma-separated strings, not stripped', () => {
  const { error, value } = listProjectsQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12,15' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12,15');
});
