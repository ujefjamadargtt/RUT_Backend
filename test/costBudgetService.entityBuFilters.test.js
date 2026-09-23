'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const costBudgetRepository = require('../src/repositories/costBudgetRepository');
const { Company } = require('../src/models');
const costBudgetService = require('../src/services/costBudgetService');
const { listCostBudgetQuerySchema } = require('../src/validations/costBudgetValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /cost-budgets. Same
 * middleware conversion as resource-budgets: only GET / moved to
 * authenticateReadMultiBU; every write/single-PO route stays on the plain
 * `authenticate` chain. list() reads req.companyIds directly.
 */

const ORIGINAL = {
  findAll: costBudgetRepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  costBudgetRepository.findAll = ORIGINAL.findAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedCompanyId;
  costBudgetRepository.findAll = async (filters, companyId) => {
    capturedCompanyId = companyId;
    return [];
  };
  return () => capturedCompanyId;
}

test('no entityIds/businessUnitIds: req.companyIds passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await costBudgetService.list({}, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows req.companyIds, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await costBudgetService.list({ businessUnitIds: '2,999' }, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured(), [2]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await costBudgetService.list({ entityIds: '5,6' }, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured().sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('every requested businessUnitId outside the caller\'s reach resolves to an empty scope, never an error', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await costBudgetService.list({ businessUnitIds: '888,999' }, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured(), []);
  } finally {
    restore();
  }
});

test('listCostBudgetQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = listCostBudgetQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
