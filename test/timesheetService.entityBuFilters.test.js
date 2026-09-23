'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timesheetRepository = require('../src/repositories/timesheetRepository');
const { Company } = require('../src/models');
const timesheetService = require('../src/services/timesheetService');
const { listTimesheetsQuerySchema } = require('../src/validations/timesheetValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /timesheets (the
 * admin Timesheet Master list). This route was converted from the plain
 * single-BU `authenticate` chain to `authenticateReadMultiBU` as part of
 * this change (see timesheet.routes.js) — a multi-BU actor who previously
 * HAD to select exactly one BU via X-Company-Id can now omit it and reach
 * every BU they're mapped to, same "no header -> role reach" contract as
 * every other converted List/Master endpoint.
 */

const ORIGINAL = {
  findAll: timesheetRepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  timesheetRepository.findAll = ORIGINAL.findAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedFilters;
  timesheetRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

test('no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getAllTimesheets({}, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getAllTimesheets({ businessUnitIds: '2,999' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('empty businessUnitIds string behaves exactly like omitting it', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getAllTimesheets({ businessUnitIds: '' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await timesheetService.getAllTimesheets({ entityIds: '5,6' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('every requested businessUnitId outside the caller\'s reach resolves to an empty scope, never an error', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getAllTimesheets({ businessUnitIds: '888,999' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().companyId, []);
  } finally {
    restore();
  }
});

test('listTimesheetsQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = listTimesheetsQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
