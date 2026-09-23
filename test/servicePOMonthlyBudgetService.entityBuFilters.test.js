'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const servicePOMonthlyBudgetRepository = require('../src/repositories/servicePOMonthlyBudgetRepository');
const { Company } = require('../src/models');
const servicePOMonthlyBudgetService = require('../src/services/servicePOMonthlyBudgetService');
const { getServicePOMonthlyBudgetQuerySchema } = require('../src/validations/servicePOMonthlyBudgetValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /service-po-monthly-budgets.
 * Same simple pattern as /projects: companyId arrives as req.companyIds
 * (always an array for this route).
 */

const ORIGINAL = {
  findBudgetsForMonth: servicePOMonthlyBudgetRepository.findBudgetsForMonth,
  companyFindAll: Company.findAll,
};

function restore() {
  servicePOMonthlyBudgetRepository.findBudgetsForMonth = ORIGINAL.findBudgetsForMonth;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedCompanyId;
  servicePOMonthlyBudgetRepository.findBudgetsForMonth = async (month, year, companyId) => {
    capturedCompanyId = companyId;
    return [];
  };
  return () => capturedCompanyId;
}

// roleName 'Project Manager' (not 'Team Lead') short-circuits
// getAllowedServicePOIds() to null without any DB calls of its own.
const ROLE = 'Project Manager';

test('no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOMonthlyBudgetService.listMonthlyBudgets({ year: 2026 }, [1, 2, 3], 99, ROLE, 99);
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOMonthlyBudgetService.listMonthlyBudgets({ year: 2026, businessUnitIds: '2,999' }, [1, 2, 3], 99, ROLE, 99);
    assert.deepEqual(getCaptured(), [2]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await servicePOMonthlyBudgetService.listMonthlyBudgets({ year: 2026, entityIds: '5,6' }, [1, 2, 3], 99, ROLE, 99);
    assert.deepEqual(getCaptured().sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('getServicePOMonthlyBudgetQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = getServicePOMonthlyBudgetQuerySchema.validate({ year: 2026, entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
