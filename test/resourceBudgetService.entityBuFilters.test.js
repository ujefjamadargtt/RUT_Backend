'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const resourceBudgetRepository = require('../src/repositories/resourceBudgetRepository');
const { Company } = require('../src/models');
const resourceBudgetService = require('../src/services/resourceBudgetService');
const { listResourceBudgetQuerySchema } = require('../src/validations/resourceBudgetValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /resource-budgets.
 * This route was converted from the plain single-BU `authenticate` chain to
 * `authenticateReadMultiBU` (see resourceBudget.routes.js) — every other
 * route in that file (create/update/delete/single-PO reads) stays on the
 * old single-companyId chain, since a write always needs exactly one
 * target BU. list() now reads req.companyIds directly, never resolveScope()/
 * req.companyId (which is unset for this specific route now).
 */

const ORIGINAL = {
  findAll: resourceBudgetRepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  resourceBudgetRepository.findAll = ORIGINAL.findAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedCompanyId;
  resourceBudgetRepository.findAll = async (filters, companyId) => {
    capturedCompanyId = companyId;
    return [];
  };
  return () => capturedCompanyId;
}

test('no entityIds/businessUnitIds: req.companyIds passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await resourceBudgetService.list({}, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows req.companyIds, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await resourceBudgetService.list({ businessUnitIds: '2,999' }, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured(), [2]);
  } finally {
    restore();
  }
});

test('empty businessUnitIds string behaves exactly like omitting it', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await resourceBudgetService.list({ businessUnitIds: '' }, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await resourceBudgetService.list({ entityIds: '5,6' }, { companyIds: [1, 2, 3] });
    assert.deepEqual(getCaptured().sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('listResourceBudgetQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = listResourceBudgetQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
