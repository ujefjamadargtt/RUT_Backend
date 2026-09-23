'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const servicePORepository = require('../src/repositories/servicePORepository');
const { Company } = require('../src/models');
const servicePOService = require('../src/services/servicePOService');
const { listServicePOsQuerySchema } = require('../src/validations/servicePOValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /service-pos.
 * companyId is resolved via resolveActorCompanyScopeForSelectedBU(), which
 * for an authContext with companyId already set (req.companyIds, always an
 * array for this route) just returns it unchanged — same shape as
 * /projects. roleNames: [] keeps resolveIndividuallyMappedServicePOIds()
 * from engaging its Project Manager/Delivery Head override path, and
 * Company.findAll -> [] keeps resolveCentralisedOwnerIds() a no-op, so
 * these tests isolate just the entityIds/businessUnitIds narrowing.
 */

const ORIGINAL = {
  findAll: servicePORepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  servicePORepository.findAll = ORIGINAL.findAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedFilters;
  servicePORepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  Company.findAll = async () => []; // resolveCentralisedOwnerIds -> no-op
  return () => capturedFilters;
}

const AUTH_CONTEXT = { companyId: [1, 2, 3], hierarchyRank: 7, employeeId: 1, roleNames: [] };

test('no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOService.getAll({}, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOService.getAll({ businessUnitIds: '2,999' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('empty businessUnitIds string behaves exactly like omitting it', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOService.getAll({ businessUnitIds: '' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('a BU-scoped actor with a single already-selected companyId (not an array) is left untouched', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOService.getAll({ businessUnitIds: '5' }, { ...AUTH_CONTEXT, companyId: 5 });
    assert.equal(getCaptured().companyId, 5);
  } finally {
    restore();
  }
});

test('listServicePOsQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = listServicePOsQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
