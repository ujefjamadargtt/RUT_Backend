'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timesheetImportRepository = require('../src/repositories/timesheetImportRepository');
const { Company } = require('../src/models');
const timesheetService = require('../src/services/timesheetService');

/**
 * Regression test for a live-verified gap: GET /timesheets/import/history —
 * the actual endpoint the Timesheets screen calls — accepted entityIds/
 * businessUnitIds without error but never applied them (total was identical
 * with or without the filter). getImportHistory() never read query.entityIds/
 * query.businessUnitIds at all. Fixed by applying the same intersection
 * every other converted List/Master endpoint uses.
 */

const ORIGINAL = {
  findAllImports: timesheetImportRepository.findAllImports,
  getEmployeeCountsByImportIds: timesheetImportRepository.getEmployeeCountsByImportIds,
  companyFindAll: Company.findAll,
};

function restore() {
  timesheetImportRepository.findAllImports = ORIGINAL.findAllImports;
  timesheetImportRepository.getEmployeeCountsByImportIds = ORIGINAL.getEmployeeCountsByImportIds;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedCompanyId;
  timesheetImportRepository.findAllImports = async (pagination, filters) => {
    capturedCompanyId = filters.companyId;
    return { rows: [], count: 0 };
  };
  timesheetImportRepository.getEmployeeCountsByImportIds = async () => new Map();
  return () => capturedCompanyId;
}

test('no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getImportHistory({}, [1, 2, 3]);
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach — the bug fix', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getImportHistory({ businessUnitIds: '2,999' }, [1, 2, 3]);
    assert.deepEqual(getCaptured(), [2]);
  } finally {
    restore();
  }
});

test('empty businessUnitIds string behaves exactly like omitting it', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await timesheetService.getImportHistory({ businessUnitIds: '' }, [1, 2, 3]);
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await timesheetService.getImportHistory({ entityIds: '5,6' }, [1, 2, 3]);
    assert.deepEqual(getCaptured().sort(), [1, 2]);
  } finally {
    restore();
  }
});
