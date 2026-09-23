'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const subProjectRepository = require('../src/repositories/subProjectRepository');
const { Company } = require('../src/models');
const subProjectService = require('../src/services/subProjectService');
const { listSubProjectsQuerySchema } = require('../src/validations/subProjectValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /sub-projects. Same
 * simple pattern as /projects: companyId arrives as req.companyIds (always
 * an array for this route), no dual-shape scope resolution involved.
 */

const ORIGINAL = {
  findAll: subProjectRepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  subProjectRepository.findAll = ORIGINAL.findAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedFilters;
  subProjectRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

test('no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await subProjectService.getAll({}, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await subProjectService.getAll({ businessUnitIds: '2,999' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('empty businessUnitIds string behaves exactly like omitting it', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await subProjectService.getAll({ businessUnitIds: '' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await subProjectService.getAll({ entityIds: '5,6' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('a single already-selected companyId (not an array) is left untouched', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await subProjectService.getAll({ businessUnitIds: '5' }, 5);
    assert.equal(getCaptured().companyId, 5);
  } finally {
    restore();
  }
});

test('listSubProjectsQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = listSubProjectsQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
