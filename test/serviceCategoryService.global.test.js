'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as test/serviceTypeService.global.test.js.
const serviceCategoryRepository = require('../src/repositories/serviceCategoryRepository');
const serviceCategoryService = require('../src/services/serviceCategoryService');

const ORIGINAL = {
  findAll: serviceCategoryRepository.findAll,
  findById: serviceCategoryRepository.findById,
  findByName: serviceCategoryRepository.findByName,
  findDeletedByName: serviceCategoryRepository.findDeletedByName,
  create: serviceCategoryRepository.create,
};

function restore() {
  serviceCategoryRepository.findAll = ORIGINAL.findAll;
  serviceCategoryRepository.findById = ORIGINAL.findById;
  serviceCategoryRepository.findByName = ORIGINAL.findByName;
  serviceCategoryRepository.findDeletedByName = ORIGINAL.findDeletedByName;
  serviceCategoryRepository.create = ORIGINAL.create;
}

// Category is now a single GLOBAL master (company_id IS NULL) — same
// contract as ServiceType, verified here independently.

test('getAll(): queries the repository with companyId=null regardless of the actor\'s own BU', async () => {
  let capturedFilters;
  serviceCategoryRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return [];
  };

  await serviceCategoryService.getAll({}, { companyId: 10, hierarchyRank: 5, employeeId: 1 });

  assert.equal(capturedFilters.companyId, null);
  restore();
});

test('create(): persists company_id=null even when the request body supplies one', async () => {
  serviceCategoryRepository.findByName = async () => null;
  serviceCategoryRepository.findDeletedByName = async () => null;

  let capturedPayload;
  serviceCategoryRepository.create = async (payload) => {
    capturedPayload = payload;
    return { id: 1, ...payload };
  };

  await serviceCategoryService.create(
    { name: 'Some Category', company_id: 999 },
    1,
    { companyId: 10, hierarchyRank: 5, employeeId: 1 }
  );

  assert.equal(capturedPayload.company_id, null);
  restore();
});
