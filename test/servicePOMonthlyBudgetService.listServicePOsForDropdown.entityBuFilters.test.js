'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const servicePOMonthlyBudgetRepository = require('../src/repositories/servicePOMonthlyBudgetRepository');
const { Company } = require('../src/models');
const servicePOMonthlyBudgetService = require('../src/services/servicePOMonthlyBudgetService');

/**
 * Regression test for a live-verified gap: GET /service-po-monthly-budgets
 * (listMonthlyBudgets) already honored businessUnitIds, but its sibling
 * GET /service-po-monthly-budgets/service-pos (the PO dropdown/grid) did
 * not — the controller never even passed req.query through. Fixed by
 * threading query into listServicePOsForDropdown() and applying the same
 * intersection listMonthlyBudgets already uses.
 */

const ORIGINAL = {
  findActiveServicePOsForDropdown: servicePOMonthlyBudgetRepository.findActiveServicePOsForDropdown,
  companyFindAll: Company.findAll,
};

function restore() {
  servicePOMonthlyBudgetRepository.findActiveServicePOsForDropdown = ORIGINAL.findActiveServicePOsForDropdown;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedCompanyId;
  servicePOMonthlyBudgetRepository.findActiveServicePOsForDropdown = async (companyId) => {
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
    await servicePOMonthlyBudgetService.listServicePOsForDropdown({}, [1, 2, 3], 99, ROLE, 99);
    assert.deepEqual(getCaptured(), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('businessUnitIds narrows the companyId array, dropping ids outside the caller\'s own reach — the bug fix', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOMonthlyBudgetService.listServicePOsForDropdown({ businessUnitIds: '2,999' }, [1, 2, 3], 99, ROLE, 99);
    assert.deepEqual(getCaptured(), [2]);
  } finally {
    restore();
  }
});

test('entityIds narrows via a real Entity->Company lookup', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await servicePOMonthlyBudgetService.listServicePOsForDropdown({ entityIds: '5,6' }, [1, 2, 3], 99, ROLE, 99);
    assert.deepEqual(getCaptured().sort(), [1, 2]);
  } finally {
    restore();
  }
});
