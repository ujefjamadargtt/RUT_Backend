'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/categoryService.test.js: mutate the
// module-cached repository object serviceTypeService.js holds a live
// reference to, no mocking library needed.
const serviceTypeRepository = require('../src/repositories/serviceTypeRepository');
const serviceTypeService = require('../src/services/serviceTypeService');

const ORIGINAL = {
  findAll: serviceTypeRepository.findAll,
  findById: serviceTypeRepository.findById,
  findByName: serviceTypeRepository.findByName,
  findDeletedByName: serviceTypeRepository.findDeletedByName,
  create: serviceTypeRepository.create,
};

function restore() {
  serviceTypeRepository.findAll = ORIGINAL.findAll;
  serviceTypeRepository.findById = ORIGINAL.findById;
  serviceTypeRepository.findByName = ORIGINAL.findByName;
  serviceTypeRepository.findDeletedByName = ORIGINAL.findDeletedByName;
  serviceTypeRepository.create = ORIGINAL.create;
}

// Type is now a single GLOBAL master (company_id IS NULL) — every actor,
// regardless of which BU they belong to (or whether they belong to one at
// all), must see and manage the SAME set. These tests assert the service
// never scopes by the actor's companyId any more, for a BU-scoped actor AND
// a company-less actor alike.

test('getAll(): queries the repository with companyId=null even for a BU-scoped actor', async () => {
  let capturedFilters;
  serviceTypeRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return [];
  };

  await serviceTypeService.getAll({}, { companyId: 10, hierarchyRank: 5, employeeId: 1 });

  assert.equal(capturedFilters.companyId, null);
  restore();
});

test('getAll(): queries the repository with companyId=null for a company-less actor (Admin) too', async () => {
  let capturedFilters;
  serviceTypeRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return [];
  };

  await serviceTypeService.getAll({}, { companyId: undefined, hierarchyRank: 2, employeeId: 1 });

  assert.equal(capturedFilters.companyId, null);
  restore();
});

test('create(): persists company_id=null regardless of the actor\'s own BU or any body-supplied company_id', async () => {
  serviceTypeRepository.findByName = async () => null;
  serviceTypeRepository.findDeletedByName = async () => null;

  let capturedPayload;
  serviceTypeRepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };

  await serviceTypeService.create(
    { service_type_name: 'Some Type', company_id: 999 },
    1,
    { companyId: 10, hierarchyRank: 5, employeeId: 1 }
  );

  assert.equal(capturedPayload.company_id, null);
  restore();
});

test('getById()/update()/delete() all resolve against company_id=null, not the actor\'s BU', async () => {
  let lookupCompanyId;
  serviceTypeRepository.findById = async (id, companyId) => {
    lookupCompanyId = companyId;
    return { id, service_type_name: 'X', company_id: null };
  };

  await serviceTypeService.getById(1, { companyId: 10, hierarchyRank: 5, employeeId: 1 });
  assert.equal(lookupCompanyId, null);

  restore();
});
