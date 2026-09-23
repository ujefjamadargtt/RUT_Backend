'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const clientRepository = require('../src/repositories/clientRepository');
const { Company } = require('../src/models');
const clientService = require('../src/services/clientService');
const { listClientsQuerySchema } = require('../src/validations/clientValidation');

/**
 * Multi-Value Entity/BU Filtering batch rollout — GET /clients. Unlike
 * /projects, clientService.getAll() resolves scope via
 * resolveActorRecordAccessScope(), which can return EITHER a plain array
 * (BU-scoped actor, or a company-less actor with an explicit ?company_id)
 * OR an { ownedCompanyIds, createdBy } object (company-less actor with no
 * BU selected — surfaces their own BU-less records too). Both shapes must
 * be handled correctly by the new entityIds/businessUnitIds narrowing.
 */

const ORIGINAL = {
  findAll: clientRepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  clientRepository.findAll = ORIGINAL.findAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

function stubFilterCapture() {
  let capturedFilters;
  clientRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

// BU-scoped actor (rank 7): companyId always arrives as a plain array
// (req.companyIds), same shape as /projects.
const BU_SCOPED_AUTH_CONTEXT = { companyId: [1, 2, 3], hierarchyRank: 7, employeeId: 1, selectedCompanyId: null };

test('BU-scoped actor, no entityIds/businessUnitIds: companyId array passed through unchanged (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await clientService.getAll({}, BU_SCOPED_AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [1, 2, 3]);
  } finally {
    restore();
  }
});

test('BU-scoped actor, businessUnitIds narrows the companyId array, dropping ids outside reach', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await clientService.getAll({ businessUnitIds: '2,999' }, BU_SCOPED_AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

// Company-less actor (Admin, rank 2), no ?company_id selected: scope
// resolves to the { ownedCompanyIds, createdBy } object shape — must not
// crash, and must collapse to a plain array once businessUnitIds narrows it.
const COMPANY_LESS_AUTH_CONTEXT = { companyId: [1, 2, 3], hierarchyRank: 2, employeeId: 42, selectedCompanyId: null };

test('company-less actor, no entityIds/businessUnitIds: the { ownedCompanyIds, createdBy } object shape is left completely untouched (regression baseline)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await clientService.getAll({}, COMPANY_LESS_AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, { ownedCompanyIds: [1, 2, 3], createdBy: 42 });
  } finally {
    restore();
  }
});

test('company-less actor, businessUnitIds given: the object shape collapses to a plain narrowed array (BU-less own-records no longer surfaced, same as an explicit ?company_id already does)', async () => {
  const getCaptured = stubFilterCapture();
  try {
    await clientService.getAll({ businessUnitIds: '2,999' }, COMPANY_LESS_AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId, [2]);
  } finally {
    restore();
  }
});

test('company-less actor, entityIds given: narrows via a real Entity->Company lookup and collapses to a plain array', async () => {
  const getCaptured = stubFilterCapture();
  try {
    Company.findAll = async () => [{ id: 1 }, { id: 2 }];
    await clientService.getAll({ entityIds: '5,6' }, COMPANY_LESS_AUTH_CONTEXT);
    assert.deepEqual(getCaptured().companyId.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('listClientsQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = listClientsQuerySchema.validate({ entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});
