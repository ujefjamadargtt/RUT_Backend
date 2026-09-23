'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOService = require('../src/services/servicePOService');
const { listServicePOsQuerySchema } = require('../src/validations/servicePOValidation');

/**
 * GET /service-pos — the Admin/Platform-Admin-only BU filter. This
 * endpoint's own convention is snake_case (client_id, service_category_id,
 * sort_by); company_ids is the primary accepted multi-select name,
 * businessUnitIds (camelCase) also works for compatibility.
 */

const ORIGINAL = { findAll: servicePORepository.findAll };
function restore() {
  servicePORepository.findAll = ORIGINAL.findAll;
}

function stubFilterCapture() {
  let capturedFilters;
  servicePORepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

const AUTH_CONTEXT = { companyId: [1, 2, 3], hierarchyRank: 2, employeeId: 1, roleNames: [] };

test('company_ids (snake_case) narrows the companyId array, dropping ids outside the caller\'s reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOService.getAll({ company_ids: '2,999' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('company_ids composes with businessUnitIds (both intersect)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await servicePOService.getAll({ businessUnitIds: '1,2', company_ids: '2,3' }, AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('listServicePOsQuerySchema: company_ids is accepted, not stripped', () => {
  const { error, value } = listServicePOsQuerySchema.validate({ company_ids: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.company_ids, '10,12');
});
