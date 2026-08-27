'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the "Search Service PO..." dropdown bug: switching
// the frontend's Global Business Unit selector had no effect for a
// company-less actor (Admin/Entity Admin) because GET /service-pos never
// read the X-Company-Id header — see servicePOService.getAll()'s doc
// comment. Same monkey-patch style as test/companyAccessControlService.
// resolveActorCompanyScopeForSelectedBU.test.js (Entity/Company model
// stubbing) plus test/servicePOService.centralisedPO.test.js (repository
// stubbing) — no real DB.
const { Entity, Company } = require('../src/models');
const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  entityFindAll: Entity.findAll,
  companyFindAll: Company.findAll,
  findAll: servicePORepository.findAll,
};

function restore() {
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  servicePORepository.findAll = ORIGINAL.findAll;
}

function stubOwnedCompanies(ids) {
  Entity.findAll = async () => [{ id: 6 }];
  Company.findAll = async () => ids.map((id) => ({ id }));
}

function stubRepositoryCapture() {
  let capturedFilters;
  servicePORepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  return () => capturedFilters;
}

test('getAll(): a BU-scoped actor is filtered by their own plain companyId, ignoring any X-Company-Id header (unaffected by this fix)', async () => {
  const getCaptured = stubRepositoryCapture();

  await servicePOService.getAll({}, { companyId: 10, hierarchyRank: 4, employeeId: 900 }, 999 /* header ignored */);

  assert.equal(getCaptured().companyId, 10);
  restore();
});

test('getAll(): a company-less Admin with NO Business Unit selected still sees every owned Company\'s POs (existing behavior unchanged)', async () => {
  stubOwnedCompanies([46, 47]);
  const getCaptured = stubRepositoryCapture();

  await servicePOService.getAll({}, { companyId: null, hierarchyRank: 2, employeeId: 1 }, null);

  assert.deepEqual(getCaptured().companyId, [46, 47]);
  restore();
});

test('getAll(): a company-less Admin with a Business Unit SELECTED (X-Company-Id header) narrows to just that ONE BU — the bug fix', async () => {
  stubOwnedCompanies([46, 47]);
  const getCaptured = stubRepositoryCapture();

  await servicePOService.getAll({}, { companyId: null, hierarchyRank: 2, employeeId: 1 }, 47);

  assert.deepEqual(getCaptured().companyId, [47]);
  restore();
});

test('getAll(): switching the selected Business Unit changes the resolved company scope between calls (the exact reported symptom, now fixed)', async () => {
  stubOwnedCompanies([46, 47]);
  const getCaptured = stubRepositoryCapture();
  const authContext = { companyId: null, hierarchyRank: 2, employeeId: 1 };

  await servicePOService.getAll({}, authContext, 46);
  const firstScope = getCaptured().companyId;

  await servicePOService.getAll({}, authContext, 47);
  const secondScope = getCaptured().companyId;

  assert.deepEqual(firstScope, [46]);
  assert.deepEqual(secondScope, [47]);
  assert.notDeepEqual(firstScope, secondScope);
  restore();
});

test('getAll(): a header naming a Company the Admin does NOT own is rejected with 403, never silently ignored or widened back to the full set', async () => {
  stubOwnedCompanies([46, 47]);
  stubRepositoryCapture();

  await assert.rejects(
    () => servicePOService.getAll({}, { companyId: null, hierarchyRank: 2, employeeId: 1 }, 999),
    (err) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
  restore();
});
